import type { RiskLevel } from '@win-mcp/core';

/**
 * Git-Bash 命令分级（CL-004）
 *
 * 与 PowerShell 侧同构：L0 只读 / L1 用户域可逆写 / L2 破坏性 / L3 高危。
 * 无法确证的命令按 L2 保守处理；硬禁模式直接 blocked（不可审批放行）。
 */
const L0_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'find', 'which', 'whereis',
  'whoami', 'id', 'date', 'uname', 'df', 'du', 'ps', 'env', 'printenv', 'echo', 'printf',
  'wc', 'sort', 'uniq', 'cut', 'tr', 'stat', 'file', 'tree', 'diff', 'cmp', 'comm', 'join',
  'basename', 'dirname', 'realpath', 'readlink', 'type', 'history', 'hostname', 'nproc',
]);

const L1_COMMANDS = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'tee', 'install', 'rsync', 'tar', 'zip', 'unzip',
]);

const L2_COMMANDS = new Set([
  'rm', 'rmdir', 'chmod', 'chown', 'chgrp', 'dd', 'mount', 'umount', 'kill', 'killall',
  'pkill', 'sed', 'awk', 'truncate', 'shred', 'mv', 'ln', 'npm', 'pnpm', 'yarn', 'pip',
  'pip3', 'python', 'python3', 'node', 'deno', 'git', 'cargo', 'go', 'dotnet', 'make',
  'cmake', 'docker', 'kubectl', 'ssh', 'scp', 'rsync',
]);

const L3_COMMANDS = new Set([
  'sudo', 'su', 'passwd', 'useradd', 'userdel', 'usermod', 'chroot', 'iptables', 'shutdown',
  'reboot', 'halt', 'poweroff', 'mkfs', 'fdisk', 'parted', 'systemctl', 'service', 'init',
  'reg', 'regedit', 'bcdedit', 'diskpart', 'takeown', 'icacls',
]);

/** 硬禁：命中即 blocked，不提供审批通道 */
const BLOCK_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|~|\$HOME)(\s|$)/i, reason: 'rm -rf 作用于根/家目录' },
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /(curl|wget)[^|]*\|\s*(ba)?sh/i, reason: '下载内容直接交给 shell 执行' },
  { pattern: /\beval\b/i, reason: 'eval 动态执行' },
  { pattern: /\bexec\s+\d*<\s*\//i, reason: 'exec 重定向到设备' },
  { pattern: /dd\s+[^\n]*of=\/dev\//i, reason: 'dd 直写块设备' },
  { pattern: /mkfs\./i, reason: '格式化文件系统' },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/i, reason: '重定向到块设备' },
  { pattern: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/i, reason: 'chmod 777 根目录' },
];

const ABSOLUTE_PATH = /(?:^|\s)(\/[A-Za-z0-9._-][^\s;|&]*)/g;

export interface BashAnalysis {
  risk: RiskLevel;
  blocked: boolean;
  blockReasons: string[];
  riskReasons: string[];
  commands: string[];
  paths: string[];
  warnings: string[];
  suggestions: string[];
}

function splitStatements(command: string): string[] {
  return command
    .split(/;|&&|\|\||\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function firstToken(statement: string): string {
  const stripped = statement.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  const token = stripped.match(/^[^\s|>]+/);
  return token === null ? '' : token[0];
}

function extractPaths(command: string): string[] {
  const found: string[] = [];
  ABSOLUTE_PATH.lastIndex = 0;
  let match = ABSOLUTE_PATH.exec(command);
  while (match !== null) {
    const value = match[1];
    if (value !== undefined && value.length > 1) found.push(value);
    match = ABSOLUTE_PATH.exec(command);
  }
  return Array.from(new Set(found));
}

export function analyzeBashCommand(command: string): BashAnalysis {
  const normalized = command.replace(/\r\n/g, '\n').trim();
  const blockReasons: string[] = [];
  const riskReasons: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const commands: string[] = [];
  let risk: RiskLevel = 'L0';

  if (normalized.length === 0) blockReasons.push('命令为空');
  if (normalized.length > 8000) blockReasons.push('命令过长（>8000 字符），请拆分');
  if (normalized.includes('\u0000')) blockReasons.push('命令含 NUL 字节');

  for (const rule of BLOCK_PATTERNS) {
    if (rule.pattern.test(normalized)) blockReasons.push(`命中禁止模式：${rule.reason}`);
  }

  const paths = extractPaths(normalized);

  for (const statement of splitStatements(normalized)) {
    const name = firstToken(statement);
    if (name.length === 0) continue;
    if (!commands.includes(name)) commands.push(name);
    const lowered = name.toLowerCase();

    if (L3_COMMANDS.has(lowered)) {
      risk = 'L3';
      riskReasons.push(`${name} → L3（高危/系统级命令）`);
      continue;
    }
    if (L2_COMMANDS.has(lowered)) {
      risk = 'L2';
      riskReasons.push(`${name} → L2（破坏性或可执行任意内容）`);
      continue;
    }
    if (L1_COMMANDS.has(lowered)) {
      if (risk === 'L0') {
        risk = 'L1';
        riskReasons.push(`${name} → L1（可逆写）`);
      }
      continue;
    }
    if (L0_COMMANDS.has(lowered)) {
      riskReasons.push(`${name} → L0（只读）`);
      continue;
    }
    risk = risk === 'L3' ? 'L3' : 'L2';
    riskReasons.push(`${name} → L2（未知命令，按保守默认处理）`);
    warnings.push(`未知 bash 命令 ${name}：按 L2 保守分级`);
  }

  // 子命令升级：git push / git reset --hard / npm install -g 等
  if (/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--)/i.test(normalized)) {
    risk = risk === 'L3' ? 'L3' : 'L2';
    riskReasons.push('git 写操作 → L2');
  }
  // 写系统路径
  for (const path of paths) {
    if (/^\/(etc|usr|bin|sbin|var|boot|dev|proc|sys)(\/|$)/.test(path)) {
      risk = 'L3';
      riskReasons.push(`${path} → L3（系统目录）`);
    }
  }
  // sed -i 属原地改写
  if (/\bsed\s+(-[a-z]*i)/i.test(normalized)) {
    risk = risk === 'L3' ? 'L3' : 'L2';
    riskReasons.push('sed -i 原地改写 → L2');
  }

  if (risk === 'L0') suggestions.push('当前为只读命令，可直接执行');
  else suggestions.push('调用后会返回 approvalId；确认 impact 后带 __approvalId 原样重发');

  if (blockReasons.length > 0) risk = 'L3';

  return {
    risk,
    blocked: blockReasons.length > 0,
    blockReasons,
    riskReasons,
    commands,
    paths,
    warnings,
    suggestions,
  };
}