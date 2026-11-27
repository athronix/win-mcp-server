import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  AuditChain,
  CapabilityRegistry,
  DEFAULT_POLICY,
  PolicyEngine,
  PowerShellBridge,
  ToolGate,
  unclassifiedCapabilities,
  type Capability,
  type CapabilityResult,
  type ToolEnvelope,
} from '@win-mcp/core';
import { browserCapabilities } from '../src/browser/capabilities.js';
import { desktopCapabilities } from '../src/desktop/capabilities.js';

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
const tempFiles: string[] = [];

function makeGate(): { gate: ToolGate; store: ApprovalStore } {
  let counter = 0;
  const store = new ApprovalStore({ idFactory: () => `apr_db_${(counter += 1)}` });
  const gate = new ToolGate({
    policy: new PolicyEngine(DEFAULT_POLICY),
    store,
    audit: new AuditChain({ secret: 'desktop-browser-test' }),
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
  bridge = new PowerShellBridge({ requestTimeoutMs: 60_000, startTimeoutMs: 20_000 });
  await bridge.start();
  registry = new CapabilityRegistry();
  registry.registerAll(desktopCapabilities(bridge));
  registry.registerAll(browserCapabilities(bridge));
}, 60_000);

afterAll(async () => {
  for (const file of tempFiles) {
    try {
      if (existsSync(file)) rmSync(file, { force: true });
    } catch {
      // 忽略清理失败
    }
  }
  await bridge?.stop();
});

describe('CL-007/008 能力定义', () => {
  it('D-01 desktop 10 个、browser 14 个，ID 三段式；桌面门控表覆盖全部 desktop 能力', () => {
    const filler = new PowerShellBridge();
    const desktop = desktopCapabilities(filler);
    const browser = browserCapabilities(filler);
    expect(desktop).toHaveLength(10);
    expect(browser).toHaveLength(14);
    for (const cap of [...desktop, ...browser]) {
      expect(cap.id).toMatch(/^(desktop|browser)\.[a-z-]+\.[a-z-]+$/);
    }
    // 新增 desktop 能力若忘记登记门控表，这里会直接失败（fail closed 的护栏）
    expect(unclassifiedCapabilities(desktop.map((cap) => cap.id))).toEqual([]);
  });

  it('D-02 键鼠类能力都是 L2 且有破坏性标注', () => {
    const filler = new PowerShellBridge();
    const byId = new Map(desktopCapabilities(filler).map((cap) => [cap.id, cap]));
    for (const id of ['desktop.ui.act', 'desktop.input.send']) {
      expect(byId.get(id)?.risk).toBe('L2');
      expect(byId.get(id)?.destructive).toBe(true);
    }
    expect(byId.get('desktop.control.policy')?.risk).toBe('L3');
    expect(byId.get('desktop.ui.snapshot')?.risk).toBe('L0');
  });

  it('D-02 窗口控制与书签写入为 L2', () => {
    const filler = new PowerShellBridge();
    const byId = new Map(
      [...desktopCapabilities(filler), ...browserCapabilities(filler)].map((c) => [c.id, c]),
    );
    expect(byId.get('desktop.window.control')?.risk).toBe('L2');
    expect(byId.get('browser.bookmark.add')?.risk).toBe('L2');
    expect(byId.get('browser.bookmark.delete')?.risk).toBe('L2');
  });
});

suite('CL-007 desktop 真机', () => {
  it('D-03 截屏返回 PNG 文件与尺寸', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('desktop.screen.capture')!, { maxWidth: 800 });
    const data = envelope.data as { path: string; width: number; height: number };
    expect(existsSync(data.path)).toBe(true);
    expect(data.width).toBeLessThanOrEqual(800);
    expect(data.height).toBeGreaterThan(0);
    tempFiles.push(data.path);
  }, 40_000);

  it('D-04 窗口列表至少返回一个窗口', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('desktop.window.list')!, { maxItems: 5 });
    const data = envelope.data as { count: number; totalVisible: number };
    expect(data.totalVisible).toBeGreaterThan(0);
    expect(data.count).toBeGreaterThan(0);
  }, 30_000);

  it('D-05 读剪贴板返回字符串（不写入，避免干扰用户）', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('desktop.clipboard.get')!);
    const data = envelope.data as { text: string; length: number };
    expect(typeof data.text).toBe('string');
    expect(data.length).toBe(data.text.length);
  }, 20_000);
});

suite('CL-008 browser 真机', () => {
  it('B-01 列出浏览器配置文件（可能为空）', async () => {
    const { gate } = makeGate();
    const { envelope } = await invoke(gate, registry.get('browser.profile.list')!);
    const data = envelope.data as { count: number; items: { profile: string }[] };
    expect(data.count).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('B-02 读取第一个配置的书签（无配置则跳过）', async () => {
    const { gate } = makeGate();
    const profiles = await invoke(gate, registry.get('browser.profile.list')!);
    const list = (profiles.envelope.data as { items: { profilePath?: string; bookmarksPath: string }[] }).items;
    if (list.length === 0) return;

    const bookmarksPath = list[0]!.bookmarksPath;
    const profilePath = bookmarksPath.replace(/[\\/]Bookmarks$/, '');
    const { envelope } = await invoke(gate, registry.get('browser.bookmark.list')!, {
      profilePath,
      maxItems: 10,
    });
    const data = envelope.data as { count: number; totalMatched: number };
    expect(data.totalMatched).toBeGreaterThanOrEqual(0);
    expect(data.count).toBeLessThanOrEqual(10);
  }, 40_000);

  it('B-03 添加书签首次拦截为 APPROVAL_REQUIRED（不写文件）', async () => {
    const { gate, store } = makeGate();
    const { envelope, executed } = await invoke(gate, registry.get('browser.bookmark.add')!, {
      profilePath: 'C:\\Users\\towyq\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
      name: 'win-mcp test',
      url: 'https://example.com/',
    });
    expect(executed).toBe(false);
    expect(envelope.error?.code).toBe('APPROVAL_REQUIRED');
    expect(store.size).toBe(1);
  }, 30_000);
});