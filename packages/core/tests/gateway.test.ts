import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../src/approval/store.js';
import { ToolGate } from '../src/approval/gate.js';
import { AuditChain } from '../src/audit/chain.js';
import { approvalEnvelope, failureEnvelope, RESUME_HINT, successEnvelope } from '../src/contracts/envelope.js';
import { makeError } from '../src/contracts/errors.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { CapabilityRegistry } from '../src/registry/registry.js';
import {
  MAX_INSTRUCTIONS_BYTES,
  createWinMcpServer,
  toCallResult,
} from '../src/transport/gateway.js';

function makeDeps() {
  return {
    policy: new PolicyEngine(),
    store: new ApprovalStore(),
    audit: new AuditChain(),
  };
}

describe('transport 语义（FR-108/109）', () => {
  it('G-T1 审批请求不置 isError（否则宿主会隐藏审批卡）', () => {
    const result = toCallResult(
      approvalEnvelope({
        traceId: 'tr_1',
        risk: 'L2',
        approval: {
          approvalId: 'apr_1',
          risk: 'L2',
          capabilityId: 'system.service.control',
          preview: {},
          impact: ['x'],
          resumeHint: RESUME_HINT,
          branch: 'local',
        },
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.error).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(result.content[0].type).toBe('text');
  });

  it('G-T2 策略拒绝置 isError=true', () => {
    const result = toCallResult(
      failureEnvelope({
        traceId: 'tr_1',
        risk: 'L2',
        error: makeError('POLICY_DENIED', 'denied'),
      }),
    );
    expect(result.isError).toBe(true);
  });

  it('G-T3 成功结果无 isError 且 structuredContent 完整', () => {
    const result = toCallResult(
      successEnvelope({ traceId: 'tr_1', risk: 'L0', data: { a: 1 }, auditRef: '1:abc' }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, traceId: 'tr_1' });
  });

  it('G-T4 instructions 超长即拒绝启动', () => {
    const registry = new CapabilityRegistry();
    const gate = new ToolGate(makeDeps());
    expect(() =>
      createWinMcpServer({
        name: 'x',
        version: '0.1.0',
        instructions: 'a'.repeat(MAX_INSTRUCTIONS_BYTES + 1),
        registry,
        gate,
      }),
    ).toThrow(/INSTRUCTIONS_TOO_LONG/);
  });

  it('G-T5 正常构造 McpServer', () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: 'system.info.get',
      name: '系统信息',
      description: '读取系统信息',
      risk: 'L0',
    });
    const gate = new ToolGate(makeDeps());
    const server = createWinMcpServer({
      name: 'win-mcp-test',
      version: '0.1.0',
      instructions: '测试用',
      registry,
      gate,
    });
    expect(server.isConnected()).toBe(false);
  });

  it('G-T6 非回环绑定被拒绝', async () => {
    const { startHttp } = await import('../src/transport/gateway.js');
    const registry = new CapabilityRegistry();
    const gate = new ToolGate(makeDeps());
    const server = createWinMcpServer({
      name: 'win-mcp-test',
      version: '0.1.0',
      instructions: '测试用',
      registry,
      gate,
    });
    expect(() => startHttp(server, { port: 0, host: '0.0.0.0' })).toThrow(/NON_LOOPBACK_BIND/);
  });
});