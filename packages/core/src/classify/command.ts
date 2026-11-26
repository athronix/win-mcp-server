import { homedir } from 'node:os';
import type { RiskLevel } from '../contracts/risk.js';
import { maxRisk, riskRank } from '../contracts/risk.js';
import { fallbackParser, type CommandParser, type ParseError, type ParsedCommand } from './parser.js';
import {
  GEN_BLOCK_PATTERNS,
  GEN_MAX_CHARS,
  GEN_MAX_STATEMENTS,
  isL0Name,
  isL1WriteName,
  isL2Name,
  isL3Name,
} from './vocab.js';

export interface CliAnalysis {
  ok: true;
  syntaxValid: boolean;
  parseErrors: ParseError[];
  blocked: boolean;
  blockReasons: string[];
  risk: RiskLevel;
  riskReasons: string[];
  commands: string[];
  paths: string[];
  warnings: string[];
  suggestions: string[];
  runAsAdmin: boolean;
  statementCount: number;
  normalizedCommand: string;
  parser: 'fallback' | 'powershell-ast';
}

export interface AnalyzeCommandOptions {
  command: string;
  runAsAdmin?: boolean;
  parser?: CommandParser;
  homeDir?: string;
  env?: Record<string, string>;
}

const HKLM_PATTERN = /^(?:HKLM|HKEY_LOCAL_MACHINE)[:\\/]/i;
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/** 路径是否位于"已证明的用户域"（$env:USERPROFILE / $HOME / ~ / TEMP / LOCALAPPDATA / 实际 home） */
export function isInUserScope(
  pathValue: string,
  opts: { homeDir?: string; env?: Record<string, string> } = {},
): boolean {
  if (typeof pathValue !== 'string') return false;
  const trimmed = pathValue.trim().replace(/^["']/, '').replace(/["']$/, '');
  if (trimmed.length === 0) return false;
  if (/^\$env:(USERPROFILE|TEMP|TMP|LOCALAPPDATA|APPDATA)\b/i.test(trimmed)) return true;
  if (/^\$HOME\b/i.test(trimmed)) return true;
  if (trimmed.startsWith('~')) return true;

  let expanded = trimmed;
  if (opts.env !== undefined) {
    expanded = trimmed.replace(
      /^\$env:([A-Za-z_][A-Za-z0-9_]*)/i,
      (match, name: string) => opts.env?.[name] ?? opts.env?.[name.toUpperCase()] ?? match,
    );
  }
  const home = opts.homeDir ?? safeHomedir();
  if (home !== undefined && home.length > 0) {
    if (expanded.toLowerCase().startsWith(home.toLowerCase())) return true;
  }
  return false;
}

function baseResult(normalized: string, runAsAdmin: boolean): Omit<CliAnalysis, 'parser'> {
  return {
    ok: true,
    syntaxValid: true,
    parseErrors: [],
    blocked: false,
    blockReasons: [],
    risk: 'L0',
    riskReasons: [],
    commands: [],
    paths: [],
    warnings: [],
    suggestions: [],
    runAsAdmin,
    statementCount: 0,
    normalizedCommand: normalized,
  };
}

/**
 * 命令动态分级主流程（FR-102，对应本地 general.ps1:127-342）
 * 顺序：基础规范 → 语法 → 硬禁 → 命令词表 → 路径证据 → 路径感知升级 → 提权升级 → 取最大
 */
export function analyzeCommand(opts: AnalyzeCommandOptions): CliAnalysis {
  const raw = typeof opts.command === 'string' ? opts.command : '';
  const runAsAdmin = opts.runAsAdmin === true;
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  const parser = opts.parser ?? fallbackParser;

  const result = baseResult(normalized, runAsAdmin);

  // —— 1. 基础规范 ——
  if (normalized.length === 0) result.blockReasons.push('命令为空');
  if (raw.length > GEN_MAX_CHARS) {
    result.blockReasons.push(`命令过长（${raw.length} > ${GEN_MAX_CHARS} 字符），请拆分为多次调用`);
  }
  if (raw.includes('\u0000')) result.blockReasons.push('命令含 NUL 字节');
  if (
    /^\s*(powershell|pwsh)(\.exe)?\s+-/i.test(normalized) ||
    /^\s*-command\s/i.test(normalized)
  ) {
    result.blockReasons.push('只接受纯 PowerShell 命令，不要包 powershell.exe / -Command 外壳');
  }

  // —— 2. 语法解析（失败即 fail-closed，不做后续判级）——
  let parsed: ParsedCommand;
  try {
    parsed = parser(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      syntaxValid: false,
      parseErrors: [{ message: `解析器异常：${message}`, line: 0, column: 0 }],
      blocked: true,
      blockReasons: [...result.blockReasons, '解析器异常，按最高风险拒绝执行'],
      risk: 'L3',
      riskReasons: ['解析失败 → L3，禁止执行'],
      suggestions: ['检查命令语法后重试'],
      parser: 'fallback',
    };
  }

  if (!parsed.syntaxValid) {
    return {
      ...result,
      syntaxValid: false,
      parseErrors: parsed.errors,
      blocked: true,
      blockReasons: [...result.blockReasons, '语法校验未通过，命令不会被执行'],
      risk: 'L3',
      riskReasons: ['语法无效：按最高风险处理，禁止执行'],
      paths: parsed.paths,
      statementCount: parsed.statementCount,
      suggestions: ['先用 shell.analyze 预检，按 parseErrors 的 line/column 修正语法'],
      parser: parsed.parser,
    };
  }

  // —— 3. 硬禁模式（不可审批放行）——
  for (const pattern of GEN_BLOCK_PATTERNS) {
    if (pattern.test(raw)) result.blockReasons.push(`命中禁止模式：${pattern.source}`);
  }
  if (parsed.dynamicCalls.length > 0) {
    result.blockReasons.push(
      '检测到动态命令调用（& / . 后接变量或表达式），无法静态判定，禁止执行',
    );
  }

  // —— 4. 命令词表判级 ——
  let risk: RiskLevel = 'L0';
  const unknownCommands: string[] = [];
  for (const name of parsed.commands) {
    if (isL3Name(name)) {
      risk = maxRisk(risk, 'L3');
      result.riskReasons.push(`${name} → L3（高危/不可逆命令）`);
    } else if (isL2Name(name)) {
      risk = maxRisk(risk, 'L2');
      result.riskReasons.push(`${name} → L2（破坏性/系统态变更）`);
    } else if (isL1WriteName(name)) {
      risk = maxRisk(risk, 'L1');
      result.riskReasons.push(`${name} → L1 候选（用户域可逆写）`);
    } else if (isL0Name(name)) {
      result.riskReasons.push(`${name} → L0（只读）`);
    } else {
      unknownCommands.push(name);
      risk = maxRisk(risk, 'L2');
      result.riskReasons.push(`${name} → L2（未知命令，按保守默认处理）`);
    }
  }
  for (const name of unknownCommands) {
    result.warnings.push(`未知命令 ${name}：按 L2 保守分级，如需降低请使用已登记的只读 cmdlet`);
  }

  // —— 5. 路径证据（注册表机器级）——
  const paths = parsed.paths;
  for (const path of paths) {
    if (HKLM_PATTERN.test(path)) {
      risk = maxRisk(risk, 'L2');
      result.riskReasons.push(`${path} → L2（机器级注册表）`);
    }
  }

  // —— 6. 路径感知升级：L1 写命令但目标不可证明在用户域 → L2 ——
  const hasL1Write = parsed.commands.some((name) => isL1WriteName(name));
  if (hasL1Write && riskRank(risk) < 2) {
    let userScopeHits = 0;
    let outOfScopeHits = 0;
    for (const path of paths) {
      if (isInUserScope(path, { ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}), ...(opts.env !== undefined ? { env: opts.env } : {}) })) {
        userScopeHits += 1;
      } else if (ABSOLUTE_PATH_PATTERN.test(path) || HKLM_PATTERN.test(path)) {
        outOfScopeHits += 1;
      }
    }
    if (outOfScopeHits > 0 || userScopeHits === 0) {
      risk = 'L2';
      result.riskReasons.push('写入目标不在已证明的用户域（或路径不明确）→ L2（保守升级）');
    } else {
      result.riskReasons.push('写入目标均在用户域 → 保持 L1');
    }
  }

  // —— 7. 提权升级 ——
  if (runAsAdmin) {
    const hasWriteCommand = parsed.commands.some(
      (name) => isL1WriteName(name) || isL2Name(name) || isL3Name(name),
    );
    if (hasWriteCommand || riskRank(risk) >= 2) {
      risk = 'L3';
      result.riskReasons.push('runAsAdmin=true + 写/破坏性命令 → L3（提权执行高危操作）');
    } else {
      risk = maxRisk(risk, 'L2');
      result.riskReasons.push('runAsAdmin=true → 至少 L2（提权意图本身需审批）');
    }
  }

  // —— 8. 建议 + blocked 收敛 ——
  if (parsed.statementCount > GEN_MAX_STATEMENTS) {
    result.suggestions.push('语句过多（>10），建议拆成多次调用，便于分级与审计');
  }
  if (risk === 'L0') {
    result.suggestions.push('当前为只读命令，可直接执行');
  } else {
    result.suggestions.push('调用后会返回 approvalId；确认 impact 后带 __approvalId 原样重发');
  }
  if (unknownCommands.length > 0) {
    result.suggestions.push('尽量使用 Get-*/Copy-Item/New-Item 等已登记 cmdlet，可预测分级、减少审批摩擦');
  }

  if (result.blockReasons.length > 0) {
    result.blocked = true;
    risk = 'L3';
  }

  return {
    ...result,
    risk,
    commands: parsed.commands,
    paths,
    statementCount: parsed.statementCount,
    parser: parsed.parser,
  };
}