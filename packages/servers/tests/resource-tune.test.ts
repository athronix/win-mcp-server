import { describe, expect, it, vi } from 'vitest';
import type { PowerShellBridge } from '@win-mcp/core';
import { resourceCapabilities } from '../src/resource/capabilities.js';

const CATALOG = {
  elevated: false,
  items: [
    { key: 'explorer.menu-delay', requiresAdmin: false, applicable: true, description: 'menu', currentValue: '400' },
    { key: 'system.network-throttling', requiresAdmin: true, applicable: false, description: 'net', currentValue: '10' },
  ],
};

function fakeBridge(overrides: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const defaults: Record<string, unknown> = {
    'Get-TuningCatalog': CATALOG,
    'New-TuningSnapshot': { snapshotId: '11111111-1111-1111-1111-111111111111', path: 'C:\\snap.json', entryCount: 1 },
    'Invoke-TuningApply': { appliedCount: 1, failedCount: 0, failures: [] },
    'Restore-TuningSnapshot': { restoredCount: 1, failedCount: 0, restored: [] },
    'Get-TuningSnapshots': { items: [], count: 0, latest: null },
  };
  const store = { ...defaults, ...overrides };
  const bridge = {
    call: vi.fn(async (_op: string, payload: { function: string; args: Record<string, unknown> }) => {
      calls.push({ fn: payload.function, args: payload.args });
      if (!(payload.function in store)) throw new Error(`unexpected ${payload.function}`);
      const value = store[payload.function];
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as PowerShellBridge;
  return { bridge, calls };
}

function handlerOf(specs: ReturnType<typeof resourceCapabilities>, id: string) {
  const spec = specs.find((item) => item.id === id);
  if (spec?.handler === undefined) throw new Error(`missing ${id}`);
  return spec.handler;
}

const L1 = { traceId: 't1', risk: 'L1' as const };
const L2 = { traceId: 't2', risk: 'L2' as const };

describe('resource.tune 计划', () => {
  it('R-01 可应用的 key → ready，且快照在 apply 之前建立', async () => {
    const { bridge, calls } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const out = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['explorer.menu-delay'] }, L1)) as {
      data: { planId: string; plan: { status: string; snapshotId: string; changes: unknown[] } };
      warnings: string[];
    };
    expect(out.data.plan.status).toBe('ready');
    expect(out.data.plan.snapshotId).toBe('11111111-1111-1111-1111-111111111111');
    expect(calls.map((c) => c.fn)).toEqual(['Get-TuningCatalog', 'New-TuningSnapshot']);
    expect(out.warnings[0]).toContain('回滚用 resource.tune.rollback');
  });

  it('R-02 未提权 + 需要管理员的 key → blocked 并说明原因', async () => {
    const { bridge } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const out = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['system.network-throttling'] }, L1)) as {
      data: { plan: { status: string; blockers: string[] } };
    };
    expect(out.data.plan.status).toBe('blocked');
    expect(out.data.plan.blockers[0]).toContain('管理员权限');
  });

  it('R-03 未知 key → blocked（目录是白名单，不接受任意注册表写入）', async () => {
    const { bridge } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const out = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['hack.anything'] }, L1)) as {
      data: { plan: { status: string; blockers: string[] } };
    };
    expect(out.data.plan.status).toBe('blocked');
    expect(out.data.plan.blockers[0]).toContain('未知 key');
  });

  it('R-04 blocked 计划执行 → PLAN_BLOCKED，不调用 apply', async () => {
    const { bridge, calls } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const planned = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['system.network-throttling'] }, L1)) as {
      data: { planId: string };
    };
    await expect(
      handlerOf(specs, 'resource.tune.apply')(
        { planId: planned.data.planId, keys: ['system.network-throttling'], confirm: true },
        L2,
      ),
    ).rejects.toMatchObject({ toolError: { code: 'PLAN_BLOCKED' } });
    expect(calls.some((c) => c.fn === 'Invoke-TuningApply')).toBe(false);
  });

  it('R-05 ready 计划执行 → 调用 apply，带 snapshotId 与回滚提示', async () => {
    const { bridge, calls } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const planned = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['explorer.menu-delay'] }, L1)) as {
      data: { planId: string };
    };
    const out = (await handlerOf(specs, 'resource.tune.apply')(
      { planId: planned.data.planId, keys: ['explorer.menu-delay'], confirm: true },
      L2,
    )) as { data: { appliedCount: number; rollbackHint: string }; effectState: string };

    const appliedCall = calls.find((c) => c.fn === 'Invoke-TuningApply');
    expect(appliedCall?.args['SnapshotId']).toBe('11111111-1111-1111-1111-111111111111');
    expect(out.data.rollbackHint).toContain('resource.tune.rollback');
    expect(out.effectState).toBe('committed');
  });

  it('R-06 keys 与预览不一致 → PLAN_MISMATCH', async () => {
    const { bridge } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const planned = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['explorer.menu-delay'] }, L1)) as {
      data: { planId: string };
    };
    await expect(
      handlerOf(specs, 'resource.tune.apply')(
        { planId: planned.data.planId, keys: ['explorer.visual-effects'], confirm: true },
        L2,
      ),
    ).rejects.toMatchObject({ toolError: { code: 'PLAN_MISMATCH' } });
  });

  it('R-07 planId 一次性', async () => {
    const { bridge } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const planned = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['explorer.menu-delay'] }, L1)) as {
      data: { planId: string };
    };
    const params = { planId: planned.data.planId, keys: ['explorer.menu-delay'], confirm: true };
    await handlerOf(specs, 'resource.tune.apply')(params, L2);
    await expect(handlerOf(specs, 'resource.tune.apply')(params, L2)).rejects.toMatchObject({
      toolError: { code: 'PLAN_NOT_FOUND' },
    });
  });

  it('R-08 部分失败 → effectState=unknown 并提示可回滚', async () => {
    const { bridge } = fakeBridge({
      'Invoke-TuningApply': { appliedCount: 1, failedCount: 1, failures: [{ key: 'x', code: 'ADMIN_REQUIRED' }] },
    });
    const specs = resourceCapabilities(bridge);
    const planned = (await handlerOf(specs, 'resource.tune.plan')({ keys: ['explorer.menu-delay'] }, L1)) as {
      data: { planId: string };
    };
    const out = (await handlerOf(specs, 'resource.tune.apply')(
      { planId: planned.data.planId, keys: ['explorer.menu-delay'], confirm: true },
      L2,
    )) as { effectState: string; warnings?: string[] };
    expect(out.effectState).toBe('unknown');
    expect(out.warnings?.[0]).toContain('可用快照回滚');
  });

  it('R-09 rollback 把 snapshotId 透传给后端', async () => {
    const { bridge, calls } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    await handlerOf(specs, 'resource.tune.rollback')({ snapshotId: '22222222-2222-2222-2222-222222222222' }, L2);
    expect(calls[0]?.args['SnapshotId']).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('R-10 rollback 的错误码透传（路径注入 → INVALID_PARAMS）', async () => {
    const error = Object.assign(new Error('INVALID_PARAMS: snapshotId 必须是 GUID'), { code: 'INVALID_PARAMS' });
    const { bridge } = fakeBridge({ 'Restore-TuningSnapshot': error });
    const specs = resourceCapabilities(bridge);
    await expect(
      handlerOf(specs, 'resource.tune.rollback')({ snapshotId: 'C:\\Windows\\win.ini' }, L2),
    ).rejects.toMatchObject({ toolError: { code: 'INVALID_PARAMS' } });
  });

  it('R-11 catalog / snapshots 只读能力可调用', async () => {
    const { bridge } = fakeBridge();
    const specs = resourceCapabilities(bridge);
    const catalog = (await handlerOf(specs, 'resource.tune.catalog')({}, L1)) as { data: { count: number; elevated: boolean } };
    expect(catalog.data.elevated).toBe(false);
    const snapshots = (await handlerOf(specs, 'resource.tune.snapshots')({ maxItems: 5 }, L1)) as {
      data: { count: number };
    };
    expect(snapshots.data.count).toBe(0);
  });
});