import { describe, expect, it } from 'vitest';
import { AuditChain, redactParams, type AuditEntry } from '../src/audit/chain.js';

function makeChain() {
  let now = 1_000;
  return new AuditChain({ secret: 'test-secret', now: () => (now += 1) });
}

const baseInput = {
  traceId: 'tr_1',
  capabilityId: 'system.service.control',
  risk: 'L2' as const,
  paramsHash: 'hash1',
  params: { name: 'spooler' },
};

describe('FR-105 审计链', () => {
  it('U-01 追加并串联 prevHash', () => {
    const chain = makeChain();
    const first = chain.append({ ...baseInput, outcome: 'approval_required' });
    const second = chain.append({ ...baseInput, outcome: 'executed' });
    const third = chain.append({ ...baseInput, outcome: 'failed' });
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(first.prevHash).toBe('genesis');
    expect(second.prevHash).toBe(first.hash);
    expect(third.prevHash).toBe(second.hash);
  });

  it('U-02 链校验通过', () => {
    const chain = makeChain();
    chain.append({ ...baseInput, outcome: 'executed' });
    chain.append({ ...baseInput, outcome: 'denied' });
    expect(chain.verify()).toEqual({ valid: true });
  });

  it('U-03 篡改可检出并定位', () => {
    const chain = makeChain();
    chain.append({ ...baseInput, outcome: 'executed' });
    chain.append({ ...baseInput, outcome: 'executed' });
    chain.append({ ...baseInput, outcome: 'executed' });
    const tampered: AuditEntry[] = chain.entries().map((entry) => ({ ...entry }));
    const second = tampered[1]!;
    tampered[1] = { ...second, paramsRedacted: { name: 'HACKED' } };
    const verdict = chain.verify(tampered);
    expect(verdict.valid).toBe(false);
    expect(verdict.brokenAtSeq).toBe(2);
  });

  it('U-04 敏感参数脱敏且长串截断', () => {
    const redacted = redactParams({
      password: 'p@ss',
      token: 'abc',
      cookie: 'c=1',
      name: 'spooler',
      nested: { apiKey: 'k', keep: 'v' },
      long: 'x'.repeat(300),
    });
    expect(redacted.password).toBe('***');
    expect(redacted.token).toBe('***');
    expect(redacted.cookie).toBe('***');
    expect(redacted.name).toBe('spooler');
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe('***');
    expect((redacted.nested as Record<string, unknown>).keep).toBe('v');
    expect(String(redacted.long)).toMatch(/truncated/);
  });

  it('U-05 entries 返回副本，不暴露内部状态', () => {
    const chain = makeChain();
    chain.append({ ...baseInput, outcome: 'executed' });
    const snapshot = chain.entries();
    snapshot[0]!.paramsRedacted.name = 'mutated';
    expect(chain.entries()[0]!.paramsRedacted.name).toBe('spooler');
    expect(chain.verify().valid).toBe(true);
  });

  it('U-06 可按 traceId 检索', () => {
    const chain = makeChain();
    chain.append({ ...baseInput, outcome: 'approval_required' });
    chain.append({ ...baseInput, traceId: 'tr_2', outcome: 'executed' });
    chain.append({ ...baseInput, outcome: 'executed' });
    expect(chain.findByTraceId('tr_1')).toHaveLength(2);
    expect(chain.findByTraceId('tr_2')).toHaveLength(1);
  });
});