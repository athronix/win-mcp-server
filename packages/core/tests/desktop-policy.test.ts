import { describe, expect, it } from 'vitest';
import {
  CONTROL_FREE,
  controlClassOf,
  isControlPolicy,
  requiresControl,
  unclassifiedCapabilities,
} from '../src/desktop/control-policy.js';

describe('桌面控制门控表', () => {
  it('D-01 直接输入类归为 direct', () => {
    expect(controlClassOf('desktop.ui.act', { action: 'click' })).toBe('direct');
    expect(controlClassOf('desktop.input.send', { action: 'type' })).toBe('direct');
  });

  it('D-02 只读类归为 other', () => {
    expect(controlClassOf('desktop.ui.snapshot')).toBe('other');
    expect(controlClassOf('desktop.ui.wait')).toBe('other');
    expect(controlClassOf('desktop.ui.watch')).toBe('other');
    expect(controlClassOf('desktop.window.list')).toBe('other');
    expect(controlClassOf('desktop.input.send', { action: 'move' })).toBe('other');
  });

  it('D-03 mode 细分生效：close 是 possible，activate 是 direct', () => {
    expect(controlClassOf('desktop.window.control', { action: 'activate' })).toBe('direct');
    expect(controlClassOf('desktop.window.control', { action: 'close' })).toBe('possible');
  });

  it('D-04 未登记能力按 direct 处理（fail closed）', () => {
    expect(controlClassOf('desktop.brand.new')).toBe('direct');
  });

  it('D-05 mode 未登记时用 fallback', () => {
    expect(controlClassOf('desktop.input.send', { action: 'hold' })).toBe('direct');
    expect(controlClassOf('desktop.window.control', { action: 'snap' })).toBe('possible');
  });

  it('D-06 relaxed 只拦 direct', () => {
    expect(requiresControl('relaxed', 'desktop.ui.act', {})).toBe(true);
    expect(requiresControl('relaxed', 'desktop.clipboard.set')).toBe(false);
    expect(requiresControl('relaxed', 'desktop.ui.snapshot')).toBe(false);
  });

  it('D-07 balanced 拦 direct + possible', () => {
    expect(requiresControl('balanced', 'desktop.ui.act', {})).toBe(true);
    expect(requiresControl('balanced', 'desktop.clipboard.set')).toBe(true);
    expect(requiresControl('balanced', 'desktop.ui.snapshot')).toBe(false);
  });

  it('D-08 strict 除免检能力外一律拦', () => {
    expect(requiresControl('strict', 'desktop.ui.snapshot')).toBe(true);
    expect(requiresControl('strict', 'desktop.window.list')).toBe(true);
    expect(requiresControl('strict', 'desktop.control.state')).toBe(false);
  });

  it('D-09 免检能力在任何策略下都不拦，避免查状态本身要授权', () => {
    for (const policy of ['relaxed', 'balanced', 'strict'] as const) {
      for (const id of CONTROL_FREE) {
        expect(requiresControl(policy, id)).toBe(false);
      }
    }
  });

  it('D-10 未登记能力在 strict 之外也要求门控', () => {
    expect(requiresControl('relaxed', 'unknown.capability')).toBe(true);
    expect(requiresControl('balanced', 'unknown.capability')).toBe(true);
  });

  it('D-11 策略值校验', () => {
    expect(isControlPolicy('balanced')).toBe(true);
    expect(isControlPolicy('yolo')).toBe(false);
    expect(isControlPolicy(undefined)).toBe(false);
  });

  it('D-12 覆盖检查能报出未登记能力', () => {
    expect(unclassifiedCapabilities(['desktop.ui.act', 'desktop.ui.snapshot', 'desktop.ui.wait'])).toEqual([]);
    expect(unclassifiedCapabilities(['desktop.ui.act', 'desktop.mystery.act'])).toEqual(['desktop.mystery.act']);
  });
});