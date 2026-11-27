import { ToolFailure } from '../contracts/errors.js';
import type { ConsentAnswer, ConsentRunner } from './consent.js';
import { isControlPolicy, requiresControl, type ControlPolicy } from './control-policy.js';

/**
 * 桌面控制门控运行时
 *
 * 职责边界（照 Google CursorTouch 的定位，刻意写清）：
 * - 门控是**协调**，不是安全边界。用户随时可以夺回鼠标键盘，我们不保证独占。
 * - 租约按"控制周期"计：一次同意持续到用户夺回或租约空闲超时，之后重新征求同意。
 * - 用户夺回判定是 best-effort：靠 GetLastInputInfo 的空闲时间与"我方最后一次输入时间"比对。
 */

export interface ForegroundWindowInfo {
  handle: number;
  title: string;
  processId: number;
}

export interface DesktopControlState {
  policy: ControlPolicy;
  idleMs: number;
  interactive: boolean;
  foreground: ForegroundWindowInfo | null;
  cursor?: { x: number; y: number };
}

/** 门控读取/写入系统状态的最小接口（测试可注入，不必起桥） */
export interface ControlIo {
  readState(): Promise<DesktopControlState>;
  writePolicy(policy: ControlPolicy): Promise<{ previous: string; policy: string }>;
}

export interface DesktopGateDeps {
  io: ControlIo;
  consent: ConsentRunner;
  now?: () => number;
  /** 租约空闲多久后失效（默认 5 分钟） */
  leaseTtlMs?: number;
  /** 同意倒计时秒数，0 = 不弹窗直接放行（无人值守） */
  consentSeconds?: number;
  agentName?: string;
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

export interface GatedProbe {
  gated: boolean;
  policy: ControlPolicy;
  leaseAcquired: boolean;
  consent?: ConsentAnswer;
}

/** 空闲不足该值说明近期有真实输入 */
const STEAL_IDLE_MS = 600;
/** 我方最后一次输入后的宽限期，避免把自己刚发的输入判成"用户夺回" */
const OWN_GRACE_MS = 900;

interface Lease {
  acquiredAt: number;
  lastActivityAt: number;
  consent: ConsentAnswer;
}

export class DesktopControlGate {
  readonly #io: ControlIo;
  readonly #consent: ConsentRunner;
  readonly #now: () => number;
  readonly #leaseTtlMs: number;
  readonly #consentSeconds: number;
  readonly #agentName: string;
  readonly #onEvent: (event: string, detail: Record<string, unknown>) => void;
  #lease: Lease | undefined;

  constructor(deps: DesktopGateDeps) {
    this.#io = deps.io;
    this.#consent = deps.consent;
    this.#now = deps.now ?? (() => Date.now());
    this.#leaseTtlMs = deps.leaseTtlMs ?? 5 * 60_000;
    this.#consentSeconds = deps.consentSeconds ?? 10;
    this.#agentName = deps.agentName ?? 'win-mcp';
    this.#onEvent = deps.onEvent ?? (() => undefined);
  }

  get leased(): boolean {
    return this.#lease !== undefined;
  }

