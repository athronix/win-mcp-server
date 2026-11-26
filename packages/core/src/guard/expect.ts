/**
 * 写动作前置事实断言 — 对应 FR-106
 * 借鉴 Tencent/BrowserSkill 的 expect[] 语义：动作执行前核对"预览时的事实"是否仍成立。
 */
export type AssertionOp = 'equals' | 'exists' | 'contains';

export interface ExpectAssertion {
  path: string;
  op: AssertionOp;
  value?: unknown;
}

export const MAX_ASSERTIONS = 16;

const PATH_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.[\]-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并归一化 expect（来自模型输入，必须视为不可信） */
export function normalizeAssertions(raw: unknown): ExpectAssertion[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('INVALID_ASSERTIONS: expect 必须是数组');
  if (raw.length > MAX_ASSERTIONS) {
    throw new Error(`INVALID_ASSERTIONS: expect 最多 ${MAX_ASSERTIONS} 条，收到 ${raw.length}`);
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new Error(`INVALID_ASSERTIONS: 第 ${index} 条必须是对象`);
    const { path, op, value } = item;
    if (typeof path !== 'string' || !PATH_PATTERN.test(path)) {
      throw new Error(`INVALID_ASSERTIONS: 第 ${index} 条 path 非法`);
    }
    if (op !== 'equals' && op !== 'exists' && op !== 'contains') {
      throw new Error(`INVALID_ASSERTIONS: 第 ${index} 条 op 必须是 equals/exists/contains`);
    }
    return value === undefined ? { path, op } : { path, op, value };
  });
}

/** 支持 a.b[0].c 形式取事实值 */
function getPath(facts: unknown, path: string): unknown {
  const tokens = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((t) => t.length > 0);
  let cursor: unknown = facts;
  for (const token of tokens) {
    if (cursor === undefined || cursor === null) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (isRecord(cursor)) {
      cursor = cursor[token];
      continue;
    }
    return undefined;
  }
  return cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    if (keysA.some((key, index) => key !== keysB[index])) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

export interface GuardFailure {
  index: number;
  path: string;
  op: AssertionOp;
  expected?: unknown;
  actual?: unknown;
}

export interface GuardVerdict {
  ok: boolean;
  failures: GuardFailure[];
}

/** 对当前事实求值：任一失败即阻断动作 */
export function evaluateAssertions(
  assertions: readonly ExpectAssertion[],
  facts: Record<string, unknown>,
): GuardVerdict {
  const failures: GuardFailure[] = [];
  assertions.forEach((assertion, index) => {
    const actual = getPath(facts, assertion.path);
    let passed: boolean;
    switch (assertion.op) {
      case 'equals':
        passed = deepEqual(actual, assertion.value);
        break;
      case 'exists':
        passed = actual !== undefined && actual !== null;
        break;
      case 'contains':
        if (Array.isArray(actual)) passed = actual.some((item) => deepEqual(item, assertion.value));
        else passed = typeof actual === 'string' && actual.includes(String(assertion.value));
        break;
      default:
        passed = false;
    }
    if (!passed) {
      failures.push({
        index,
        path: assertion.path,
        op: assertion.op,
        ...(assertion.value !== undefined ? { expected: assertion.value } : {}),
        ...(actual !== undefined ? { actual } : {}),
      });
    }
  });
  return { ok: failures.length === 0, failures };
}