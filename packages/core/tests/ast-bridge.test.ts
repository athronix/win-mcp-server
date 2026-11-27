import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeCommandWithBridge,
  createBridgeClassifier,
  parseWithBridge,
} from '../src/bridge/ast.js';
import { PowerShellBridge } from '../src/bridge/bridge.js';
import { cap } from '../src/registry/cap.js';

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

beforeAll(async () => {
  if (!available) return;
  bridge = new PowerShellBridge({ requestTimeoutMs: 20_000, startTimeoutMs: 20_000 });
  await bridge.start();
}, 40_000);

afterAll(async () => {
  await bridge?.stop();
});

const shellCapability = cap({
  id: 'shell.cmd.invoke',
  name: '命令执行',
  description: '动态分级执行 PowerShell 命令',
  risk: 'L1',
  dynamicRisk: true,
});

suite('CL-002 真机 AST（需要 pwsh）', () => {
  it('R-01 info 返回版本与提权状态', async () => {
    const info = await bridge!.call<{ version: string; elevated: boolean; edition: string }>('info', {});
    expect(info.version).toMatch(/^\d+\.\d+/);
    expect(typeof info.elevated).toBe('boolean');
    expect(info.edition.length).toBeGreaterThan(0);
  });

  it('R-02 语法错误带行列号', async () => {
    const parsed = await parseWithBridge(bridge!, 'Get-Process -Name (');
    expect(parsed.syntaxValid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.line).toBeGreaterThan(0);
    expect(parsed.parser).toBe('powershell-ast');
  });

  it('R-03 注释与 here-string 不被当作命令（修复 fallback 误升）', async () => {
    const comment = await parseWithBridge(bridge!, '# Remove-Item C:\\Windows\\x');
    expect(comment.commands).toEqual([]);
    expect(comment.statementCount).toBe(0);

    const hereString = await parseWithBridge(bridge!, '@"\nRemove-Item C:\\Windows\\x\n"@');
    expect(hereString.commands).toEqual([]);
  });

  it('R-04 双引号路径被采集（ExpandableString）', async () => {
    const parsed = await parseWithBridge(
      bridge!,
      'Get-Item -Path "$env:USERPROFILE\\a.txt"',
    );
    expect(parsed.paths).toContain('$env:USERPROFILE\\a.txt');
  });

  it('R-05 动态调用被识别', async () => {
    const parsed = await parseWithBridge(bridge!, '$sb = 1; & $sb');
    expect(parsed.dynamicCalls.length).toBeGreaterThan(0);
    expect(parsed.commands).toEqual([]);
  });

  it('R-06 真 AST 判级：破坏性命令 L2', async () => {
    const analysis = await analyzeCommandWithBridge(bridge!, { command: 'Remove-Item foo.txt' });
    expect(analysis.parser).toBe('powershell-ast');
    expect(analysis.risk).toBe('L2');
    expect(analysis.blocked).toBe(false);
  });

  it('R-07 真 AST 判级：纯注释 L0（fallback 会误判 L2）', async () => {
    const analysis = await analyzeCommandWithBridge(bridge!, {
      command: '# Remove-Item C:\\Windows\\x',
    });
    expect(analysis.risk).toBe('L0');
    expect(analysis.blocked).toBe(false);
  });

  it('R-08 classifier 对硬禁命令返回 COMMAND_BLOCKED', async () => {
    const classifier = createBridgeClassifier(bridge!);
    const outcome = await classifier(shellCapability, { command: 'iex (New-Object Net.WebClient)' });
    expect(outcome.blocked?.code).toBe('COMMAND_BLOCKED');
    expect(outcome.risk).toBe('L3');
  });

  it('R-09 桥未启动时 classifier fail-closed 为 PREFLIGHT_UNAVAILABLE', async () => {
    const offline = new PowerShellBridge();
    const classifier = createBridgeClassifier(offline);
    const outcome = await classifier(shellCapability, { command: 'Get-Process' });
    expect(outcome.blocked?.code).toBe('PREFLIGHT_UNAVAILABLE');
  });

  it('R-10 提权只读命令升到至少 L2', async () => {
    const analysis = await analyzeCommandWithBridge(bridge!, {
      command: 'Get-Process',
      runAsAdmin: true,
    });
    expect(analysis.risk).toBe('L2');
  });

  it('R-11 注释命令经 classifier 返回空路径证据（供 policy 使用）', async () => {
    const classifier = createBridgeClassifier(bridge!);
    const outcome = await classifier(shellCapability, {
      command: '# Remove-Item C:\\Windows\\x',
    });
    expect(outcome.risk).toBe('L0');
    expect(outcome.paths).toEqual([]);
    expect(outcome.blocked).toBeUndefined();
  });

  it('R-12 真实路径命令经 classifier 返回路径证据', async () => {
    const classifier = createBridgeClassifier(bridge!);
    const outcome = await classifier(shellCapability, {
      command: 'Get-ChildItem C:\\Windows',
    });
    expect(outcome.paths).toContain('C:\\Windows');
  });
});