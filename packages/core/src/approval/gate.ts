import type { Capability, CapabilityResult } from '../contracts/capability.js';
import {
  RESUME_HINT,
  approvalEnvelope,
  failureEnvelope,
  successEnvelope,
  type ApprovalBranch,
  type ToolEnvelope,
} from '../contracts/envelope.js';
import { makeError, type ErrorCode } from '../contracts/errors.js';
import { maxRisk, type RiskLevel } from '../contracts/risk.js';
import type { AuditChain, AuditOutcome } from '../audit/chain.js';
import type { PolicyEngine } from '../policy/engine.js';
import {
  collectStringValues,
  looksLikePath,
  looksLikeRegistryPath,
} from '../policy/glob.js';
import { newTraceId } from '../util/ids.js';
import { hashParams } from './hash.js';
import { evaluatePolicyControl, type AutoApproveState } from './policy-control.js';
import type { ApprovalStore } from './store.js';

/** 动态判级结果：风险 + 审批卡预览；blocked 有值表示"进审批链之前就失败" */
export interface DynamicClassification {
  risk: RiskLevel;
  preview: Record<string, unknown>;
  impact: string[];
  analysis?: unknown;
  /** AST 采集的可信路径证据；提供后 policy 不再从命令原文正则抽路径（避免注释误判） */
  paths?: string[];
  blocked?: { code: ErrorCode; message: string; analysis?: unknown };
}

export type DynamicClassifier = (
  capability: Capability,
  params: Record<string, unknown>,
) => Promise<DynamicClassification> | DynamicClassification;

export interface ExecuteContext {
  risk: RiskLevel;
  traceId: string;
}

export type ExecuteFn = (
  params: Record<string, unknown>,
  ctx: ExecuteContext,
) => Promise<CapabilityResult>;

export interface GateDeps {
  policy: PolicyEngine;
  store: ApprovalStore;
  audit: AuditChain;
  classify?: DynamicClassifier;
  now?: () => number;
  traceIdFactory?: () => string;
}

export interface GateRequest {
  capability: Capability;
  params: Record<string, unknown>;
  approvalId?: string;
  traceId?: string;
  branch?: ApprovalBranch;
}

export interface GateOutcome {
  envelope: ToolEnvelope;
  executed: boolean;
}

export interface PolicyControlRequest extends GateRequest {
  current: AutoApproveState;
  target: AutoApproveState;
}

interface GuardContext {
  capability: Capability;
  rest: Record<string, unknown>;
  approvalId?: string;
  traceId: string;
  risk: RiskLevel;
  preview: Record<string, unknown>;
  impact: string[];
  analysis?: unknown;
  pathEvidence?: readonly string[];
  forceApproval: boolean;
  branch: ApprovalBranch;
}

/**
 * 审批编排（FR-104）：两阶段 8 步
 * 1 拆 __approvalId → 2 动态判级（失败即拒，不入审批）→ 3 参数哈希
 * 4 消费凭证（不符即 APPROVAL_MISMATCH）→ 5 策略判定
 * 6 需审批则登记 pending（不执行）→ 7 执行 → 8 审计
 */
export class ToolGate {
  readonly #policy: PolicyEngine;
  readonly #store: ApprovalStore;
  readonly #audit: AuditChain;
  readonly #classify?: DynamicClassifier;
  readonly #now: () => number;
  readonly #traceIdFactory: () => string;

  constructor(deps: GateDeps) {
    this.#policy = deps.policy;
    this.#store = deps.store;
    this.#audit = deps.audit;
    if (deps.classify !== undefined) this.#classify = deps.classify;
    this.#now = deps.now ?? Date.now;
    this.#traceIdFactory = deps.traceIdFactory ?? newTraceId;
  }

