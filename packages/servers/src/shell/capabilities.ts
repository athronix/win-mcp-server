import { z } from 'zod';
import {
  analyzeCommandWithBridge,
  createBridgeClassifier,
  type CapabilitySpec,
  type DynamicClassifier,
  type PowerShellBridge,
} from '@win-mcp/core';
import { analyzeBashCommand } from './bash-classify.js';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const RESUME = '确认后以 __approvalId 重发完全相同的命令（参数任何变化都会作废审批）';

/**
 * shell 专用判级器：
 * - PowerShell 命令走真 AST（底座 createBridgeClassifier）
 * - bash 命令走本地词表分级
 * - runAsAdmin 在非提权会话直接 ADMIN_REQUIRED（不静默降级）
 */
export function createShellClassifier(bridge: PowerShellBridge): DynamicClassifier {
  const powershellClassifier = createBridgeClassifier(bridge);

  return async (capability, params) => {
    if (capability.id === 'shell.bash.invoke') {
      const command = str(params.command);
      const analysis = analyzeBashCommand(command);
      if (analysis.blocked) {
        return {
          risk: 'L3',
          preview: { command, riskReasons: analysis.riskReasons },
          impact: [],
          analysis,
          blocked: {
            code: 'COMMAND_BLOCKED',
            message: `bash 命令违反规范，禁止执行：${analysis.blockReasons.join('; ')}`,
            analysis,
          },
        };
      }
      return {
        risk: analysis.risk,
        preview: { command, riskReasons: analysis.riskReasons, commands: analysis.commands },
        impact:
          analysis.paths.length > 0
            ? analysis.paths.map((path) => `路径影响：${path}`)
            : ['命令未声明明确路径影响；请确认其副作用与预期一致'],
        analysis,
        paths: analysis.paths,
      };
    }

    if (params.runAsAdmin === true && bridge.info?.elevated !== true) {
      return {
        risk: 'L3',
        preview: { command: str(params.command) },
        impact: [],
        blocked: {
          code: 'ADMIN_REQUIRED',
          message:
            '当前 server 会话非提权，runAsAdmin 不可用（不会静默降级为普通权限执行）。请以管理员身份启动 server 后重试',
        },
      };
    }

    return powershellClassifier(capability, params);
  };
}

/** win-shell：命令预检、执行、Git-Bash 通道 */
export function shellCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const callModule = <T>(fn: string, args: Record<string, unknown>): Promise<T> =>
    bridge.call<T>('module', { module: 'shell', function: fn, args });

  return [
    {
      id: 'shell.env.info',
      name: 'Shell 环境信息',
      description:
        '返回 PowerShell 版本、是否提权、Git-Bash 路径与版本（只读 L0）。执行前先用它确认环境能力。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {},
      async handler() {
        return { data: await callModule('Get-ShellInfo', {}) };
      },
    },
    {
      id: 'shell.cmd.analyze',
      name: '命令预检',
      analysisOnly: true,
      description:
        '用官方 AST 预检 PowerShell 命令并返回分级（L0-L3）、语法错误（含行列）、解析出的命令与路径。不执行任何命令（L0）。执行前建议先预检。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        command: z.string().min(1).describe('待预检的 PowerShell 命令'),
      },
      async handler(params) {
        const analysis = await analyzeCommandWithBridge(bridge, { command: str(params.command) });
        return { data: analysis };
      },
    },
    {
      id: 'shell.cmd.invoke',
      name: '执行 PowerShell 命令',
      description:
        `动态分级执行 PowerShell 命令：L0 直放，L2/L3 需审批，硬禁命令（编码执行/iex/下载执行/exit 等）直接拒绝且无审批通道。${RESUME}`,
      risk: 'L1',
      dynamicRisk: true,
      destructive: true,
      timeoutMs: 120_000,
      inputSchema: {
        command: z.string().min(1).describe('PowerShell 命令（不要包 powershell.exe -Command 外壳）'),
        runAsAdmin: z.boolean().optional().describe('请求提权；非提权会话会直接 ADMIN_REQUIRED'),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe('执行超时，默认 60000'),
      },
      async handler(params, ctx) {
        const result = await bridge.call<{ output: string; errors: string; truncated: boolean }>(
          'invoke',
          {
            command: str(params.command),
            timeoutMs: num(params.timeoutMs, 60_000),
          },
        );
        return {
          data: { ...result, risk: ctx.risk, elevated: bridge.info?.elevated === true },
          effectState: 'committed',
        };
      },
    },
    {
      id: 'shell.bash.invoke',
      name: '执行 Git-Bash 命令',
      description:
        `通过 Git-Bash 执行命令（L0-L3 分级与 PowerShell 同构；rm -rf /、curl|sh、eval、dd 写块设备等硬禁直接拒绝）。需要本机已安装 Git-Bash。${RESUME}`,
      risk: 'L1',
      dynamicRisk: true,
      destructive: true,
      timeoutMs: 120_000,
      inputSchema: {
        command: z.string().min(1).describe('bash 命令'),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe('执行超时，默认 30000'),
      },
      async handler(params) {
        const result = await callModule<{
          ok: boolean;
          error?: { code: string; message: string };
          data?: unknown;
        }>('Invoke-BashCommand', {
          Command: str(params.command),
          TimeoutMs: num(params.timeoutMs, 30_000),
        });
        if (result.ok !== true) {
          throw new Error(`${result.error?.code ?? 'BASH_FAILED'}: ${result.error?.message ?? 'bash 执行失败'}`);
        }
        return { data: result.data, effectState: 'committed' };
      },
    },
  ];
}