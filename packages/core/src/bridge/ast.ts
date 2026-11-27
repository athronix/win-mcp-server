import type { DynamicClassifier } from '../approval/gate.js';
import { analyzeCommand, type AnalyzeCommandOptions, type CliAnalysis } from '../classify/command.js';
import type { ParsedCommand } from '../classify/parser.js';
import type { ErrorCode } from '../contracts/errors.js';
import { BridgeError, type PowerShellBridge } from './bridge.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function toParseError(value: unknown): { message: string; line: number; column: number } {
  if (!isRecord(value)) return { message: '未知语法错误', line: 0, column: 0 };
  return {
    message: typeof value.message === 'string' ? value.message : '未知语法错误',
    line: typeof value.line === 'number' ? value.line : 0,
    column: typeof value.column === 'number' ? value.column : 0,
  };
}

/**
 * 通过桥做 AST 解析（CL-002）。
 * 返回结构与 fallbackParser 完全一致，可直接注入 analyzeCommand。
 */
export async function parseWithBridge(
  bridge: PowerShellBridge,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<ParsedCommand> {
  const raw = await bridge.call<unknown>('parse', { command }, opts);
  if (!isRecord(raw)) {
    throw new BridgeError('BRIDGE_PROTOCOL', 'parse 响应不是对象');
  }
  return {
    syntaxValid: raw.syntaxValid === true,
    errors: Array.isArray(raw.errors) ? raw.errors.map(toParseError) : [],
    commands: toStringArray(raw.commands),
    paths: toStringArray(raw.paths),
    statementCount: typeof raw.statementCount === 'number' ? raw.statementCount : 0,
    dynamicCalls: toStringArray(raw.dynamicCalls),
    parser: 'powershell-ast',
  };
}

/**
 * 先 await 真 AST 解析，再把结果以同步 parser 注入底座判级逻辑。
 * 这样 `classify/command.ts` 与既有 106 条测试零改动。
 */
export async function analyzeCommandWithBridge(
  bridge: PowerShellBridge,
  opts: AnalyzeCommandOptions & { timeoutMs?: number },
): Promise<CliAnalysis> {
  const { timeoutMs, ...rest } = opts;
  const parsed = await parseWithBridge(
    bridge,
    opts.command,
    timeoutMs !== undefined ? { timeoutMs } : {},
  );
  return analyzeCommand({ ...rest, parser: () => parsed });
}

/** 桥错误 → 统一错误码（fail-closed，不降级为 fallback 放行） */
export function bridgeErrorToCode(error: unknown): ErrorCode {
  if (error instanceof BridgeError) {
    switch (error.code) {
      case 'TIMEOUT':
        return 'TIMEOUT';
      case 'BRIDGE_UNAVAILABLE':
      case 'BRIDGE_EXITED':
      case 'BRIDGE_PROTOCOL':
        return 'PREFLIGHT_UNAVAILABLE';
      case 'BRIDGE_REMOTE':
        return 'PREFLIGHT_FAILED';
    }
  }
  return 'PREFLIGHT_FAILED';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 生成可直接传给 `ToolGate({ classify })` 的判级器。
 * 任何桥侧失败都转成 blocked，绝不"猜一下继续"。
 */
export function createBridgeClassifier(
  bridge: PowerShellBridge,
  opts: { timeoutMs?: number } = {},
): DynamicClassifier {
  return async (capability, params) => {
    const command = typeof params.command === 'string' ? params.command : '';
    const runAsAdmin = params.runAsAdmin === true;

    if (command.trim().length === 0) {
      return {
        risk: capability.risk,
        preview: {},
        impact: [],
        blocked: { code: 'INVALID_PARAMS', message: 'command 必须是非空字符串' },
      };
    }

    let analysis: CliAnalysis;
    try {
      analysis = await analyzeCommandWithBridge(bridge, {
        command,
        runAsAdmin,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    } catch (error) {
      return {
        risk: 'L3',
        preview: { command },
        impact: [],
        blocked: {
          code: bridgeErrorToCode(error),
          message: `命令预检失败：${messageOf(error)}`,
        },
      };
    }

    if (!analysis.syntaxValid) {
      const first = analysis.parseErrors[0];
      const position =
        first !== undefined && first.line > 0 ? `（line ${first.line}, column ${first.column}）` : '';
      return {
        risk: 'L3',
        preview: { command: analysis.normalizedCommand },
        impact: [],
        analysis,
        blocked: {
          code: 'INVALID_SYNTAX',
          message: `语法校验未通过：${first?.message ?? '未知语法错误'}${position}`,
          analysis,
        },
      };
    }

    if (analysis.blocked) {
      return {
        risk: 'L3',
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
  };
}