  async status(): Promise<Record<string, unknown>> {
    const state = await this.#io.readState();
    const lease = this.#lease;
    const remaining = lease === undefined ? 0 : Math.max(0, this.#leaseTtlMs - (this.#now() - lease.lastActivityAt));
    return {
      policy: state.policy,
      leased: lease !== undefined && remaining > 0,
      leaseRemainingMs: remaining,
      consentCountdownSeconds: this.#consentSeconds,
      interactive: state.interactive,
      idleMs: state.idleMs,
      foreground: state.foreground,
      cursor: state.cursor ?? null,
      lastConsent: lease?.consent ?? null,
      note:
        '门控是协调而非独占：用户移动鼠标超过阈值即夺回控制，下一次门控调用需重新同意。' +
        'consent_countdown_seconds=0 表示不弹窗（无人值守）。',
    };
  }

  async setPolicy(policy: ControlPolicy): Promise<Record<string, unknown>> {
    if (!isControlPolicy(policy)) {
      throw new ToolFailure('INVALID_PARAMS', `policy 只能是 relaxed|balanced|strict（收到 '${String(policy)}'）`);
    }
    const result = await this.#io.writePolicy(policy);
    // 收紧策略立即影响下一次判定；放权不自动获得租约（仍需同意）
    this.#onEvent('policy-changed', { from: result.previous, to: policy });
    return { previous: result.previous, policy: result.policy };
  }

  /** 用户主动归还控制权 */
  release(): void {
    this.#lease = undefined;
    this.#onEvent('lease-released', {});
  }

  /**
   * 需要时获取/续租控制权；不满足则抛 CONTROL_DENIED / USER_CONTROL。
   * 返回信息用于在结果里披露"本次是否被门控"。
   */
  async ensure(capabilityId: string, args: Record<string, unknown> = {}): Promise<GatedProbe> {
    const state = await this.#io.readState();
    if (!requiresControl(state.policy, capabilityId, args)) {
      return { gated: false, policy: state.policy, leaseAcquired: false };
    }

    const lease = this.#lease;
    if (lease !== undefined) {
      const idleFromLease = this.#now() - lease.lastActivityAt;
      if (idleFromLease > this.#leaseTtlMs) {
        this.#lease = undefined;
        this.#onEvent('lease-expired', { idleFromLease });
      } else if (this.#stolen(state, lease)) {
        this.#lease = undefined;
        this.#onEvent('user-steal', { idleMs: state.idleMs });
        throw new ToolFailure(
          'USER_CONTROL',
          '用户已重新接管桌面，控制租约被撤销；请确认是否继续，再重新发起该操作',
          { idleMs: state.idleMs },
        );
      } else {
        lease.lastActivityAt = this.#now();
        return { gated: true, policy: state.policy, leaseAcquired: false, consent: lease.consent };
      }
    }

    const answer = await this.#consent.ask({
      seconds: this.#consentSeconds,
      title: 'AI 需要控制桌面',
      message: `即将操作鼠标/键盘：${capabilityId}。你随时移动鼠标即可夺回控制。`,
      agentName: this.#agentName,
    });

    if (answer === 'deny') {
      this.#onEvent('consent-denied', { capabilityId });
      throw new ToolFailure('CONTROL_DENIED', '用户拒绝授予桌面控制权，操作已取消', { capabilityId });
    }
    if (answer === 'unavailable') {
      this.#onEvent('consent-unavailable', { capabilityId, interactive: state.interactive });
      throw new ToolFailure(
        'CONTROL_DENIED',
        state.interactive
          ? '同意对话框不可用（启动失败或已挂起），按 fail-closed 拒绝执行；可把 consent 秒数设为 0 以无人值守运行'
          : '当前会话无交互桌面，无法征求同意；可把 consent 秒数设为 0 以无人值守运行',
        { capabilityId, interactive: state.interactive },
      );
    }

    this.#lease = { acquiredAt: this.#now(), lastActivityAt: this.#now(), consent: answer };
    this.#onEvent('lease-acquired', { capabilityId, consent: answer });
    return { gated: true, policy: state.policy, leaseAcquired: true, consent: answer };
  }

  /** 门控 + 执行 + 记录我方活动时间（避免把自己注入的输入误判为用户夺回） */
  async run<T>(
    capabilityId: string,
    args: Record<string, unknown>,
    action: () => Promise<T>,
  ): Promise<{ result: T; probe: GatedProbe }> {
    const probe = await this.ensure(capabilityId, args);
    const result = await action();
    if (this.#lease !== undefined) {
      this.#lease.lastActivityAt = this.#now();
    }
    return { result, probe };
  }

  #stolen(state: DesktopControlState, lease: Lease): boolean {
    if (state.idleMs < 0) return false; // 探测不可用：不做误判
    const sinceOwnInput = this.#now() - lease.lastActivityAt;
    if (sinceOwnInput <= OWN_GRACE_MS) return false;
    return state.idleMs < STEAL_IDLE_MS;
  }
}