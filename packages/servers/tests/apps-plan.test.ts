import { describe, expect, it, vi } from 'vitest';
import type { PowerShellBridge } from '@win-mcp/core';
import { appsCapabilities } from '../src/apps/capabilities.js';
import { buildWingetPlan } from '../src/apps/plan.js';

/** 假桥：按函数名返回预置数据，记录调用 */
function fakeBridge(responses: Record<string, unknown>): { bridge: PowerShellBridge; calls: string[] } {
  const calls: string[] = [];
  const bridge = {
    call: vi.fn(async (_op: string, payload: { function: string }) => {
      calls.push(payload.function);
      if (!(payload.function in responses)) throw new Error(`unexpected call ${payload.function}`);
      return responses[payload.function];
    }),
  } as unknown as PowerShellBridge;
  return { bridge, calls };
}

function installed(ids: string[]): { available: boolean; version: string; packages: { id: string; installed: boolean }[] } {
  return { available: true, version: 'v1.11', packages: ids.map((id) => ({ id, installed: true })) };
}

describe('winget 计划三分支（纯函数）', () => {
  const base = { operation: 'install' as const, wingetAvailable: true, wingetVersion: 'v1.11' };

  it('A-01 已安装 → no-changes', () => {
    const plan = buildWingetPlan({ ...base, ids: ['A.B'], installed: [{ id: 'A.B' }] });
    expect(plan.status).toBe('no-changes');
    expect(plan.supported).toBe(true);
    expect(plan.changes).toHaveLength(0);
    expect(plan.noChanges[0]).toMatchObject({ id: 'A.B' });
  });

  it('A-02 未安装 + install → ready', () => {
    const plan = buildWingetPlan({ ...base, ids: ['A.B'], installed: [] });
    expect(plan.status).toBe('ready');
    expect(plan.changes).toEqual([{ id: 'A.B', action: 'install', reason: expect.any(String) }]);
    expect(plan.unverified).toContain('A.B');
  });

  it('A-03 winget 不可用 → blocked 且整份拒绝', () => {
    const plan = buildWingetPlan({ ...base, wingetAvailable: false, ids: ['A.B'], installed: [] });
    expect(plan.status).toBe('blocked');
    expect(plan.supported).toBe(false);
    expect(plan.blockers.join()).toContain('winget 不可用');
  });

  it('A-04 显示名（含空格）→ blocked', () => {
    const plan = buildWingetPlan({ ...base, ids: ['Visual Studio Code'], installed: [] });
    expect(plan.status).toBe('blocked');
    expect(plan.blockers.join()).toContain('含空格');
  });

  it('A-05 卸载未安装的包 → no-changes', () => {
    const plan = buildWingetPlan({ ...base, operation: 'uninstall', ids: ['A.B'], installed: [] });
    expect(plan.status).toBe('no-changes');
  });

  it('A-06 卸载已安装的包 → ready', () => {
    const plan = buildWingetPlan({ ...base, operation: 'uninstall', ids: ['A.B'], installed: [{ id: 'A.B' }] });
    expect(plan.status).toBe('ready');
    expect(plan.changes[0]?.action).toBe('uninstall');
  });

  it('A-07 混合：一个已装一个未装 → ready 且各自归类', () => {
    const plan = buildWingetPlan({ ...base, ids: ['A.B', 'C.D'], installed: [{ id: 'A.B' }] });
    expect(plan.status).toBe('ready');
    expect(plan.changes.map((c) => c.id)).toEqual(['C.D']);
    expect(plan.noChanges.map((c) => c.id)).toEqual(['A.B']);
  });

  it('A-08 大小写不同也算已安装', () => {
    const plan = buildWingetPlan({ ...base, ids: ['a.b'], installed: [{ id: 'A.B' }] });
    expect(plan.status).toBe('no-changes');
  });

  it('A-09 空 ids → blocked', () => {
    const plan = buildWingetPlan({ ...base, ids: [], installed: [] });
    expect(plan.status).toBe('blocked');
  });

  it('A-10 install 标记需要管理员', () => {
    expect(buildWingetPlan({ ...base, ids: ['A.B'], installed: [] }).requiresAdministrator).toBe(true);
    expect(buildWingetPlan({ ...base, operation: 'uninstall', ids: ['A.B'], installed: [{ id: 'A.B' }] }).requiresAdministrator).toBe(false);
  });
});

