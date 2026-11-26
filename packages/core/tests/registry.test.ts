import { describe, expect, it } from 'vitest';
import { cap, groupByDomain, InvalidCapabilityIdError } from '../src/registry/cap.js';
import { CapabilityRegistry } from '../src/registry/registry.js';

const base = {
  id: 'system.info.get',
  name: '系统信息',
  description: '读取系统信息',
  risk: 'L0' as const,
};

describe('FR-101 能力注册与归一化', () => {
  it('R-01 三段式 ID 合法', () => {
    const c = cap(base);
    expect(c.id).toBe('system.info.get');
    expect(c.domain).toBe('system');
  });

  it('R-02 缺段非法', () => {
    expect(() => cap({ ...base, id: 'system.info' })).toThrow(InvalidCapabilityIdError);
  });

  it('R-03 未知域非法', () => {
    expect(() => cap({ ...base, id: 'foo.bar.baz' })).toThrow(/未知域/);
  });

  it('R-04 大写与空格非法', () => {
    expect(() => cap({ ...base, id: 'System.Info.Get' })).toThrow(InvalidCapabilityIdError);
    expect(() => cap({ ...base, id: 'system.info. get' })).toThrow(InvalidCapabilityIdError);
  });

  it('R-05 默认值归一', () => {
    const c = cap(base);
    expect(c.idempotent).toBe(false);
    expect(c.requiresSession).toBe(false);
    expect(c.destructive).toBe(false);
    expect(c.dynamicRisk).toBe(false);
    expect(c.policyControl).toBe(false);
    expect(c.timeoutMs).toBe(30_000);
    expect(c.snapshot).toBe('none');
    expect(c.inputSchema).toEqual({});
  });

  it('R-06 destructivePath 附加命令黑名单兜底', () => {
    const c = cap({ ...base, id: 'system.dir.delete', destructivePath: true });
    expect(c.policy?.commandDenylist).toEqual(
      expect.arrayContaining(['\\bdel\\s+/s\\s+/q', '\\brm\\s+-rf']),
    );
  });

  it('R-07 重复注册抛错', () => {
    const registry = new CapabilityRegistry();
    registry.register(base);
    expect(() => registry.register(base)).toThrow(/DUPLICATE_CAPABILITY/);
  });

  it('R-08 按域分组', () => {
    const registry = new CapabilityRegistry();
    registry.registerAll([
      { ...base, id: 'system.info.get' },
      { ...base, id: 'system.time.get' },
      { ...base, id: 'apps.list.get', risk: 'L0' },
      { ...base, id: 'apps.winget.search', risk: 'L0' },
      { ...base, id: 'shell.cmd.analyze', risk: 'L0' },
      { ...base, id: 'shell.cmd.invoke', risk: 'L2' },
    ]);
    expect(registry.size).toBe(6);
    expect(registry.byDomain('system')).toHaveLength(2);
    expect(registry.byDomain('apps')).toHaveLength(2);
    const grouped = groupByDomain(registry.list());
    expect(grouped.get('shell')).toHaveLength(2);
  });

  it('R-09 L0 自动推导 readOnlyHint', () => {
    const c = cap(base);
    expect(c.annotations.readOnlyHint).toBe(true);
    expect(c.annotations.destructiveHint).toBe(false);
  });

  it('R-10 静态 risk 与 readOnly 冲突即失败', () => {
    expect(() => cap({ ...base, risk: 'L2', annotations: { readOnlyHint: true } })).toThrow(
      /INVALID_CAPABILITY_DEFINITION/,
    );
  });
});