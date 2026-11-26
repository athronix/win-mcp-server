import { canonicalJson } from '../approval/hash.js';
import { createHmac } from 'node:crypto';
import type { RiskLevel } from '../contracts/risk.js';

export type AuditOutcome =
  | 'denied'
  | 'approval_required'
  | 'approval_mismatch'
  | 'auto_approved'
  | 'executed'
  | 'failed';

export interface AuditEntry {
  seq: number;
  ts: number;
  traceId: string;
  capabilityId: string;
  risk: RiskLevel;
  paramsHash: string;
  outcome: AuditOutcome;
  paramsRedacted: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditInput {
  traceId: string;
  capabilityId: string;
  risk: RiskLevel;
  paramsHash: string;
  outcome: AuditOutcome;
  params: Record<string, unknown>;
}

const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|apikey|api_key|credential|cookie|authorization|private_key)/i;
const MAX_STRING_LENGTH = 200;
const GENESIS = 'genesis';

/** 递归脱敏：敏感键值替换为 ***，长字符串截断，深度上限 8 层 */
export function redactParams(params: unknown, depth = 0): Record<string, unknown> {
  const root = redactValue(params, depth);
  return root !== null && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>)
    : { value: root };
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length}]`
      : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '***' : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface AuditChainOptions {
  secret?: string;
  now?: () => number;
}

/**
 * 审计链（FR-105）
 * hash = hmacSha256(secret, prevHash + '\0' + canonicalJson(正文))
 * 用途是防意外/低成本篡改（本机文件），不是密码学级防护。
 */
export class AuditChain {
  readonly #entries: AuditEntry[] = [];
  readonly #secret: string;
  readonly #now: () => number;

  constructor(opts: AuditChainOptions = {}) {
    this.#secret = opts.secret ?? 'win-mcp-servers/audit/v1';
    this.#now = opts.now ?? Date.now;
  }

  append(input: AuditInput): AuditEntry {
    const prevHash = this.#entries.length === 0 ? GENESIS : this.#entries[this.#entries.length - 1]!.hash;
    const entry: AuditEntry = {
      seq: this.#entries.length + 1,
      ts: this.#now(),
      traceId: input.traceId,
      capabilityId: input.capabilityId,
      risk: input.risk,
      paramsHash: input.paramsHash,
      outcome: input.outcome,
      paramsRedacted: redactParams(input.params),
      prevHash,
      hash: '',
    };
    entry.hash = this.#hashOf(entry);
    this.#entries.push(entry);
    return { ...entry };
  }

  entries(): readonly AuditEntry[] {
    return this.#entries.map((entry) => ({
      ...entry,
      paramsRedacted: structuredClone(entry.paramsRedacted),
    }));
  }

  /**
   * 校验审计链。
   * @param entries 可选：校验外部条目（如从文件加载后校验）；默认校验内存链
   */
  verify(entries: readonly AuditEntry[] = this.#entries): { valid: boolean; brokenAtSeq?: number } {
    let prevHash = GENESIS;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const expected = this.#hashOf({ ...entry, prevHash });
      if (entry.prevHash !== prevHash || entry.hash !== expected) {
        return { valid: false, brokenAtSeq: entry.seq };
      }
      prevHash = entry.hash;
    }
    return { valid: true };
  }

  findByTraceId(traceId: string): AuditEntry[] {
    return this.#entries
      .filter((entry) => entry.traceId === traceId)
      .map((entry) => ({ ...entry, paramsRedacted: structuredClone(entry.paramsRedacted) }));
  }

  #hashOf(entry: AuditEntry): string {
    const payload = canonicalJson({
      seq: entry.seq,
      ts: entry.ts,
      traceId: entry.traceId,
      capabilityId: entry.capabilityId,
      risk: entry.risk,
      paramsHash: entry.paramsHash,
      outcome: entry.outcome,
      paramsRedacted: entry.paramsRedacted,
      prevHash: entry.prevHash,
    });
    return createHmac('sha256', this.#secret).update(payload).digest('hex');
  }
}