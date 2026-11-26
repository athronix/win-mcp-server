import type { EffectState } from '../contracts/capability.js';

export interface LedgerRecord {
  actionId: string;
  target?: string;
  state: EffectState;
  createdAtMs: number;
  resolvedAtMs?: number;
}

export interface EffectLedgerOptions {
  now?: () => number;
}

/**
 * 效果账本（FR-106）
 * 规则：`effect_state=unknown` 的动作必须先 resolve() 核销，才允许对同一 target 再次写；
 * 否则服务端与 Agent 都不得盲重试（避免双击/双写/toggle 自撤销）。
 */
export class EffectLedger {
  readonly #records = new Map<string, LedgerRecord>();
  readonly #now: () => number;

  constructor(opts: EffectLedgerOptions = {}) {
    this.#now = opts.now ?? Date.now;
  }

  record(actionId: string, state: EffectState, target?: string): LedgerRecord {
    const existing = this.#records.get(actionId);
    if (existing !== undefined) {
      throw new Error(`DUPLICATE_ACTION: ${actionId} 已在账本中`);
    }
    const record: LedgerRecord = {
      actionId,
      state,
      createdAtMs: this.#now(),
      ...(target !== undefined ? { target } : {}),
    };
    this.#records.set(actionId, record);
    return { ...record };
  }

  resolve(actionId: string, actual: 'committed' | 'none'): LedgerRecord {
    const record = this.#records.get(actionId);
    if (record === undefined) throw new Error(`UNKNOWN_ACTION: ${actionId} 不在账本中`);
    const updated: LedgerRecord = {
      ...record,
      state: actual,
      resolvedAtMs: this.#now(),
    };
    this.#records.set(actionId, updated);
    return { ...updated };
  }

  /** 是否允许对该 target 发起新的写动作 */
  assertRetryable(target?: string): { allowed: boolean; blocking?: LedgerRecord } {
    for (const record of this.#records.values()) {
      if (record.state !== 'unknown') continue;
      if (target !== undefined && record.target !== target) continue;
      return { allowed: false, blocking: { ...record } };
    }
    return { allowed: true };
  }

  pending(): LedgerRecord[] {
    return Array.from(this.#records.values())
      .filter((record) => record.state === 'unknown')
      .map((record) => ({ ...record }));
  }
}