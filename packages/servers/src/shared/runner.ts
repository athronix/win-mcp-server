import {
  ApprovalStore,
  AuditChain,
  CapabilityRegistry,
  DEFAULT_POLICY,
  PolicyEngine,
  PowerShellBridge,
  ToolGate,
  createBridgeClassifier,
  createWinMcpServer,
  mergePolicy,
  startHttp,
  startStdio,
  type CapabilitySpec,
  type DynamicClassifier,
  type PolicyConfig,
  type PolicyControlProvider,
} from '@win-mcp/core';

export interface ServerBuildContext {
  bridge: PowerShellBridge;
}

export interface ServerRuntimeOptions {
  name: string;
  version: string;
  instructions: string;
  buildCapabilities: (ctx: ServerBuildContext) => CapabilitySpec[];
  policy?: Partial<PolicyConfig>;
  /** 用真 PowerShell AST 做动态判级（shell 需要） */
  useBridgeClassifier?: boolean;
  /** 自定义判级器（优先于 useBridgeClassifier） */
  buildClassifier?: (ctx: ServerBuildContext) => DynamicClassifier;
  policyControl?: PolicyControlProvider;
}

function log(scope: string, message: string): void {
  process.stderr.write(`[${scope}] ${message}\n`);
}

/**
 * 六个业务 server 的统一运行器：
 * - 启动 pwsh 桥（失败即退出，不降级）
 * - 注册能力 + 组装 ToolGate（策略/审批/审计共享同一实例）
 * - stdio（默认）或 WIN_MCP_HTTP_PORT 指定的 HTTP
 */
export async function runServer(options: ServerRuntimeOptions): Promise<void> {
  const bridge = new PowerShellBridge({
    onDiagnostic: (line) => log(options.name, `[bridge] ${line}`),
  });

  let info;
  try {
    info = await bridge.start();
  } catch (error) {
    log(options.name, `PowerShell 桥启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  log(options.name, `pwsh ${info.version} (${info.edition}, elevated=${info.elevated})`);

  const registry = new CapabilityRegistry();
  registry.registerAll(options.buildCapabilities({ bridge }));

  const policy = new PolicyEngine(mergePolicy(DEFAULT_POLICY, options.policy));
  const store = new ApprovalStore({ ttlMs: policy.config.approvalTimeoutMs });
  const audit = new AuditChain({ ...(process.env.WIN_MCP_AUDIT_SECRET !== undefined ? { secret: process.env.WIN_MCP_AUDIT_SECRET } : {}) });

  const classifier =
    options.buildClassifier !== undefined
      ? options.buildClassifier({ bridge })
      : options.useBridgeClassifier === true
        ? createBridgeClassifier(bridge)
        : undefined;

  const gate = new ToolGate({
    policy,
    store,
    audit,
    ...(classifier !== undefined ? { classify: classifier } : {}),
  });

  const server = createWinMcpServer({
    name: options.name,
    version: options.version,
    instructions: options.instructions,
    registry,
    gate,
    ...(options.policyControl !== undefined ? { policyControl: options.policyControl } : {}),
  });

  const health = (): Record<string, unknown> => ({
    name: options.name,
    version: options.version,
    capabilities: registry.size,
    pendingApprovals: store.size,
    chainValid: audit.verify().valid,
    auditEntries: audit.entries().length,
    bridge: { running: bridge.status.running, restarts: bridge.status.restarts },
    policy: { autoApprove: policy.config.autoApprove, maxRisk: policy.config.defaultMaxRisk },
  });

  const shutdown = (): void => {
    void bridge.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const httpPort = process.env.WIN_MCP_HTTP_PORT;
  if (httpPort !== undefined && httpPort.length > 0) {
    const httpServer = await startHttp(server, { port: Number(httpPort), health });
    log(options.name, `HTTP ready: http://localhost:${httpPort}/mcp (health: /health)`);
    process.on('SIGTERM', () => httpServer.close());
    return;
  }

  await startStdio(server);
  log(options.name, `stdio ready，${registry.size} 个能力`);
}