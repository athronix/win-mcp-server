/**
 * 命令分级词表与硬禁模式 — 对应 FR-102
 *
 * 移植自本地 windows-capability-service 的 psmod/general.ps1:23-73，并做两处收敛：
 * 1) `exit` / `pause` 改为语义边界匹配，避免误伤 `C:\exit\...` 这类路径
 * 2) 硬禁模式以 RegExp 常量表达，避免字符串转义歧义
 *
 * 硬禁模式**不可通过审批放行**：命中即 blocked，风险强制 L3。
 */

export const GEN_MAX_CHARS = 8000;
export const GEN_MAX_STATEMENTS = 10;

/** L0 纯只读/变换：不改系统状态 */
export const GEN_L0: readonly string[] = Object.freeze([
  'select-object', 'where-object', 'sort-object', 'group-object', 'measure-object', 'compare-object',
  'foreach-object', 'format-table', 'format-list', 'format-wide', 'out-string',
  'convertto-json', 'convertfrom-json', 'write-output', 'write-host', 'write-verbose', 'write-warning',
  'test-path', 'get-item', 'get-childitem', 'get-content', 'get-process', 'get-service', 'get-eventlog',
  'get-winevent', 'get-ciminstance', 'get-date', 'get-random', 'get-location', 'get-command', 'get-member',
  'get-environmentvariable', 'get-volume', 'get-psdrive', 'get-netipaddress', 'get-nettcpconnection',
  'resolve-path', 'join-path', 'split-path', 'set-location', 'push-location', 'pop-location',
  'import-module', 'import-csv', 'new-variable', 'set-variable',
]);

/** L1 候选：用户域内可逆写；目标不在用户域则升级 L2 */
export const GEN_L1_WRITE: readonly string[] = Object.freeze([
  'new-item', 'set-content', 'add-content', 'copy-item', 'out-file', 'export-csv', 'export-clixml',
  'move-item', 'rename-item', 'new-itemproperty', 'set-itemproperty',
]);

/** L2 破坏性 / 系统态变更 */
export const GEN_L2: readonly string[] = Object.freeze([
  'remove-item', 'remove-itemproperty', 'clear-content', 'clear-item', 'clear-itemproperty',
  'set-item', 'start-process', 'stop-job', 'remove-job', 'wait-process', 'suspend-process', 'resume-process',
  'set-environmentvariable', 'remove-environmentvariable', 'new-environmentvariable',
  'set-timezone', 'set-date', 'set-service', 'stop-trace', 'remove-eventlog', 'clear-eventlog',
]);

/** L3 高危不可逆 */
export const GEN_L3: readonly string[] = Object.freeze([
  'restart-computer', 'stop-computer', 'shutdown',
  'new-localuser', 'remove-localuser', 'set-localuser', 'disable-localuser', 'enable-localuser',
  'add-localgroupmember', 'remove-localgroupmember', 'new-aduser', 'remove-aduser',
  'remove-service', 'new-service',
  'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'new-partition', 'set-disk', 'set-partition',
  'bcdedit', 'diskpart', 'takeown', 'icacls', 'cipher', 'robocopy',
  'set-executionpolicy', 'disable-windowsoptionalfeature', 'enable-windowsoptionalfeature',
  'remove-windowsfeature', 'install-windowsfeature', 'winget', 'choco', 'sc.exe', 'schtasks',
  'net.exe', 'netsh', 'reg.exe', 'taskkill', 'wmic', 'unregister-scheduledtask', 'register-scheduledtask',
]);

/** 硬禁模式（命中即 blocked，审批不可放行） */
export const GEN_BLOCK_PATTERNS: readonly RegExp[] = Object.freeze([
  /-enc(odedcommand)?\s/i,
  /FromBase64String/i,
  /\biex\b/i,
  /Invoke-Expression/i,
  /DownloadString\s*\(/i,
  /DownloadFile\s*\(/i,
  /Start-BitsTransfer/i,
  /curl\.exe[^\n|]*\|\s*iex/i,
  /\|\s*iex\b/i,
  /(?<![\w\\])exit(?![\w\\])/i,
  /Stop-Process[^\n]*-Id\s+\$PID/i,
  /Remove-Item[^\n]*\$PSHOME/i,
  /Read-Host/i,
  /(?<![\w\\])pause(?![\w\\])/i,
]);

/** L0 常见原生只读命令（非 cmdlet） */
export const GEN_L0_NATIVE: readonly string[] = Object.freeze([
  'ipconfig', 'ping', 'tracert', 'nslookup', 'systeminfo', 'tasklist', 'query', 'whoami',
  'hostname', 'dir', 'type', 'ls', 'cat',
]);

export function isL0Name(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('get-')) return true;
  if (GEN_L0.includes(n)) return true;
  if (GEN_L0_NATIVE.includes(n)) return true;
  return false;
}

export function isL1WriteName(name: string): boolean {
  return GEN_L1_WRITE.includes(name.toLowerCase());
}

export function isL2Name(name: string): boolean {
  return GEN_L2.includes(name.toLowerCase());
}

export function isL3Name(name: string): boolean {
  const n = name.toLowerCase();
  if (GEN_L3.includes(n)) return true;
  if (n.startsWith('stop-') || n.startsWith('restart-')) return true;
  if (n.startsWith('disable-') || n.startsWith('unregister-')) return true;
  return false;
}