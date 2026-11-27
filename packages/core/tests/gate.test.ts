import { describe, expect, it, vi } from 'vitest';
import { ToolGate, type DynamicClassifier } from '../src/approval/gate.js';
import { ApprovalStore } from '../src/approval/store.js';
import { AuditChain } from '../src/audit/chain.js';
import type { CapabilitySpec } from '../src/contracts/capability.js';
import { DEFAULT_POLICY, mergePolicy, type PolicyConfig } from '../src/policy/defaults.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { cap } from '../src/registry/cap.js';

function makeGate(opts: { policy?: Partial<PolicyConfig>; classify?: DynamicClassifier } = {}) {
  let counter = 0;
  const store = new ApprovalStore({ ttlMs: 1000, idFactory: () => `apr_${(counter += 1)}` });
  const audit = new AuditChain({ secret: 'test' });
  const policy = new PolicyEngine(mergePolicy(DEFAULT_POLICY, opts.policy));
  const gate = new ToolGate({
    policy,
    store,
    audit,
    traceIdFactory: () => 'tr_test',
    ...(opts.classify !== undefined ? { classify: opts.classify } : {}),
  });
  return { gate, store, audit };
}

const l0Spec: CapabilitySpec = {
  id: 'system.info.get',
  name: '系统信息',
  description: '读取系统信息',
  risk: 'L0',
};

const l2Spec: CapabilitySpec = {
  id: 'system.service.control',
  name: '服务控制',
  description: '启动/停止服务',
  risk: 'L2',
};

const writeSpec: CapabilitySpec = {
  id: 'system.file.write',
  name: '写文件',
  description: '写入用户文件',
  risk: 'L1',
};

