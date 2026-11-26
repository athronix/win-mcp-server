import { describe, expect, it } from 'vitest';
import { canonicalJson, hashParams } from '../src/approval/hash.js';
import { evaluatePolicyControl } from '../src/approval/policy-control.js';
import { ApprovalStore } from '../src/approval/store.js';

function makeStore(ttlMs = 1000) {
  let now = 1_000_000;
  let counter = 0;
  const store = new ApprovalStore({
    ttlMs,
    now: () => now,
    idFactory: () => `apr_test_${(counter += 1)}`,
  });
  return {
    store,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe('FR-104 审批', () => {
  it('A-01 canonical 与键序无关', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(hashParams('a.b.c', { x: 1, y: 2 })).toBe(hashParams('a.b.c', { y: 2, x: 1 }));
  });

  it('A-02 嵌套结构稳定', () => {
    const a = { list: [{ z: 1, a: 2 }], nested: { q: 'v' } };
    const b = { nested: { q: 'v' }, list: [{ a: 2, z: 1 }] };
    expect(hashParams('a.b.c', a)).toBe(hashParams('a.b.c', b));
  });

  it('A-03 创建 pending', () => {
    const { store } = makeStore();
    const pending = store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: 'h1',
      params: { name: 'spooler' },
      preview: { name: 'spooler' },
      impact: ['服务 spooler 将被停止'],
    });
    expect(pending.approvalId).toBe('apr_test_1');
    expect(pending.createdAtMs).toBe(1_000_000);
    expect(pending.branch).toBe('local');
    expect(store.size).toBe(1);
  });

  it('A-04 同能力同参消费成功', () => {
    const { store } = makeStore();
    const pending = store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: 'h1',
      params: {},
      preview: {},
      impact: [],
    });
    const result = store.consume(pending.approvalId, 'system.service.control', 'h1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pending.risk).toBe('L2');
  });

  it('A-05 能力 ID 不符即作废', () => {
    const { store } = makeStore();
    const pending = store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: 'h1',
      params: {},
      preview: {},
      impact: [],
    });
    const mismatched = store.consume(pending.approvalId, 'system.power.control', 'h1');
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error.code).toBe('APPROVAL_MISMATCH');
      expect(mismatched.error.details?.reason).toBe('mismatch');
    }
    // 已销毁
    expect(store.consume(pending.approvalId, 'system.service.control', 'h1').ok).toBe(false);
  });

  it('A-06 参数变化即掉包', () => {
    const { store } = makeStore();
    const h1 = hashParams('system.service.control', { name: 'spooler' });
    const h2 = hashParams('system.service.control', { name: 'spooler', force: true });
    const pending = store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: h1,
      params: { name: 'spooler' },
      preview: {},
      impact: [],
    });
    const result = store.consume(pending.approvalId, 'system.service.control', h2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('APPROVAL_MISMATCH');
  });

  it('A-07 凭证一次性', () => {
    const { store } = makeStore();
    const pending = store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: 'h1',
      params: {},
      preview: {},
      impact: [],
    });
    expect(store.consume(pending.approvalId, 'system.service.control', 'h1').ok).toBe(true);
    const second = store.consume(pending.approvalId, 'system.service.control', 'h1');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.details?.reason).toBe('not_found');
  });

  it('A-08 TTL 过期作废', () => {
    const { store, advance } = makeStore(1000);
    const pending = store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: 'h1',
      params: {},
      preview: {},
      impact: [],
    });
    advance(1001);
    const result = store.consume(pending.approvalId, 'system.service.control', 'h1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('expired');
  });

  it('A-09 sweep 清理过期条目', () => {
    const { store, advance } = makeStore(100);
    store.create({
      branch: 'local',
      capabilityId: 'system.service.control',
      risk: 'L2',
      paramsHash: 'h1',
      params: {},
      preview: {},
      impact: [],
    });
    expect(store.sweep()).toBe(0);
    advance(101);
    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(0);
  });

  it('A-10 放权判定为 loosen → L3 + forceApproval', () => {
    const v = evaluatePolicyControl({ enabled: false, maxRisk: 'L2' }, { enabled: true, maxRisk: 'L2' });
    expect(v.direction).toBe('loosen');
    expect(v.effectiveRisk).toBe('L3');
    expect(v.forceApproval).toBe(true);
  });

  it('A-11 收紧判定为 tighten → L1', () => {
    const v = evaluatePolicyControl({ enabled: true, maxRisk: 'L2' }, { enabled: false, maxRisk: 'L2' });
    expect(v.direction).toBe('tighten');
    expect(v.effectiveRisk).toBe('L1');
    expect(v.forceApproval).toBe(false);
  });

  it('A-12 不变判定', () => {
    const v = evaluatePolicyControl({ enabled: false, maxRisk: 'L2' }, { enabled: false, maxRisk: 'L2' });
    expect(v.direction).toBe('unchanged');
    expect(v.effectiveRisk).toBe('L1');
  });

  it('A-13 L2 → L3 属放权', () => {
    const v = evaluatePolicyControl({ enabled: true, maxRisk: 'L2' }, { enabled: true, maxRisk: 'L3' });
    expect(v.direction).toBe('loosen');
    expect(v.effectiveRisk).toBe('L3');
    expect(v.forceApproval).toBe(true);
  });
});