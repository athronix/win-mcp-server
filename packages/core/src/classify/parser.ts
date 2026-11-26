/**
 * 命令解析器 — 对应 FR-102 的 parser 注入点
 *
 * 生产环境应注入 PowerShell 官方 AST 解析结果（parser: 'powershell-ast'）。
 * 本文件的 fallbackParser 是保守实现：只做结构与 token 级判断，
 * 无法确证的一律交给上层按 L2 保守处理（fail-closed）。
 */
export interface ParseError {
  message: string;
  line: number;
  column: number;
}

export interface ParsedCommand {
  syntaxValid: boolean;
  errors: ParseError[];
  commands: string[];
  paths: string[];
  statementCount: number;
  /** `& $var` / `. $var` 这类无法静态判定的动态调用 */
  dynamicCalls: string[];
  parser: 'fallback' | 'powershell-ast';
}

export type CommandParser = (command: string) => ParsedCommand;

function positionOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, index));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
}

/** 括号平衡检查（忽略引号内容），返回首个不匹配位置索引 */
function checkBracketBalance(text: string): number | null {
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  const stack: { ch: string; index: number }[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push({ ch, index: i });
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      const top = stack.pop();
      if (top === undefined || top.ch !== pairs[ch]) return i;
    }
  }
  if (quote !== null) return text.length - 1;
  if (stack.length > 0) return stack[stack.length - 1]!.index;
  return null;
}

/** 按 ; | && || 换行 切分语句（忽略引号内与括号内的分隔符） */
function splitStatements(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (ch === ';' || ch === '\n') {
        out.push(current);
        current = '';
        continue;
      }
      if (ch === '|') {
        out.push(current);
        current = '';
        if (command[i + 1] === '|') i += 1;
        continue;
      }
      if (ch === '&' && command[i + 1] === '&') {
        out.push(current);
        current = '';
        i += 1;
        continue;
      }
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

interface NameExtraction {
  name?: string;
  dynamic?: string;
}

function extractCommandName(statement: string): NameExtraction {
  let s = statement.trim();
  // 赋值语句：$x = <cmd>
  const assign = /^\$[A-Za-z_][\w:]*\s*=\s*/.exec(s);
  if (assign !== null) s = s.slice(assign[0].length).trim();
  // 重定向前缀：> / >> / 2>
  s = s.replace(/^(?:\d?>>?)\s*/, '');
  if (s.length === 0) return {};
  // 动态调用：& $var / . $var / & (expr)
  if (/^[&.]\s/.test(s)) {
    const rest = s.slice(1).trim();
    if (rest.startsWith('$') || rest.startsWith('(')) return { dynamic: s };
    s = rest;
  }
  const token = /^([^\s(){}[\];|,]+)/.exec(s);
  if (token === null) return {};
  let name = token[1] as string;
  name = name.replace(/^['"]/, '').replace(/['"]$/, '');
  if (name.startsWith('$') || name.startsWith('-') || name.includes('=')) return {};
  return { name };
}

const PATH_PATTERNS: readonly RegExp[] = Object.freeze([
  /[A-Za-z]:\\[^\s"'`;,|)]+/g,
  /\\\\\?\\[^\s"']+/g,
  /\\\\[A-Za-z0-9._$-]+\\[^\s"']+/g,
  /(?:HKEY_[A-Z_]+|HK[A-Z_]+):?\\[^\s"']*/gi,
  /\$env:[A-Za-z_][A-Za-z0-9_]*\\[^\s"']*/gi,
]);

function extractPaths(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PATH_PATTERNS) {
    // 每个 pattern 带 g 标志，需重置 lastIndex 以免跨调用串状态
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches !== null) found.push(...matches);
  }
  return Array.from(new Set(found));
}

/** 保守 fallback 解析器：结构级校验 + token 级抽取 */
export function fallbackParser(command: string): ParsedCommand {
  const errors: ParseError[] = [];
  const balanceIndex = checkBracketBalance(command);
  if (balanceIndex !== null) {
    const pos = positionOf(command, balanceIndex);
    errors.push({
      message: '引号或括号不匹配',
      line: pos.line,
      column: pos.column,
    });
  }

  const statements = splitStatements(command);
  const commands: string[] = [];
  const dynamicCalls: string[] = [];
  for (const statement of statements) {
    const extracted = extractCommandName(statement);
    if (extracted.dynamic !== undefined) dynamicCalls.push(extracted.dynamic);
    if (extracted.name !== undefined) commands.push(extracted.name);
  }

  return {
    syntaxValid: errors.length === 0,
    errors,
    commands: Array.from(new Set(commands)),
    paths: extractPaths(command),
    statementCount: statements.length,
    dynamicCalls,
    parser: 'fallback',
  };
}