  async run(req: GateRequest, execute: ExecuteFn): Promise<GateOutcome> {
    const traceId = req.traceId ?? this.#traceIdFactory();
    const capability = req.capability;

    if (capability.policyControl) {
      return {
        envelope: failureEnvelope({
          traceId,
          risk: capability.risk,
          error: makeError(
            'INVALID_PARAMS',
            '策略自管理能力必须通过 runPolicyControl 执行（禁止走普通执行路径）',
          ),
        }),
        executed: false,
      };
    }

    const { __approvalId, ...rest } = req.params;
    const approvalId = typeof __approvalId === 'string' ? __approvalId : undefined;

    let risk = capability.risk;
    let preview: Record<string, unknown> = {};
    let impact: string[] = [];
    let analysis: unknown;
    let pathEvidence: readonly string[] | undefined;

    if (capability.dynamicRisk) {
      if (this.#classify === undefined) {
        return {
          envelope: failureEnvelope({
            traceId,
            risk,
            error: makeError(
              'PREFLIGHT_UNAVAILABLE',
              '动态风险能力缺少判级器，无法预检（fail-closed）',
            ),
          }),
          executed: false,
        };
      }
      let classification: DynamicClassification;
      try {
        classification = await this.#classify(capability, rest);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          envelope: failureEnvelope({
            traceId,
            risk,
            error: makeError('PREFLIGHT_FAILED', `命令预检失败：${message}`),
          }),
          executed: false,
        };
      }
      if (classification.blocked !== undefined) {
        const blockedRisk = maxRisk(risk, 'L3');
        this.#record({
          traceId,
          capabilityId: capability.id,
          risk: blockedRisk,
          paramsHash: hashParams(capability.id, rest),
          outcome: 'denied',
          params: rest,
        });
        return {
          envelope: failureEnvelope({
            traceId,
            risk: blockedRisk,
            error: makeError(
              classification.blocked.code,
              classification.blocked.message,
              { failClosed: true },
            ),
            analysis: classification.blocked.analysis ?? classification.analysis,
          }),
          executed: false,
        };
      }
      risk = classification.risk;
      preview = classification.preview;
      impact = classification.impact;
      analysis = classification.analysis;
      if (classification.paths !== undefined) pathEvidence = classification.paths;
    }

    return this.#guardAndExecute(
      {
        capability,
        rest,
        ...(approvalId !== undefined ? { approvalId } : {}),
        traceId,
        risk,
        preview,
        impact,
        ...(analysis !== undefined ? { analysis } : {}),
        ...(pathEvidence !== undefined ? { pathEvidence } : {}),
        forceApproval: false,
        branch: req.branch ?? 'local',
      },
      execute,
    );
  }

  /** 策略自管理入口：按"有效权限等级"判方向，放权强制 L3 审批（FR-104 防自我放权） */
  async runPolicyControl(req: PolicyControlRequest, apply: ExecuteFn): Promise<GateOutcome> {
    const traceId = req.traceId ?? this.#traceIdFactory();
    const { __approvalId, ...rest } = req.params;
    const approvalId = typeof __approvalId === 'string' ? __approvalId : undefined;
    const verdict = evaluatePolicyControl(req.current, req.target);

    const impact = [
      `策略变更：${verdict.direction}`,
      `从 ${JSON.stringify(verdict.from)} → ${JSON.stringify(verdict.to)}`,
      ...(verdict.forceApproval
        ? ['放权操作已强制审批，不受当前 autoApprove 影响']
        : []),
    ];

    return this.#guardAndExecute(
      {
        capability: req.capability,
        rest,
        ...(approvalId !== undefined ? { approvalId } : {}),
        traceId,
        risk: verdict.effectiveRisk,
        preview: { policyChange: verdict },
        impact,
        forceApproval: verdict.forceApproval,
        branch: 'local',
      },
      apply,
    );
  }

  async #guardAndExecute(ctx: GuardContext, execute: ExecuteFn): Promise<GateOutcome> {
    const paramsHash = hashParams(ctx.capability.id, ctx.rest);

    // 4. 消费凭证（一次性，执行前消费）
    let approved = false;
    if (ctx.approvalId !== undefined) {
      const consumed = this.#store.consume(ctx.approvalId, ctx.capability.id, paramsHash);
      if (!consumed.ok) {
        this.#record({
          traceId: ctx.traceId,
          capabilityId: ctx.capability.id,
          risk: ctx.risk,
          paramsHash,
          outcome: 'approval_mismatch',
          params: ctx.rest,
        });
        return {
          envelope: failureEnvelope({ traceId: ctx.traceId, risk: ctx.risk, error: consumed.error }),
          executed: false,
        };
      }
      approved = true;
    }

    // 5. 策略判定
    const verdict = this.#policy.evaluate({
      capabilityId: ctx.capability.id,
      params: ctx.rest,
      risk: ctx.risk,
      approved,
      ...(ctx.capability.policy !== undefined
        ? { capabilityPolicy: ctx.capability.policy }
        : {}),
      ...(ctx.pathEvidence !== undefined ? { pathEvidence: ctx.pathEvidence } : {}),
      ...(ctx.capability.analysisOnly ? { analysisOnly: true } : {}),
      ...(ctx.forceApproval ? { forceApproval: true } : {}),
    });

    if (!verdict.allowed) {
      if (verdict.requiresApproval) {
        // 6. 登记 pending，不执行
        const pending = this.#store.create({
          branch: ctx.branch,
          capabilityId: ctx.capability.id,
          risk: ctx.risk,
          paramsHash,
          params: ctx.rest,
          preview: ctx.preview,
          impact: ctx.impact.length > 0 ? ctx.impact : this.#defaultImpact(ctx.rest),
        });
        this.#record({
          traceId: ctx.traceId,
          capabilityId: ctx.capability.id,
          risk: ctx.risk,
          paramsHash,
          outcome: 'approval_required',
          params: ctx.rest,
        });
        return {
          envelope: approvalEnvelope({
            traceId: ctx.traceId,
            risk: ctx.risk,
            approval: {
              approvalId: pending.approvalId,
              risk: pending.risk,
              capabilityId: pending.capabilityId,
              preview: pending.preview,
              impact: pending.impact,
              resumeHint: RESUME_HINT,
              branch: pending.branch,
            },
            ...(ctx.analysis !== undefined ? { analysis: ctx.analysis } : {}),
          }),
          executed: false,
        };
      }
      this.#record({
        traceId: ctx.traceId,
        capabilityId: ctx.capability.id,
        risk: ctx.risk,
        paramsHash,
        outcome: 'denied',
        params: ctx.rest,
      });
      return {
        envelope: failureEnvelope({
          traceId: ctx.traceId,
          risk: ctx.risk,
          error: verdict.error ?? makeError('POLICY_DENIED', '被策略拒绝'),
          ...(ctx.analysis !== undefined ? { analysis: ctx.analysis } : {}),
        }),
        executed: false,
      };
    }

    if (verdict.autoApproved === true) {
      this.#record({
        traceId: ctx.traceId,
        capabilityId: ctx.capability.id,
        risk: ctx.risk,
        paramsHash,
        outcome: 'auto_approved',
        params: ctx.rest,
      });
    }

    // 7. 执行
    const startedAt = this.#now();
    try {
      const result = await execute(ctx.rest, { risk: ctx.risk, traceId: ctx.traceId });
      const auditRef = this.#record({
        traceId: ctx.traceId,
        capabilityId: ctx.capability.id,
        risk: ctx.risk,
        paramsHash,
        outcome: 'executed',
        params: ctx.rest,
      });
      return {
        envelope: successEnvelope({
          traceId: ctx.traceId,
          risk: ctx.risk,
          data: result.data ?? null,
          auditRef,
          durationMs: this.#now() - startedAt,
          ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
          ...(verdict.autoApproved === true ? { autoApproved: true } : {}),
          ...(result.effectState !== undefined ? { effectState: result.effectState } : {}),
          ...(result.backupStatus !== undefined ? { backupStatus: result.backupStatus } : {}),
          ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
        }),
        executed: true,
      };
    } catch (error) {
      this.#record({
        traceId: ctx.traceId,
        capabilityId: ctx.capability.id,
        risk: ctx.risk,
        paramsHash,
        outcome: 'failed',
        params: ctx.rest,
      });
      const message = error instanceof Error ? error.message : String(error);
      const code: ErrorCode =
        error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'INTERNAL';
      return {
        envelope: failureEnvelope({
          traceId: ctx.traceId,
          risk: ctx.risk,
          error: makeError(code, message),
        }),
        executed: false,
      };
    }
  }

  #record(input: {
    traceId: string;
    capabilityId: string;
    risk: RiskLevel;
    paramsHash: string;
    outcome: AuditOutcome;
    params: Record<string, unknown>;
  }): string {
    const entry = this.#audit.append(input);
    return `${entry.seq}:${entry.hash.slice(0, 12)}`;
  }

  #defaultImpact(params: Record<string, unknown>): string[] {
    const impacts: string[] = [];
    for (const { key, value } of collectStringValues(params)) {
      if (looksLikePath(value) || looksLikeRegistryPath(value)) {
        impacts.push(`${key}: ${value}`);
      }
    }
    if (impacts.length === 0) {
      impacts.push('无路径类影响；请确认参数与预期一致');
    }
    return impacts.slice(0, 8);
  }
}