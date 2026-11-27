import { describe, expect, it, vi } from 'vitest';
import type { PowerShellBridge } from '@win-mcp/core';
import { desktopCapabilities } from '../src/desktop/capabilities.js';

function fakeBridge(responses: Record<string, unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const bridge = {
    call: vi.fn(async (_op: string, payload: { function: string; args: Record<string, unknown> }) => {
      calls.push({ fn: payload.function, args: payload.args });
      if (!(payload.function in responses)) throw new Error(`unexpected ${payload.function}`);
      const value = responses[payload.function];
      if (value instanceof Error) throw value;
      return value;
    }),
  } as unknown as PowerShellBridge;
  return { bridge, calls };
}

function handlerOf(specs: ReturnType<typeof desktopCapabilities>, id: string) {
  const spec = specs.find((item) => item.id === id);
  if (spec?.handler === undefined) throw new Error(`missing ${id}`);
  return spec.handler;
}

const ctx = { traceId: 't', risk: 'L0' as const };

describe('desktop.ui.watch（跨请求等待）', () => {
  const armResult = { watchId: 'w-1', alreadyMet: false, window: { handle: 1 }, visited: 12 };

  it('W-01 arm 透传条件并返回 watchId', async () => {
    const { bridge, calls } = fakeBridge({ 'Start-UiWatch': armResult });
    const specs = desktopCapabilities(bridge);
    const out = (await handlerOf(specs, 'desktop.ui.watch')(
      { action: 'arm', handle: -1, text: 'Notepad', maxDepth: 2, ttlMinutes: 5 },
      ctx,
    )) as { data: { watchId: string } };
    expect(out.data.watchId).toBe('w-1');
    expect(calls[0]?.args).toMatchObject({ Handle: -1, Text: 'Notepad', MaxDepth: 2, TtlMinutes: 5 });
  });

  it('W-02 arm 时条件已满足 → 带 warning', async () => {
    const { bridge } = fakeBridge({ 'Start-UiWatch': { ...armResult, alreadyMet: true } });
    const specs = desktopCapabilities(bridge);
    const out = (await handlerOf(specs, 'desktop.ui.watch')({ action: 'arm', text: 'x' }, ctx)) as {
      warnings?: string[];
    };
    expect(out.warnings?.[0]).toContain('已满足');
  });

  it('W-03 status 必须带 watchId', async () => {
    const { bridge } = fakeBridge({});
    const specs = desktopCapabilities(bridge);
    await expect(handlerOf(specs, 'desktop.ui.watch')({ action: 'status' }, ctx)).rejects.toMatchObject({
      toolError: { code: 'INVALID_PARAMS' },
    });
  });

  it('W-04 status 把未命中结果原样返回', async () => {
    const { bridge } = fakeBridge({ 'Get-UiWatchStatus': { watchId: 'w-1', matched: false, waitedMs: 800, checks: 3 } });
    const specs = desktopCapabilities(bridge);
    const out = (await handlerOf(specs, 'desktop.ui.watch')({ action: 'status', watchId: 'w-1' }, ctx)) as {
      data: { matched: boolean; checks: number };
    };
    expect(out.data).toMatchObject({ matched: false, checks: 3 });
  });

  it('W-05 cancel / list 分派到对应函数', async () => {
    const { bridge, calls } = fakeBridge({
      'Stop-UiWatch': { watchId: 'w-1', stopped: true },
      'Get-UiWatchList': { items: [], count: 0 },
    });
    const specs = desktopCapabilities(bridge);
    await handlerOf(specs, 'desktop.ui.watch')({ action: 'cancel', watchId: 'w-1' }, ctx);
    await handlerOf(specs, 'desktop.ui.watch')({ action: 'list' }, ctx);
    expect(calls.map((c) => c.fn)).toEqual(['Stop-UiWatch', 'Get-UiWatchList']);
  });

  it('W-06 桥的领域错误码透传（未知 watchId）', async () => {
    const error = Object.assign(new Error('INVALID_PARAMS: 未知 watchId'), { code: 'INVALID_PARAMS' });
    const { bridge } = fakeBridge({ 'Get-UiWatchStatus': error });
    const specs = desktopCapabilities(bridge);
    await expect(
      handlerOf(specs, 'desktop.ui.watch')({ action: 'status', watchId: 'gone' }, ctx),
    ).rejects.toMatchObject({ toolError: { code: 'INVALID_PARAMS' } });
  });
});
