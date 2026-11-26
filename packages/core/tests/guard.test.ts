import { describe, expect, it } from 'vitest';
import { MAX_ASSERTIONS, evaluateAssertions, normalizeAssertions } from '../src/guard/expect.js';
import { EffectLedger } from '../src/guard/ledger.js';

const facts = {
  element: { text: 'Submit', checked: false },
  list: [{ id: 1 }, { id: 2 }],
  count: 3,
};

describe('FR-106 写动作守卫', () => {
  it('G-01 equals 通过', () => {
    const v = evaluateAssertions([{ path: 'element.text', op: 'equals', value: 'Submit' }], facts);
    expect(v.ok).toBe(true);
    expect(v.failures).toHaveLength(0);
  });

  it('G-02 equals 失败带 path/expected/actual', () => {
    const v = evaluateAssertions([{ path: 'element.text', op: 'equals', value: 'Cancel' }], facts);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toMatchObject({
      path: 'element.text',
      op: 'equals',
      expected: 'Cancel',
      actual: 'Submit',
    });
  });

  it('G-03 exists', () => {
    expect(evaluateAssertions([{ path: 'count', op: 'exists' }], facts).ok).toBe(true);
    expect(evaluateAssertions([{ path: 'missing.deep', op: 'exists' }], facts).ok).toBe(false);
  });

  it('G-04 contains 支持字符串与数组', () => {
    expect(evaluateAssertions([{ path: 'element.text', op: 'contains', value: 'ubm' }], facts).ok).toBe(true);
    expect(evaluateAssertions([{ path: 'list', op: 'contains', value: { id: 2 } }], facts).ok).toBe(true);
    expect(evaluateAssertions([{ path: 'list', op: 'contains', value: { id: 9 } }], facts).ok).toBe(false);
  });

  it('G-05 超过 16 条拒绝（模型输入不可信）', () => {
    const tooMany = Array.from({ length: MAX_ASSERTIONS + 1 }, (_, i) => ({
      path: `p${i}`,
      op: 'exists' as const,
    }));
    expect(() => normalizeAssertions(tooMany)).toThrow(/最多 16 条/);
    expect(() => normalizeAssertions([{ path: 'a b', op: 'exists' }])).toThrow(/path 非法/);
    expect(() => normalizeAssertions([{ path: 'a', op: 'bogus' }])).toThrow(/op/);
  });

  it('G-06 unknown 阻断同目标重试', () => {
    const ledger = new EffectLedger({ now: () => 1 });
    ledger.record('act_1', 'unknown', 'btn-submit');
    const verdict = ledger.assertRetryable('btn-submit');
    expect(verdict.allowed).toBe(false);
    expect(verdict.blocking?.actionId).toBe('act_1');
  });

  it('G-07 resolve 后允许重试', () => {
    const ledger = new EffectLedger({ now: () => 1 });
    ledger.record('act_1', 'unknown', 'btn-submit');
    ledger.resolve('act_1', 'committed');
    expect(ledger.assertRetryable('btn-submit').allowed).toBe(true);
    expect(ledger.pending()).toHaveLength(0);
  });

  it('G-08 其它目标未核销不影响本目标', () => {
    const ledger = new EffectLedger({ now: () => 1 });
    ledger.record('act_1', 'unknown', 'target-a');
    expect(ledger.assertRetryable('target-b').allowed).toBe(true);
    expect(ledger.assertRetryable().allowed).toBe(false);
  });

  it('G-09 重复 actionId 拒绝', () => {
    const ledger = new EffectLedger();
    ledger.record('act_1', 'committed');
    expect(() => ledger.record('act_1', 'committed')).toThrow(/DUPLICATE_ACTION/);
  });
});