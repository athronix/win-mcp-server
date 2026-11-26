import { createHash } from 'node:crypto';

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error('canonicalJson: 不支持 NaN/Infinity');
    return n;
  }
  if (type === 'bigint') return (value as bigint).toString();
  if (type === 'undefined') return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalize(item, seen);
      return normalized === undefined ? null : normalized;
    });
  }
  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) throw new Error('canonicalJson: 检测到循环引用');
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const normalized = normalize(obj[key], seen);
      if (normalized !== undefined) out[key] = normalized;
    }
    seen.delete(obj);
    return out;
  }
  return String(value);
}

/** 稳定序列化：键排序、剔除 undefined、数组保序（用于参数哈希与审计链） */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet())) ?? 'null';
}

/** paramsHash = sha256(capabilityId + '\0' + canonicalJson(params)) — FR-104 */
export function hashParams(capabilityId: string, params: Record<string, unknown>): string {
  return createHash('sha256')
    .update(capabilityId)
    .update('\u0000')
    .update(canonicalJson(params))
    .digest('hex');
}