describe('ToolGate 审批编排（FR-104/109）', () => {
  it('T-01 L0 直放，不产生审批', async () => {
    const { gate, audit } = makeGate();
    const execute = vi.fn(async () => ({ data: { ok: true } }));
    const outcome = await gate.run({ capability: cap(l0Spec), params: {} }, execute);
    expect(outcome.executed).toBe(true);
    expect(outcome.envelope.ok).toBe(true);
    expect(outcome.envelope.approval).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(audit.verify().valid).toBe(true);
  });

  it('T-02 L2 首次拦截：不执行、返回 approvalId', async () => {
    const { gate, audit } = makeGate();
    const execute = vi.fn(async () => ({ data: {} }));
    const outcome = await gate.run({ capability: cap(l2Spec), params: { name: 'spooler' } }, execute);
    expect(outcome.executed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.envelope.ok).toBe(false);
    expect(outcome.envelope.error?.code).toBe('APPROVAL_REQUIRED');
    expect(outcome.envelope.approval?.approvalId).toBe('apr_1');
    expect(outcome.envelope.approval?.impact.length).toBeGreaterThan(0);
    expect(outcome.envelope.approval?.resumeHint).toMatch(/__approvalId/);
    expect(audit.entries().some((entry) => entry.outcome === 'approval_required')).toBe(true);
  });

  it('T-03 原样重发成功执行', async () => {
    const { gate } = makeGate();
    const execute = vi.fn(async () => ({ data: { stopped: true } }));
    const first = await gate.run({ capability: cap(l2Spec), params: { name: 'spooler' } }, execute);
    const approvalId = first.envelope.approval!.approvalId;
    const second = await gate.run(
      { capability: cap(l2Spec), params: { name: 'spooler', __approvalId: approvalId } },
      execute,
    );
    expect(second.executed).toBe(true);
    expect(second.envelope.ok).toBe(true);
    expect(second.envelope.auditRef).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('T-04 改参数即掉包', async () => {
    const { gate, audit } = makeGate();
    const execute = vi.fn(async () => ({ data: {} }));
    const first = await gate.run({ capability: cap(l2Spec), params: { name: 'spooler' } }, execute);
    const approvalId = first.envelope.approval!.approvalId;
    const tampered = await gate.run(
      {
        capability: cap(l2Spec),
        params: { name: 'spooler', force: true, __approvalId: approvalId },
      },
      execute,
    );
    expect(tampered.executed).toBe(false);
    expect(tampered.envelope.error?.code).toBe('APPROVAL_MISMATCH');
    expect(execute).not.toHaveBeenCalled();
    expect(audit.entries().some((entry) => entry.outcome === 'approval_mismatch')).toBe(true);
  });

  it('T-05 凭证一次性（二次使用失败）', async () => {
    const { gate } = makeGate();
    const execute = vi.fn(async () => ({ data: {} }));
    const first = await gate.run({ capability: cap(l2Spec), params: { name: 'spooler' } }, execute);
    const approvalId = first.envelope.approval!.approvalId;
    await gate.run(
      { capability: cap(l2Spec), params: { name: 'spooler', __approvalId: approvalId } },
      execute,
    );
    const replay = await gate.run(
      { capability: cap(l2Spec), params: { name: 'spooler', __approvalId: approvalId } },
      execute,
    );
    expect(replay.executed).toBe(false);
    expect(replay.envelope.error?.code).toBe('APPROVAL_MISMATCH');
  });

  it('T-06 硬禁在进审批链前失败，不返回 approvalId', async () => {
    const { gate } = makeGate({
      classify: () => ({
        risk: 'L3',
        preview: {},
        impact: [],
        blocked: { code: 'COMMAND_BLOCKED', message: '命中禁止模式：iex' },
      }),
    });
    const capability = cap({
      id: 'shell.cmd.invoke',
      name: '命令执行',
      description: '动态分级执行',
      risk: 'L1',
      dynamicRisk: true,
    });
    const execute = vi.fn(async () => ({ data: {} }));
    const outcome = await gate.run({ capability, params: { command: 'iex x' } }, execute);
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('COMMAND_BLOCKED');
    expect(outcome.envelope.approval).toBeUndefined();
    expect(outcome.envelope.risk).toBe('L3');
    expect(execute).not.toHaveBeenCalled();
  });

  it('T-07 策略拒绝不入审批（黑名单不可审批绕过）', async () => {
    const { gate } = makeGate();
    const execute = vi.fn(async () => ({ data: {} }));
    const outcome = await gate.run(
      { capability: cap({ ...writeSpec, risk: 'L2' }), params: { path: 'C:\\Windows\\x.txt' } },
      execute,
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('POLICY_DENIED');
    expect(outcome.envelope.approval).toBeUndefined();
  });

  it('T-08 放权强制审批，即使 autoApprove 已开启', async () => {
    const { gate } = makeGate({
      policy: { autoApprove: { enabled: true, maxRisk: 'L3' } },
    });
    const capability = cap({
      id: 'meta.policy.set',
      name: '策略设置',
      description: '调整自动批准策略',
      risk: 'L3',
      policyControl: true,
    });
    const apply = vi.fn(async () => ({ data: {} }));
    const outcome = await gate.runPolicyControl(
      {
        capability,
        params: { enabled: true, maxRisk: 'L3' },
        current: { enabled: false, maxRisk: 'L2' },
        target: { enabled: true, maxRisk: 'L3' },
      },
      apply,
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('APPROVAL_REQUIRED');
    expect(outcome.envelope.risk).toBe('L3');
    expect(outcome.envelope.approval?.impact.join()).toMatch(/放权操作已强制审批/);
    expect(apply).not.toHaveBeenCalled();
  });

  it('T-09 全流程后审计链完整', async () => {
    const { gate, audit } = makeGate();
    const execute = vi.fn(async () => ({ data: {} }));
    await gate.run({ capability: cap(l0Spec), params: {} }, execute);
    await gate.run({ capability: cap(l2Spec), params: {} }, execute);
    const verdict = audit.verify();
    expect(verdict.valid).toBe(true);
    expect(audit.entries().length).toBeGreaterThanOrEqual(2);
  });

  it('T-10 effectState 透传', async () => {
    const { gate } = makeGate();
    const outcome = await gate.run({ capability: cap(l0Spec), params: {} }, async () => ({
      data: {},
      effectState: 'unknown',
    }));
    expect(outcome.envelope.effectState).toBe('unknown');
  });

  it('T-11 policyControl 能力禁止走普通执行路径', async () => {
    const { gate } = makeGate();
    const capability = cap({
      id: 'meta.policy.set',
      name: '策略设置',
      description: '调整自动批准策略',
      risk: 'L3',
      policyControl: true,
    });
    const outcome = await gate.run({ capability, params: {} }, async () => ({ data: {} }));
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('INVALID_PARAMS');
  });

  it('T-12 动态能力缺少判级器时 fail-closed', async () => {
    const { gate } = makeGate();
    const capability = cap({
      id: 'shell.cmd.invoke',
      name: '命令执行',
      description: '动态分级执行',
      risk: 'L1',
      dynamicRisk: true,
    });
    const outcome = await gate.run({ capability, params: { command: 'Get-Process' } }, async () => ({
      data: {},
    }));
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('PREFLIGHT_UNAVAILABLE');
  });

  it('T-13 执行异常记为 failed 且链完整', async () => {
    const { gate, audit } = makeGate();
    const outcome = await gate.run({ capability: cap(l0Spec), params: {} }, async () => {
      throw new Error('boom');
    });
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('INTERNAL');
    expect(audit.entries().some((entry) => entry.outcome === 'failed')).toBe(true);
    expect(audit.verify().valid).toBe(true);
  });

  it('T-14 TIMEOUT 错误码识别', async () => {
    const { gate } = makeGate();
    const outcome = await gate.run({ capability: cap(l0Spec), params: {} }, async () => {
      const error = new Error('slow');
      error.name = 'TimeoutError';
      throw error;
    });
    expect(outcome.envelope.error?.code).toBe('TIMEOUT');
  });

  it('T-15 动态判级提供空路径证据时，命令文本里的路径不触发策略拒绝', async () => {
    const { gate } = makeGate({
      classify: () => ({ risk: 'L0', preview: {}, impact: [], paths: [] }),
    });
    const capability = cap({
      id: 'shell.cmd.invoke',
      name: '命令执行',
      description: '动态分级执行',
      risk: 'L1',
      dynamicRisk: true,
    });
    const outcome = await gate.run(
      { capability, params: { command: '# Remove-Item C:\\Windows\\x' } },
      async () => ({ data: { executed: true } }),
    );
    expect(outcome.executed).toBe(true);
    expect(outcome.envelope.error).toBeUndefined();
  });

  it('T-16 动态判级提供命中的路径证据时仍被策略拒绝', async () => {
    const { gate } = makeGate({
      classify: () => ({ risk: 'L3', preview: {}, impact: [], paths: ['C:\\Windows\\x'] }),
    });
    const capability = cap({
      id: 'shell.cmd.invoke',
      name: '命令执行',
      description: '动态分级执行',
      risk: 'L1',
      dynamicRisk: true,
    });
    const outcome = await gate.run(
      { capability, params: { command: 'Remove-Item C:\\Windows\\x' } },
      async () => ({ data: {} }),
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.envelope.error?.code).toBe('POLICY_DENIED');
  });
});