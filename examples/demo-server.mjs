#!/usr/bin/env node
/**
 * v0.1.0 底座演示 server（不执行任何真实系统写操作）
 *
 * 用途：
 * 1. 演示如何用 @win-mcp/core 组装一个 MCP server
 * 2. 作为 scripts/smoke.mjs 的被测目标
 *
 * 用法：
 *   node examples/demo-server.mjs            # stdio
 *   node examples/demo-server.mjs --http 8765 # streamable-HTTP + /health
 */
import os from 'node:os';
import {
  ApprovalStore,
  AuditChain,
  CapabilityRegistry,
  DEFAULT_POLICY,
  PolicyEngine,
  PowerShellBridge,
  ToolGate,
  analyzeCommand,
  createBridgeClassifier,
  createWinMcpServer,
  startHttp,
  startStdio,
} from '../packages/core/dist/index.js';

const INSTRUCTIONS = [
  'win-mcp-servers 底座演示 server。',
  '风险 >= L2 的工具首次调用会返回 APPROVAL_REQUIRED 与 approvalId，此时系统状态未改变。',
  '遇到 APPROVAL_REQUIRED 时，必须把 approval.impact / approval.preview 展示给用户；',
  '仅在用户明确批准后，用完全相同的参数加上 __approvalId 重发一次。参数有任何变化都会作废审批。',
  '硬禁命令（编码执行、iex、下载执行等）直接拒绝，不提供审批通道。',
].join('');

const registry = new CapabilityRegistry();
const policy = new PolicyEngine(DEFAULT_POLICY);
const store = new ApprovalStore();
const audit = new AuditChain();
let autoApproveState = { enabled: false, maxRisk: 'L2' };

/** 动态判级：把 analyzeCommand 的结果映射为 gate 需要的形状 */
function classifyShellCommand(_capability, params) {
  const command = typeof params.command === 'string' ? params.command : '';
  const analysis = analyzeCommand({
    command,
    runAsAdmin: params.runAsAdmin === true,
  });
  if (!analysis.syntaxValid) {
    return {
      risk: analysis.risk,
      preview: { command: analysis.normalizedCommand },
      impact: [],
      analysis,
      blocked: {
        code: 'INVALID_SYNTAX',
        message: `语法校验未通过：${analysis.parseErrors[0]?.message ?? '未知语法错误'}`,
        analysis,
      },
    };
  }
  if (analysis.blocked) {
    return {
      risk: analysis.risk,
      preview: { command: analysis.normalizedCommand },
      impact: [],
      analysis,
      blocked: {
        code: 'COMMAND_BLOCKED',
        message: `命令违反规范，禁止执行：${analysis.blockReasons.join('; ')}`,
        analysis,
      },
    };
  }
  return {
    risk: analysis.risk,
    preview: {
      command: analysis.normalizedCommand,
      riskReasons: analysis.riskReasons,
      commands: analysis.commands,
    },
    impact:
      analysis.paths.length > 0
        ? analysis.paths.map((path) => `路径影响：${path}`)
        : ['命令未声明明确路径影响；请确认其副作用与预期一致'],
    analysis,
    paths: analysis.paths,
  };
}

// --ps：启用真 PowerShell AST（CL-002）；不传则用内置保守 fallback
const useBridge = process.argv.includes('--ps');
let bridge;
let classifier = classifyShellCommand;
let parserKind = 'fallback';

if (useBridge) {
  bridge = new PowerShellBridge({ requestTimeoutMs: 20_000, startTimeoutMs: 20_000 });
  try {
    const info = await bridge.start();
    classifier = createBridgeClassifier(bridge);
    parserKind = 'powershell-ast';
    process.stderr.write(`[demo] 真 AST 已启用：${info.executable} ${info.version}（elevated=${info.elevated}）\n`);
  } catch (error) {
    bridge = undefined;
    process.stderr.write(
      `[demo] PowerShell 桥启动失败，回退 fallback：${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

const gate = new ToolGate({
  policy,
  store,
  audit,
  classify: classifier,
});

registry.registerAll([
  {
    id: 'system.info.get',
    name: '系统信息',
    description: '读取操作系统、架构、CPU、内存等只读信息（L0）',
    risk: 'L0',
    idempotent: true,
    async handler() {
      return {
        data: {
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          cpus: os.cpus().length,
          totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
          node: process.version,
          hostname: os.hostname(),
        },
      };
    },
  },
  {
    id: 'system.service.control',
    name: '服务控制',
    description: '启动/停止 Windows 服务（L2，需审批；演示环境不真实执行）',
    risk: 'L2',
    async handler(params) {
      return {
        data: { service: params.name ?? null, action: params.action ?? 'stop', simulated: true },
        warnings: ['v0.1.0 演示环境不执行真实服务操作'],
      };
    },
  },
  {
    id: 'system.file.write',
    name: '写用户文件',
    description: '在用户目录写入文件（L1；系统目录受路径黑名单保护）',
    risk: 'L1',
    async handler(params) {
      return { data: { path: params.path ?? null, simulated: true } };
    },
  },
  {
    id: 'shell.cmd.invoke',
    name: '命令执行',
    description:
      '动态分级执行 PowerShell 命令（L0-L3）。硬禁命令直接拒绝；风险 >= L2 需审批（演示环境不真实执行）',
    risk: 'L1',
    dynamicRisk: true,
    destructive: true,
    async handler(params, ctx) {
      return {
        data: {
          command: params.command ?? '',
          risk: ctx.risk,
          executed: false,
          note: 'v0.1.0 演示环境不执行真实命令；接入 CL-002 的 PowerShell 桥后才会真正运行',
        },
      };
    },
  },
  {
    id: 'meta.policy.set',
    name: '设置自动批准策略',
    description:
      '调整 autoApprove（L3）。放权会被强制人工审批且不受当前 autoApprove 影响（防自我放权）',
    risk: 'L3',
    policyControl: true,
    // 实际落库由 PolicyControlProvider 执行，能力本身不实现 handler
  },
]);

const server = createWinMcpServer({
  name: 'win-mcp-demo',
  version: '0.2.0',
  instructions: INSTRUCTIONS,
  registry,
  gate,
  policyControl: {
    get: () => autoApproveState,
    apply: async (target) => {
      autoApproveState = target;
      return { data: { policy: autoApproveState, simulated: true } };
    },
  },
});

function health() {
  return {
    name: 'win-mcp-demo',
    version: '0.2.0',
    capabilities: registry.size,
    pendingApprovals: store.size,
    chainValid: audit.verify().valid,
    auditEntries: audit.entries().length,
    autoApprove: autoApproveState,
    parser: parserKind,
    bridgeRunning: bridge !== undefined && bridge.status.running,
  };
}

async function shutdown() {
  if (bridge !== undefined) await bridge.stop();
}

const httpIndex = process.argv.indexOf('--http');
if (httpIndex >= 0) {
  const port = Number(process.argv[httpIndex + 1] ?? 8765);
  const httpServer = await startHttp(server, { port, health });
  process.stderr.write(`[demo] http://localhost:${port}/mcp (health: /health)\n`);
  process.on('SIGTERM', () => {
    void shutdown().finally(() => {
      httpServer.close();
      process.exit(0);
    });
  });
} else {
  await startStdio(server);
  process.stderr.write('[demo] stdio ready\n');
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
}