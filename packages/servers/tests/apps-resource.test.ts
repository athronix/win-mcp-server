import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  AuditChain,
  CapabilityRegistry,
  DEFAULT_POLICY,
  PolicyEngine,
  PowerShellBridge,
  ToolGate,
  type Capability,
  type CapabilityResult,
  type ToolEnvelope,
} from '@win-mcp/core';
import { appsCapabilities } from '../src/apps/capabilities.js';
import { resourceCapabilities } from '../src/resource/capabilities.js';

function hasPwsh(): boolean {
  try {
    execFileSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

const available = hasPwsh();
const suite = available ? describe : describe.skip;

let bridge: PowerShellBridge | undefined;
let registry: CapabilityRegistry;

function makeGate(): { gate: ToolGate; store: ApprovalStore } {
  let counter = 0;
  const store = new ApprovalStore({ idFactory: () => `apr_ar_${(counter += 1)}` });
  const gate = new ToolGate({
    policy: new PolicyEngine(DEFAULT_POLICY),
    store,
    audit: new AuditChain({ secret: 'apps-resource-test' }),
  });
  return { gate, store };
}

async function invoke(
  gate: ToolGate,
  capability: Capability,
  params: Record<string, unknown> = {},
): Promise<{ envelope: ToolEnvelope; executed: boolean }> {
  return gate.run({ capability, params }, async (rest, ctx): Promise<CapabilityResult> => {
    if (capability.handler === undefined) throw new Error('capability has no handler');
    return capability.handler(rest, { traceId: ctx.traceId, risk: ctx.risk });
  });
}

beforeAll(async () => {
  if (!available) return;
  bridge = new PowerShellBridge({ requestTimeoutMs: 180_000, startTimeoutMs: 20_000 });
  await bridge.start();
  registry = new CapabilityRegistry();
  registry.registerAll(appsCapabilities(bridge));
  registry.registerAll(resourceCapabilities(bridge));
}, 60_000);

afterAll(async () => {
  await bridge?.stop();
});

describe('CL-005/006 能力定义', () => {
  it('C-01 apps 8 个、resource 9 个，ID 全部三段式', () => {
    const filler = new PowerShellBridge();
    const apps = appsCapabilities(filler);
    const resource = resourceCapabilities(filler);
    expect(apps).toHaveLength(8);
    expect(resource).toHaveLength(9);
    for (const cap of [...apps, ...resource]) {
      expect(cap.id).toMatch(/^(apps|resource)\.[a-z-]+\.[a-z-]+$/);
    }
  });

  it('C-02 写操作为 L2', () => {
    const filler = new PowerShellBridge();
    const byId = new Map([...appsCapabilities(filler), ...resourceCapabilities(filler)].map((c) => [c.id, c]));
    expect(byId.get('apps.winget.install')?.risk).toBe('L2');
    expect(byId.get('apps.winget.uninstall')?.risk).toBe('L2');
    expect(byId.get('resource.cleanup.execute')?.risk).toBe('L2');
  });
});

suite('CL-005/006 真机', () => {
  it('A-01 apps.list.installed 返回真实应用', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('apps.list.installed')!, { maxItems: 5 });
    const data = envelope.data as { count: number; totalMatched: number };
    expect(data.totalMatched).toBeGreaterThan(0);
    expect(data.count).toBeLessThanOrEqual(5);
  }, 60_000);

  it('A-02 apps.winget.info 返回可用性', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('apps.winget.info')!);
    const data = envelope.data as { available: boolean };
    expect(typeof data.available).toBe('boolean');
  }, 30_000);

  it('A-03 apps.winget.install 首次拦截为 APPROVAL_REQUIRED（不执行）', async () => {
    const { gate, store } = makeGate();
    const { envelope, executed } = await invoke(gate, registry.get('apps.winget.install')!, {
      id: 'Microsoft.VisualStudioCode',
    });
    expect(executed).toBe(false);
    expect(envelope.error?.code).toBe('APPROVAL_REQUIRED');
    expect(store.size).toBe(1);
  }, 30_000);

  it('R-01 resource.metrics.get 返回合理指标', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('resource.metrics.get')!);
    const data = envelope.data as { cpuPercent: number; memoryUsedPercent: number; processCount: number };
    expect(data.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(data.cpuPercent).toBeLessThanOrEqual(100);
    expect(data.memoryUsedPercent).toBeGreaterThanOrEqual(0);
    expect(data.memoryUsedPercent).toBeLessThanOrEqual(100);
    expect(data.processCount).toBeGreaterThan(0);
  }, 40_000);

  it('R-02 resource.disk.space 返回卷信息', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('resource.disk.space')!);
    const data = envelope.data as { count: number; items: { drive: string }[] };
    expect(data.count).toBeGreaterThan(0);
    expect(data.items[0]!.drive).toMatch(/^[A-Z]:$/);
  }, 30_000);

  it('R-03 resource.cleanup.analyze 只读统计', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('resource.cleanup.analyze')!);
    const data = envelope.data as { count: number; totalMB: number };
    expect(data.count).toBeGreaterThan(0);
    expect(data.totalMB).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('R-04 resource.cleanup.execute 首次拦截为 APPROVAL_REQUIRED（不删除）', async () => {
    const { gate } = makeGate();
    const { envelope, executed } = await invoke(gate, registry.get('resource.cleanup.execute')!, {});
    expect(executed).toBe(false);
    expect(envelope.error?.code).toBe('APPROVAL_REQUIRED');
  }, 30_000);
});