import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, mergePolicy } from '../src/policy/defaults.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { globToRegex, normalizePath, pathMatchesAny } from '../src/policy/glob.js';

const engine = new PolicyEngine();

describe('FR-103 策略判定', () => {
  it('P-01 ** 跨分隔符', () => {
    const re = globToRegex('C:\\Users\\**');
    expect(re.test('C:\\Users\\a\\b')).toBe(true);
  });

  it('P-02 * 不跨分隔符', () => {
    const re = globToRegex('C:\\Users\\*');
    expect(re.test('C:\\Users\\a\\b')).toBe(false);
    expect(re.test('C:\\Users\\a')).toBe(true);
  });

  it('P-03 目录自身匹配（补尾分隔符）', () => {
    expect(pathMatchesAny(normalizePath('C:\\Users'), [globToRegex('C:\\Users\\**')])).toBe(true);
  });

  it('P-04 大小写不敏感', () => {
    expect(globToRegex('C:\\Windows\\**').test('c:\\windows\\x')).toBe(true);
  });

  it('P-05 路径黑名单拒绝优先（不是审批）', () => {
    const v = engine.evaluate({
      capabilityId: 'system.file.delete',
      params: { path: 'C:\\Windows\\a.txt' },
      risk: 'L2',
      approved: false,
    });
    expect(v.allowed).toBe(false);
    expect(v.requiresApproval).toBe(false);
    expect(v.error?.code).toBe('POLICY_DENIED');
    expect(v.matchedRule).toBe('pathDenylist');
  });

  it('P-06 命令黑名单', () => {
    const v = engine.evaluate({
      capabilityId: 'shell.cmd.invoke',
      params: { command: 'Invoke-Expression $x' },
      risk: 'L2',
      approved: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.error?.code).toBe('POLICY_DENIED');
  });

  it('P-07 命令内嵌路径受路径策略约束', () => {
    const v = engine.evaluate({
      capabilityId: 'shell.cmd.invoke',
      params: { command: 'Get-ChildItem C:\\Windows' },
      risk: 'L0',
      approved: false,
    });
    expect(v.allowed).toBe(false);
    expect(v.matchedRule).toBe('pathDenylist');
  });

  it('P-08 注册表写默认仅 HKCU', () => {
    const denied = engine.evaluate({
      capabilityId: 'system.registry.write',
      params: { path: 'HKLM:\\SOFTWARE\\X' },
      risk: 'L2',
      approved: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.matchedRule).toBe('registryWriteAllowlist:miss');

    const allowed = engine.evaluate({
      capabilityId: 'system.registry.write',
      params: { path: 'HKCU:\\Software\\X' },
      risk: 'L2',
      approved: true,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('P-09 注册表读允许 HKLM\\SOFTWARE', () => {
    const v = engine.evaluate({
      capabilityId: 'system.registry.read',
      params: { path: 'HKLM:\\SOFTWARE\\Vendor\\App' },
      risk: 'L0',
      approved: false,
    });
    expect(v.allowed).toBe(true);
  });

  it('P-10 受保护进程禁止操作', () => {
    const v = engine.evaluate({
      capabilityId: 'system.process.terminate',
      params: { process: 'lsass' },
      risk: 'L2',
      approved: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.matchedRule).toBe('processDenylist');
  });

  it('P-11 风险封顶仅在显式声明 maxRisk 时生效', () => {
    const capped = engine.evaluate({
      capabilityId: 'system.power.control',
      params: {},
      risk: 'L3',
      approved: true,
      maxRisk: 'L2',
    });
    expect(capped.allowed).toBe(false);
    expect(capped.matchedRule).toBe('maxRisk:L2');

    const notCapped = engine.evaluate({
      capabilityId: 'system.power.control',
      params: {},
      risk: 'L3',
      approved: true,
    });
    expect(notCapped.allowed).toBe(true);
  });

  it('P-12 L2 未批准需审批', () => {
    const v = engine.evaluate({
      capabilityId: 'system.service.control',
      params: {},
      risk: 'L2',
      approved: false,
    });
    expect(v.allowed).toBe(false);
    expect(v.requiresApproval).toBe(true);
    expect(v.error?.code).toBe('APPROVAL_REQUIRED');
  });

  it('P-13 autoApprove 默认关闭', () => {
    expect(DEFAULT_POLICY.autoApprove.enabled).toBe(false);
  });

  it('P-14 autoApprove 只放行 <= 配置上限', () => {
    const auto = new PolicyEngine(
      mergePolicy(DEFAULT_POLICY, { autoApprove: { enabled: true, maxRisk: 'L2' } }),
    );
    const l2 = auto.evaluate({
      capabilityId: 'system.service.control',
      params: {},
      risk: 'L2',
      approved: false,
    });
    expect(l2.allowed).toBe(true);
    expect(l2.autoApproved).toBe(true);

    const l3 = auto.evaluate({
      capabilityId: 'system.power.control',
      params: {},
      risk: 'L3',
      approved: false,
    });
    expect(l3.allowed).toBe(false);
    expect(l3.requiresApproval).toBe(true);
  });

  it('P-15 forceApproval 覆盖 autoApprove', () => {
    const auto = new PolicyEngine(
      mergePolicy(DEFAULT_POLICY, { autoApprove: { enabled: true, maxRisk: 'L3' } }),
    );
    const v = auto.evaluate({
      capabilityId: 'meta.policy.set',
      params: {},
      risk: 'L3',
      approved: false,
      forceApproval: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.requiresApproval).toBe(true);
  });

  it('P-16 数组并集：用户无法删除红线', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { pathDenylist: [], processDenylist: [] });
    expect(merged.pathDenylist).toContain('C:\\Windows\\**');
    expect(merged.processDenylist).toContain('lsass');
  });

  it('P-17 非法能力 ID 直接拒绝', () => {
    const v = engine.evaluate({ capabilityId: 'bogus', params: {}, risk: 'L0', approved: false });
    expect(v.allowed).toBe(false);
    expect(v.matchedRule).toBe('capability:invalid-id');
  });

  it('P-18 命令白名单启用时未命中即拒绝', () => {
    const strict = new PolicyEngine(
      mergePolicy(DEFAULT_POLICY, { commandAllowlist: ['^Get-Process$'] }),
    );
    const denied = strict.evaluate({
      capabilityId: 'shell.cmd.invoke',
      params: { command: 'Get-Service' },
      risk: 'L0',
      approved: false,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.matchedRule).toBe('commandAllowlist:miss');

    const allowed = strict.evaluate({
      capabilityId: 'shell.cmd.invoke',
      params: { command: 'Get-Process' },
      risk: 'L0',
      approved: false,
    });
    expect(allowed.allowed).toBe(true);
  });

  it('P-19 路径白名单命中用户区放行', () => {
    const v = engine.evaluate({
      capabilityId: 'system.file.write',
      params: { path: 'C:\\Users\\tester\\a.txt' },
      risk: 'L1',
      approved: false,
    });
    expect(v.allowed).toBe(true);
  });

  it('P-20 路径白名单外拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'system.file.write',
      params: { path: 'E:\\Other\\a.txt' },
      risk: 'L1',
      approved: false,
    });
    expect(v.allowed).toBe(false);
    expect(v.matchedRule).toBe('pathAllowlist:miss');
  });
});