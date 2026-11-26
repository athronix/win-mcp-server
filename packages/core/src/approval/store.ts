import type { ApprovalBranch } from '../contracts/envelope.js';
import { makeError, type ToolError } from '../contracts/errors.js';
import type { RiskLevel } from '../contracts/risk.js';
import { newApprovalId } from '../util/ids.js';

export interface PendingApproval {
  approvalId: string;
  branch: ApprovalBranch;
  capabilityId: string;
  risk: RiskLevel;
  paramsHash: string;
  params: Record<string, unknown>;
  preview: Record<string, unknown>;
  impact: string[];
  createdAtMs: number;
}

export type ConsumeResult =
  | { ok: true; pending: PendingApproval }
  | { ok: false; error: ToolError };

export interface ApprovalStoreOptions {
  ttlMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

/**
 * 审批表（FR-104）
 * - TTL 到期即作废
 * - 与 capabilityId + paramsHash 绑定，不符即销毁（防掉包）
 * - 消费在**执行前**完成（防重放）
 */
export class ApprovalStore {
  readonly #items = new Map<string, PendingApproval>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(opts: ApprovalStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? 120_000;
    this.#now = opts.now ?? Date.now;
    this.#idFactory = opts.idFactory ?? newApprovalId;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  create(input: Omit<PendingApproval, 'approvalId' | 'createdAtMs'>): PendingApproval {
    const pending: PendingApproval = {
      ...input,
      approvalId: this.#idFactory(),
      createdAtMs: this.#now(),
    };
    this.#items.set(pending.approvalId, pending);
    return pending;
  }

  consume(id: string, capabilityId: string, paramsHash: string): ConsumeResult {
    const pending = this.#items.get(id);
    if (pending === undefined) {
      return {
        ok: false,
        error: makeError(
          'APPROVAL_MISMATCH',
          '审批凭证不存在或已被使用，请重新发起请求并再次确认',
          { reason: 'not_found' },
        ),
      };
    }
    if (this.#now() - pending.createdAtMs > this.#ttlMs) {
      this.#items.delete(id);
      return {
        ok: false,
        error: makeError('APPROVAL_MISMATCH', '审批已超时作废，请重新发起请求', {
          reason: 'expired',
          ttlMs: this.#ttlMs,
        }),
      };
    }
    if (pending.capabilityId !== capabilityId || pending.paramsHash !== paramsHash) {
      this.#items.delete(id);
      return {
        ok: false,
        error: makeError(
          'APPROVAL_MISMATCH',
          '审批与本次请求的参数不一致，已作废该审批（防掉包）。请重新发起并再次确认',
          { reason: 'mismatch' },
        ),
      };
    }
    // 一次性：执行前消费，异常也不退还
    this.#items.delete(id);
    return { ok: true, pending };
  }

  peek(id: string): PendingApproval | undefined {
    const pending = this.#items.get(id);
    if (pending === undefined) return undefined;
    if (this.#now() - pending.createdAtMs > this.#ttlMs) {
      this.#items.delete(id);
      return undefined;
    }
    return pending;
  }

  /** 清理过期条目，返回清理数量 */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, pending] of this.#items) {
      if (now - pending.createdAtMs > this.#ttlMs) {
        this.#items.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#items.size;
  }
}