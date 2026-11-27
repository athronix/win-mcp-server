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
import { systemCapabilities } from '../src/system/capabilities.js';

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

function makeGate(): { gate: ToolGate; store: ApprovalStore; audit: AuditChain } {
  let counter = 0;
  const store = new ApprovalStore({ idFactory: () => `apr_sys_${(counter += 1)}` });
  const audit = new AuditChain({ secret: 'system-test' });
  const gate = new ToolGate({ policy: new PolicyEngine(DEFAULT_POLICY), store, audit });
  return { gate, store, audit };
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
  bridge = new PowerShellBridge({ requestTimeoutMs: 40_000, startTimeoutMs: 20_000 });
  await bridge.start();
  registry = new CapabilityRegistry();
  registry.registerAll(systemCapabilities(bridge));
}, 60_000);

afterAll(async () => {
  await bridge?.stop();
});

describe('CL-003 win-system 能力定义', () => {
  it('S-01 注册 13 个能力且风险标注正确', () => {
    const filler = new PowerShellBridge();
    const caps = systemCapabilities(filler);
    expect(caps).toHaveLength(13);
    const byId = new Map(caps.map((item) => [item.id, item]));
    expect(byId.get('system.info.get')?.risk).toBe('L0');
    expect(byId.get('system.service.control')?.risk).toBe('L2');
    expect(byId.get('system.registry.write')?.risk).toBe('L2');
    expect(byId.get('system.process.terminate')?.risk).toBe('L2');
    for (const cap of caps) {
      expect(cap.id).toMatch(/^system\.[a-z-]+\.[a-z-]+$/);
    }
  });
});

suite('CL-003 win-system 真机', () => {
  it('S-02 system.info.get 直放并返回真实系统信息', async () => {
    const { gate } = makeGate();
    const capability = registry.get('system.info.get')!;
    const { envelope, executed } = await invoke(gate, capability);
    expect(executed).toBe(true);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as { os: string; cpuCores: number; elevated: boolean };
    expect(data.os.length).toBeGreaterThan(0);
    expect(data.cpuCores).toBeGreaterThan(0);
    expect(typeof data.elevated).toBe('boolean');
  }, 40_000);

  it('S-03 system.service.list 过滤有效', async () => {
    const { gate } = makeGate();
    const capability = registry.get('system.service.list')!;
    const { envelope } = await invoke(gate, capability, { filter: 'spool', maxItems: 5 });
    const data = envelope.data as { count: number; items: { name: string }[] };
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.items[0]!.name.toLowerCase()).toContain('spool');
  }, 30_000);

  it('S-04 system.service.control 首次拦截为 APPROVAL_REQUIRED 且未执行', async () => {
    const { gate, store } = makeGate();
    const capability = registry.get('system.service.control')!;
    const { envelope, executed } = await invoke(gate, capability, {
      name: 'Spooler',
      action: 'stop',
    });
    expect(executed).toBe(false);
    expect(envelope.error?.code).toBe('APPROVAL_REQUIRED');
    expect(envelope.approval?.approvalId).toBeDefined();
    expect(store.size).toBe(1);
  }, 30_000);

  it('S-05 受保护进程被策略拒绝（审批不可绕过）', async () => {
    const { gate } = makeGate();
    const capability = registry.get('system.process.terminate')!;
    const { envelope, executed } = await invoke(gate, capability, { name: 'lsass' });
    expect(executed).toBe(false);
    expect(envelope.error?.code).toBe('POLICY_DENIED');
    expect(envelope.approval).toBeUndefined();
  }, 20_000);

  it('S-06 HKLM 注册表写入被策略拒绝', async () => {
    const { gate } = makeGate();
    const capability = registry.get('system.registry.write')!;
    const { envelope } = await invoke(gate, capability, {
      path: 'HKLM:\\SOFTWARE\\WinMcpTest',
      name: 'x',
      value: '1',
    });
    expect(envelope.error?.code).toBe('POLICY_DENIED');
  }, 20_000);

  it('S-07 注册表读取返回真实值', async () => {
    const { gate } = makeGate();
    const capability = registry.get('system.registry.read')!;
    const { envelope } = await invoke(gate, capability, {
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    });
    const data = envelope.data as { exists: boolean; valueCount?: number };
    expect(data.exists).toBe(true);
    expect(data.valueCount).toBeGreaterThan(0);
  }, 30_000);
});