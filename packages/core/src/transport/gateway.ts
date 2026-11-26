import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Capability, CapabilityResult } from '../contracts/capability.js';
import type { ToolEnvelope } from '../contracts/envelope.js';
import { failureEnvelope } from '../contracts/envelope.js';
import { makeError } from '../contracts/errors.js';
import type { CapabilityRegistry } from '../registry/registry.js';
import type { ToolGate } from '../approval/gate.js';
import type { AutoApproveState } from '../approval/policy-control.js';

/** instructions 上限（借鉴 yotsuda/PowerShell.MCP 的 MaxServerInstructionsBytes） */
export const MAX_INSTRUCTIONS_BYTES = 4096;

export interface CallToolResultLike {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/**
 * envelope → MCP 调用结果
 * 关键语义：APPROVAL_REQUIRED 不是传输错误（isError 不置 true），
 * 否则宿主会把它当失败隐藏掉，用户永远看不到审批卡。
 */
export function toCallResult(envelope: ToolEnvelope): CallToolResultLike {
  const approvalRequired = envelope.error?.code === 'APPROVAL_REQUIRED';
  const isError = envelope.error !== undefined && !approvalRequired;
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 策略自管理 provider：只做"读当前状态 / 落库目标状态"，
 * 方向判定与强制审批由 ToolGate.runPolicyControl 负责（防自我放权）。
 */
export interface PolicyControlProvider {
  get(): AutoApproveState;
  apply(target: AutoApproveState): Promise<CapabilityResult>;
}

/** 为每个能力注册 MCP 工具：注入 __approvalId、annotations，统一走 ToolGate */
export function registerCapabilityTools(
  server: McpServer,
  capabilities: readonly Capability[],
  gate: ToolGate,
  policyControl?: PolicyControlProvider,
): void {
  for (const capability of capabilities) {
    // passthrough：能力未声明 schema 时也保留调用方参数（否则 zod 默认会 strip 未知键，
    // 导致参数哈希与预览失真）。__approvalId 由框架统一注入。
    const inputSchema = z
      .object({
        ...capability.inputSchema,
        __approvalId: z
          .string()
          .optional()
          .describe('审批通过后用于续跑执行；除该字段外，参数必须与首次调用完全一致'),
      })
      .passthrough();

    server.registerTool(
      capability.id,
      {
        title: capability.name,
        description: capability.description,
        inputSchema,
        annotations: capability.annotations,
      },
      async (args: Record<string, unknown>) => {
        if (capability.policyControl) {
          if (policyControl === undefined) {
            return toCallResult(
              failureEnvelope({
                traceId: 'tr_unconfigured',
                risk: capability.risk,
                error: makeError(
                  'INVALID_PARAMS',
                  `能力 ${capability.id} 是策略自管理能力，但 server 未配置 PolicyControlProvider`,
                ),
              }),
            );
          }
          const target: AutoApproveState = {
            enabled: args.enabled === true,
            maxRisk: args.maxRisk === 'L3' ? 'L3' : 'L2',
          };
          const outcome = await gate.runPolicyControl(
            { capability, params: args, current: policyControl.get(), target },
            async () => policyControl.apply(target),
          );
          return toCallResult(outcome.envelope);
        }

        const outcome = await gate.run({ capability, params: args }, async (params, ctx) => {
          if (capability.handler === undefined) {
            return { data: null, warnings: [`能力 ${capability.id} 尚未实现 handler`] };
          }
          return capability.handler(params, { traceId: ctx.traceId, risk: ctx.risk });
        });
        return toCallResult(outcome.envelope);
      },
    );
  }
}

export interface WinMcpServerOptions {
  name: string;
  version: string;
  instructions: string;
  registry: CapabilityRegistry;
  gate: ToolGate;
  policyControl?: PolicyControlProvider;
}

export function createWinMcpServer(opts: WinMcpServerOptions): McpServer {
  const bytes = Buffer.byteLength(opts.instructions, 'utf8');
  if (bytes > MAX_INSTRUCTIONS_BYTES) {
    throw new Error(`INSTRUCTIONS_TOO_LONG: ${bytes} > ${MAX_INSTRUCTIONS_BYTES} 字节`);
  }
  const server = new McpServer(
    { name: opts.name, version: opts.version },
    { instructions: opts.instructions },
  );
  registerCapabilityTools(server, opts.registry.list(), opts.gate, opts.policyControl);
  return server;
}

export async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface HttpGatewayOptions {
  port: number;
  host?: string;
  path?: string;
  allowRemote?: boolean;
  health?: () => Record<string, unknown>;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? undefined : JSON.parse(text);
}

/** 单端口 streamable-HTTP 网关 + /health（FR-108） */
export function startHttp(server: McpServer, opts: HttpGatewayOptions): Promise<Server> {
  const host = opts.host ?? 'localhost';
  if (!LOOPBACK_HOSTS.has(host) && opts.allowRemote !== true) {
    throw new Error(
      `NON_LOOPBACK_BIND: 拒绝绑定 ${host}；如需远程访问请显式 allowRemote=true 并自备鉴权`,
    );
  }
  const mcpPath = opts.path ?? '/mcp';

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/health' && req.method === 'GET') {
        const payload = { ok: true, ...(opts.health?.() ?? {}) };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (url.pathname !== mcpPath) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        // 无状态：每请求一个 transport，避免请求 ID 串扰
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (!res.headersSent) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'bad_request', message }));
        }
      }
    })();
  });

  return new Promise<Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, host, () => resolve(httpServer));
  });
}