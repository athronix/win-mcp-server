/**
 * 路径/命令识别与 glob 匹配 — 对应 FR-103
 * 移植自本地 core/dist/policy/engine.js:17-152
 */

/** Windows 路径 glob：`**` 跨分隔符、`*` 不跨、大小写不敏感 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^\\\\/]*';
      }
    } else if (c === '?') {
      re += '[^\\\\/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

const DRIVE_RE = /^[a-z]:[\\/]/i;
const UNC_RE = /^\\\\/;
const SEP_RE = /[\\/]/;
const REG_RE = /^(HK[A-Z_]+|HKEY_[A-Z_]+)[:\\/]/i;

/** 归一化路径：统一反斜杠、折叠重复分隔符（UNC 保留）、去尾分隔符 */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\//g, '\\');
  if (!UNC_RE.test(s)) s = s.replace(/\\{2,}/g, '\\');
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

/**
 * 路径匹配：除原样比对外补一次"带尾分隔符"比对。
 * 原因：`C:\Users\**` 应覆盖 `C:\Users` 目录自身。
 */
export function pathMatchesAny(p: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((re) => re.test(p) || re.test(`${p}\\`) || re.test(`${p}/`));
}

export function looksLikePath(s: string): boolean {
  return DRIVE_RE.test(s) || UNC_RE.test(s) || (SEP_RE.test(s) && s.length > 2);
}

export function looksLikeRegistryPath(s: string): boolean {
  return REG_RE.test(s);
}

/** 字符串是否疑似命令（含典型命令动词或参数开关） */
export function looksLikeCommandValue(s: string): boolean {
  if (s.length < 3) return false;
  return (
    /^(\$|>)/.test(s.trim()) ||
    /\s-([a-z]{1,20})\b/.test(s) ||
    /\b(get|set|new|remove|start|stop|restart|invoke|add|install|uninstall|net|sc|reg|taskkill|winget)-?[a-z]*\b/i.test(s)
  );
}

const COMMAND_KEY_RE = /\b(command|cmd|script|expression|powershell|shell|exec|args|arguments)\b/i;

export function isCommandishKey(key: string): boolean {
  return COMMAND_KEY_RE.test(key);
}

/**
 * 从命令串中提取路径片段。
 * 必要性：`Get-ChildItem C:\Windows` 整体不是路径，但内嵌的 `C:\Windows` 必须受路径策略约束；
 * 把整条命令当路径比对又会误杀合法调用。
 */
export function extractPathTokens(s: string): string[] {
  const out: string[] = [];
  const patterns: readonly RegExp[] = [
    /[A-Za-z]:\\[^\s"'`;,|)]+/g,
    /\\\\\?\\[^\s"']+/g,
    /\\\\[A-Za-z0-9._$-]+\\[^\s"']+/g,
    /(?:HK[A-Z_]+|HKEY_[A-Z_]+):?\\[^\s"']+/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    const matches = s.match(re);
    if (matches !== null) out.push(...matches);
  }
  return Array.from(new Set(out));
}

export interface StringValue {
  key: string;
  value: string;
}

/** 递归收集参数中所有字符串值并附带键名 */
export function collectStringValues(
  params: unknown,
  prefix = '',
  out: StringValue[] = [],
): StringValue[] {
  if (params === null || typeof params !== 'object') return out;
  if (Array.isArray(params)) {
    params.forEach((item, idx) => {
      const key = prefix.length > 0 ? `${prefix}[${idx}]` : `[${idx}]`;
      if (typeof item === 'string') out.push({ key, value: item });
      else if (item !== null && typeof item === 'object') collectStringValues(item, key, out);
    });
    return out;
  }
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    const key = prefix.length > 0 ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push({ key, value: v });
    else if (v !== null && typeof v === 'object') collectStringValues(v, key, out);
  }
  return out;
}

/** 取某参数值需要接受文件系统路径策略检查的候选路径 */
export function pathCandidates(key: string, value: string): string[] {
  const isCommandish = isCommandishKey(key) || looksLikeCommandValue(value);
  const raw = isCommandish
    ? extractPathTokens(value)
    : looksLikePath(value)
      ? [value]
      : [];
  return raw.filter((p) => !looksLikeRegistryPath(p));
}