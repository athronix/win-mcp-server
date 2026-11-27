import { describe, expect, it, vi } from 'vitest';
import { PlanStore } from '../src/plan/store.js';

function makeStore(overrides: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  let seq = 0;
  return new PlanStore({
    ...overrides,
    idFactory: () => `plan-${(seq += 1)}`,
  });
}

describe('planId 存储', () => {
  it('P-01 add 生成 planId 与过期时间', () => {
    const store = makeStore({ now: () => 1_000, ttlMs: 60_000 });
    const added = store.add('winget.install', { ids: ['A.B'] }, { status: 'ready' });
    expect(added.planId).toBe('plan-1');
    expect(added.expiresAt).toBe(61_000);
    expect(store.size).toBe(1);
  });

  it('P-02 相同参数消费成功并返回计划', () => {
    const store = makeStore();
    const added = store.add('winget.install', { ids: ['A.B'] }, { status: 'ready' });
    const result = store.consume(added.planId, 'winget.install', { ids: ['A.B'] });
    expect(result).toEqual({ ok: true, plan: { status: 'ready' } });
  });

  it('P-03 一次性：第二次消费 PLAN_NOT_FOUND', () => {
    const store = makeStore();
    const added = store.add('winget.install', { ids: ['A.B'] }, {});
    expect(store.consume(added.planId, 'winget.install', { ids: ['A.B'] }).ok).toBe(true);
    const second = store.consume(added.planId, 'winget.install', { ids: ['A.B'] });
    expect(second).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
  });

  it('P-04 参数被改动 → PLAN_MISMATCH，且不消耗计划', () => {
    const store = makeStore();
    const added = store.add('winget.install', { ids: ['A.B'] }, {});
    const mismatch = store.consume(added.planId, 'winget.install', { ids: ['A.C'] });
    expect(mismatch).toMatchObject({ ok: false, code: 'PLAN_MISMATCH' });
    // 计划仍在：防止"试错把计划烧掉"
    expect(store.consume(added.planId, 'winget.install', { ids: ['A.B'] }).ok).toBe(true);
  });

  it('P-05 参数 key 顺序不同但语义相同 → 允许（规范化指纹）', () => {
    const store = makeStore();
    const added = store.add('op', { ids: ['A'], operation: 'install' }, {});
    const result = store.consume(added.planId, 'op', { operation: 'install', ids: ['A'] });
    expect(result.ok).toBe(true);
  });

  it('P-06 操作名不一致 → PLAN_MISMATCH', () => {
    const store = makeStore();
    const added = store.add('winget.install', { ids: ['A'] }, {});
    expect(store.consume(added.planId, 'winget.uninstall', { ids: ['A'] })).toMatchObject({
      ok: false,
      code: 'PLAN_MISMATCH',
    });
  });

  it('P-07 过期 → PLAN_EXPIRED 并清理', () => {
    let now = 0;
    const store = makeStore({ now: () => now, ttlMs: 1_000 });
    const added = store.add('op', {}, {});
    now = 2_000;
    expect(store.consume(added.planId, 'op', {})).toMatchObject({ ok: false, code: 'PLAN_EXPIRED' });
    expect(store.size).toBe(0);
  });

  it('P-08 空 planId → PLAN_NOT_FOUND（带可执行提示）', () => {
    const store = makeStore();
    const result = store.consume('', 'op', {});
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(!result.ok && result.message).toContain('先调用');
  });

  it('P-09 超出容量时淘汰最旧的', () => {
    const store = makeStore({ maxEntries: 2 });
    const first = store.add('op', { n: 1 }, {});
    store.add('op', { n: 2 }, {});
    store.add('op', { n: 3 }, {});
    expect(store.size).toBe(2);
    expect(store.consume(first.planId, 'op', { n: 1 })).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
  });

  it('P-10 prune 清掉过期项，clear 清空', () => {
    let now = 0;
    const store = makeStore({ now: () => now, ttlMs: 100 });
    store.add('op', {}, {});
    now = 500;
    store.prune();
    expect(store.size).toBe(0);
    store.add('op', {}, {});
    store.clear();
    expect(store.size).toBe(0);
  });

  it('P-11 默认 ttl 是 5 分钟', () => {
    const store = new PlanStore({ idFactory: () => 'x', now: () => 0 });
    expect(new Date(store.add('op', {}, {}).expiresAt).getTime()).toBe(300_000);
  });

  it('P-12 计划对象原样返回（不深拷贝也不改写）', () => {
    const store = makeStore();
    const plan = { status: 'ready', changes: [{ id: 'A' }] };
    const added = store.add('op', {}, plan);
    const consumed = store.consume<typeof plan>(added.planId, 'op', {});
    expect(consumed.ok && consumed.plan).toBe(plan);
  });

  it('P-13 未使用的 planId 不影响其它计划', () => {
    const store = makeStore();
    const a = store.add('op', { id: 'A' }, {});
    const b = store.add('op', { id: 'B' }, {});
    expect(store.consume(a.planId, 'op', { id: 'A' }).ok).toBe(true);
    expect(store.consume(b.planId, 'op', { id: 'B' }).ok).toBe(true);
  });

  it('P-14 时间来源可注入（便于确定性测试）', () => {
    const now = vi.fn(() => 42);
    const store = makeStore({ now, ttlMs: 10 });
    const added = store.add('op', {}, {});
    expect(added.expiresAt).toBe(52);
    expect(now).toHaveBeenCalled();
  });
});