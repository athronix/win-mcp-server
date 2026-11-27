import { canonicalJson } from '../approval/hash.js';

/**
 * planId 三分支（照 winutil-cn 的 plans.mjs）
 *
 * 语义：preview 生成计划 → 客户端向用户展示 → 带 planId 执行。
 * - planId 只证明"这次调用与那次预览一致"，**不代替用户同意**（upstream 原文强调）。
 * - 参数用规范化 JSON 做指纹，防止"预览 A、执行 B"的掉包。
 * - 一次性 + TTL + 容量上限，避免累积与重放。
 */
export type PlanConsumeFailure = 'PLAN_NOT_FOUND' | 'PLAN_EXPIRED' | 'PLAN_MISMATCH';

export interface PlanAddResult {
  planId: string;
  expiresAt: number;
}

export type PlanConsumeResult<TPlan = unknown> =
  | { ok: true; plan: TPlan }
  | { ok: false; code: PlanConsumeFailure; message: string };

interface PlanRecord {
  operation: string;
  argsHash: string;
  plan: unknown;
  expiresAt: number;
  createdAt: number;
}

export interface PlanStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  idFactory?: () => string;
}

export class PlanStore {
  readonly #records = new Map<string, PlanRecord>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(options: PlanStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maxEntries = options.maxEntries ?? 100;
    this.#now = options.now ?? (() => Date.now());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  get size(): number {
    return this.#records.size;
  }

  add(operation: string, args: Record<string, unknown>, plan: unknown): PlanAddResult {
    this.prune();
    const planId = this.#idFactory();
    const createdAt = this.#now();
    this.#records.set(planId, {
      operation,
      argsHash: canonicalJson(args),
      plan,
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
    });
    while (this.#records.size > this.#maxEntries) {
      const oldest = this.#records.keys().next();
      if (oldest.done === true) break;
      this.#records.delete(oldest.value);
    }
    return { planId, expiresAt: createdAt + this.#ttlMs };
  }

  /** 一次性消费：任何一项校验不过都拒绝，且不消耗 planId */
  consume<TPlan = unknown>(
    planId: string,
    operation: string,
    args: Record<string, unknown>,
  ): PlanConsumeResult<TPlan> {
    if (typeof planId !== 'string' || planId.length === 0) {
      return { ok: false, code: 'PLAN_NOT_FOUND', message: 'planId 缺失：先调用对应的 *.plan 取得计划' };
    }
    const record = this.#records.get(planId);
    if (record === undefined) {
      return { ok: false, code: 'PLAN_NOT_FOUND', message: `planId ${planId} 不存在（已使用过或已过期）` };
    }
    if (this.#now() > record.expiresAt) {
      this.#records.delete(planId);
      return { ok: false, code: 'PLAN_EXPIRED', message: `planId ${planId} 已过期，请重新预览` };
    }
    if (record.operation !== operation) {
      return { ok: false, code: 'PLAN_MISMATCH', message: `planId 属于操作 ${record.operation}，不能用于 ${operation}` };
    }
    if (record.argsHash !== canonicalJson(args)) {
      return { ok: false, code: 'PLAN_MISMATCH', message: '参数与预览时不一致：请用相同参数重新预览后再执行' };
    }

    this.#records.delete(planId);
    return { ok: true, plan: record.plan as TPlan };
  }

  prune(): void {
    const now = this.#now();
    for (const [planId, record] of this.#records) {
      if (now > record.expiresAt) this.#records.delete(planId);
    }
  }

  clear(): void {
    this.#records.clear();
  }
}