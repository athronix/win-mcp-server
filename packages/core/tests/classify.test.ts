import { describe, expect, it } from 'vitest';
import { analyzeCommand, isInUserScope } from '../src/classify/command.js';
import type { CommandParser, ParsedCommand } from '../src/classify/parser.js';

function analyze(command: string, extra: { runAsAdmin?: boolean } = {}) {
  return analyzeCommand({ command, homeDir: 'C:\\Users\\tester', ...extra });
}

describe('FR-102 操作分级', () => {
  it('C-01 只读命令 L0', () => {
    const r = analyze('Get-Process');
    expect(r.risk).toBe('L0');
    expect(r.blocked).toBe(false);
  });

  it('C-02 用户域写命令 L1', () => {
    const r = analyze('Set-Content -Path $env:USERPROFILE\\a.txt -Value x');
    expect(r.risk).toBe('L1');
    expect(r.paths).toContain('$env:USERPROFILE\\a.txt');
  });

  it('C-03 越界写升级 L2', () => {
    const r = analyze('Set-Content -Path C:\\Windows\\a.txt -Value x');
    expect(r.risk).toBe('L2');
    expect(r.riskReasons.join()).toMatch(/不在已证明的用户域/);
  });

  it('C-04 无明确路径的写升级 L2', () => {
    const r = analyze('Set-Content -Value x');
    expect(r.risk).toBe('L2');
  });

  it('C-05 破坏性命令 L2', () => {
    expect(analyze('Remove-Item foo.txt').risk).toBe('L2');
  });

  it('C-06 高危命令 L3', () => {
    expect(analyze('Restart-Computer').risk).toBe('L3');
  });

  it('C-07 stop-/restart- 前缀规则 L3', () => {
    expect(analyze('Stop-Service spooler').risk).toBe('L3');
  });

  it('C-08 未知命令按 L2 保守处理', () => {
    const r = analyze('MyCustomTool -x');
    expect(r.risk).toBe('L2');
    expect(r.warnings.join()).toMatch(/未知命令/);
  });

  it('C-09 机器级注册表路径升 L2', () => {
    expect(analyze('Get-Item HKLM:\\SYSTEM').risk).toBe('L2');
  });

  it('C-10 硬禁 iex', () => {
    const r = analyze('iex (New-Object Net.WebClient)');
    expect(r.blocked).toBe(true);
    expect(r.risk).toBe('L3');
    expect(r.blockReasons.join()).toMatch(/禁止模式|iex/i);
  });

  it('C-11 硬禁 -enc 外壳', () => {
    const r = analyze('powershell -enc QQBBAEkA');
    expect(r.blocked).toBe(true);
    expect(r.risk).toBe('L3');
  });

  it('C-12 硬禁 DownloadString', () => {
    const r = analyze("$c.DownloadString('http://example.com')");
    expect(r.blocked).toBe(true);
  });

  it('C-13 硬禁 exit', () => {
    const r = analyze('Write-Output 1; exit');
    expect(r.blocked).toBe(true);
  });

  it('C-14 提权 + 写 → L3', () => {
    const r = analyze('Set-Content a.txt -Value x', { runAsAdmin: true });
    expect(r.risk).toBe('L3');
  });

  it('C-15 提权 + 只读 → 至少 L2', () => {
    const r = analyze('Get-Process', { runAsAdmin: true });
    expect(r.risk).toBe('L2');
  });

  it('C-16 语法错误 fail-closed 为 L3', () => {
    const r = analyze('Get-Process -Name (');
    expect(r.syntaxValid).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.risk).toBe('L3');
    expect(r.parseErrors.length).toBeGreaterThan(0);
  });

  it('C-17 超长命令被拒', () => {
    const r = analyze(`Write-Output ${'a'.repeat(8001)}`);
    expect(r.blocked).toBe(true);
    expect(r.blockReasons.join()).toMatch(/命令过长/);
  });

  it('C-18 空命令被拒', () => {
    const r = analyze('   ');
    expect(r.blocked).toBe(true);
    expect(r.blockReasons).toContain('命令为空');
  });

  it('C-19 多命令取最大风险', () => {
    expect(analyze('Get-Process; Remove-Item a').risk).toBe('L2');
  });

  it('C-20 可注入 AST 解析器', () => {
    const parser: CommandParser = (command: string): ParsedCommand => ({
      syntaxValid: true,
      errors: [],
      commands: ['Get-Process'],
      paths: [],
      statementCount: 1,
      dynamicCalls: [],
      parser: 'powershell-ast',
    });
    const r = analyzeCommand({ command: 'anything', parser });
    expect(r.parser).toBe('powershell-ast');
    expect(r.risk).toBe('L0');
  });

  it('C-21 用户域判定', () => {
    expect(isInUserScope('$env:TEMP\\x.log', { homeDir: 'C:\\Users\\tester' })).toBe(true);
    expect(isInUserScope('C:\\Users\\tester\\a.txt', { homeDir: 'C:\\Users\\tester' })).toBe(true);
    expect(isInUserScope('C:\\Windows\\a.txt', { homeDir: 'C:\\Users\\tester' })).toBe(false);
  });

  it('C-22 解析器异常按 L3 拒绝', () => {
    const parser: CommandParser = () => {
      throw new Error('boom');
    };
    const r = analyzeCommand({ command: 'Get-Process', parser });
    expect(r.blocked).toBe(true);
    expect(r.risk).toBe('L3');
  });

  it('C-23 动态调用被拒', () => {
    const r = analyze('& $cmd');
    expect(r.blocked).toBe(true);
    expect(r.blockReasons.join()).toMatch(/动态命令调用/);
  });
});