describe('apps.winget.plan / apply 能力', () => {
  const ctx = { traceId: 't1', risk: 'L1' as const };

  function find(specs: ReturnType<typeof appsCapabilities>, id: string) {
    const spec = specs.find((item) => item.id === id);
    if (spec?.handler === undefined) throw new Error(`missing ${id}`);
    return spec.handler;
  }

  it('A-11 plan 返回 planId 且不执行任何 winget 写操作', async () => {
    const { bridge, calls } = fakeBridge({
      'Get-WingetInstalledState': installed([]),
    });
    const specs = appsCapabilities(bridge);
    const data = (await find(specs, 'apps.winget.plan')({ operation: 'install', ids: ['A.B'] }, ctx)) as {
      data: { planId: string; plan: { status: string } };
    };
    expect(data.data.planId.length).toBeGreaterThan(8);
    expect(data.data.plan.status).toBe('ready');
    expect(calls).toEqual(['Get-WingetInstalledState']);
  });

  it('A-12 apply：blocked 计划 → PLAN_BLOCKED，不调用 winget', async () => {
    const { bridge, calls } = fakeBridge({
      'Get-WingetInstalledState': { available: false, version: '', packages: [] },
    });
    const specs = appsCapabilities(bridge);
    const planned = (await find(specs, 'apps.winget.plan')({ operation: 'install', ids: ['A.B'] }, ctx)) as {
      data: { planId: string };
    };
    await expect(
      find(specs, 'apps.winget.apply')(
        { planId: planned.data.planId, operation: 'install', ids: ['A.B'], confirm: true },
        { traceId: 't2', risk: 'L2' },
      ),
    ).rejects.toMatchObject({ toolError: { code: 'PLAN_BLOCKED' } });
    expect(calls).toEqual(['Get-WingetInstalledState']);
  });

  it('A-13 apply：no-changes 计划 → NO_CHANGES 且零执行', async () => {
    const { bridge, calls } = fakeBridge({
      'Get-WingetInstalledState': installed(['A.B']),
    });
    const specs = appsCapabilities(bridge);
    const planned = (await find(specs, 'apps.winget.plan')({ operation: 'install', ids: ['A.B'] }, ctx)) as {
      data: { planId: string };
    };
    const outcome = (await find(specs, 'apps.winget.apply')(
      { planId: planned.data.planId, operation: 'install', ids: ['A.B'], confirm: true },
      { traceId: 't2', risk: 'L2' },
    )) as { data: { status: string; executed: number }; warnings?: string[] };
    expect(outcome.data.status).toBe('no-changes');
    expect(outcome.data.executed).toBe(0);
    expect(calls).toEqual(['Get-WingetInstalledState']);
    expect(outcome.warnings?.[0]).toContain('未执行任何操作');
  });

  it('A-14 apply：planId 复用（一次性）→ PLAN_NOT_FOUND', async () => {
    const { bridge } = fakeBridge({ 'Get-WingetInstalledState': installed(['A.B']) });
    const specs = appsCapabilities(bridge);
    const planned = (await find(specs, 'apps.winget.plan')({ operation: 'install', ids: ['A.B'] }, ctx)) as {
      data: { planId: string };
    };
    const params = { planId: planned.data.planId, operation: 'install', ids: ['A.B'], confirm: true };
    await find(specs, 'apps.winget.apply')(params, { traceId: 't2', risk: 'L2' });
    await expect(find(specs, 'apps.winget.apply')(params, { traceId: 't3', risk: 'L2' })).rejects.toMatchObject({
      toolError: { code: 'PLAN_NOT_FOUND' },
    });
  });

  it('A-15 apply：参数与预览不一致 → PLAN_MISMATCH', async () => {
    const { bridge } = fakeBridge({ 'Get-WingetInstalledState': installed(['A.B']) });
    const specs = appsCapabilities(bridge);
    const planned = (await find(specs, 'apps.winget.plan')({ operation: 'install', ids: ['A.B'] }, ctx)) as {
      data: { planId: string };
    };
    await expect(
      find(specs, 'apps.winget.apply')(
        { planId: planned.data.planId, operation: 'install', ids: ['A.B', 'C.D'], confirm: true },
        { traceId: 't2', risk: 'L2' },
      ),
    ).rejects.toMatchObject({ toolError: { code: 'PLAN_MISMATCH' } });
  });

  it('A-16 apply：真实执行路径逐项记录，失败不中断后续', async () => {
    const call = vi.fn(async (_op: string, payload: { function: string; args: Record<string, unknown> }) => {
      if (payload.function === 'Get-WingetInstalledState') return { available: true, version: 'v1', packages: [] };
      if (payload.function === 'Invoke-WingetAction') {
        const target = String(payload.args['Target']);
        if (target === 'B.C') throw new Error('installer failed');
        return { ok: true, exitCode: 0, text: `installed ${target}` };
      }
      throw new Error(`unexpected ${payload.function}`);
    });
    const specs = appsCapabilities({ call } as unknown as PowerShellBridge);
    const planned = (await find(specs, 'apps.winget.plan')({ operation: 'install', ids: ['A.B', 'B.C'] }, ctx)) as {
      data: { planId: string };
    };
    const outcome = (await find(specs, 'apps.winget.apply')(
      { planId: planned.data.planId, operation: 'install', ids: ['A.B', 'B.C'], confirm: true },
      { traceId: 't2', risk: 'L2' },
    )) as {
      data: { status: string; executed: number; failed: number; results: { id: string; ok: boolean }[] };
      effectState?: string;
      warnings?: string[];
    };
    expect(outcome.data.executed).toBe(2);
    expect(outcome.data.failed).toBe(1);
    expect(outcome.data.status).toBe('partially-applied');
    expect(outcome.effectState).toBe('unknown');
    expect(outcome.warnings?.[0]).toContain('不要盲目重试');
  });
});