#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { createShellClassifier, shellCapabilities } from './capabilities.js';

const VERSION = '0.4.0';

const INSTRUCTIONS = [
  'win-mcp-shell：PowerShell 与 Git-Bash 命令通道（最高危 server）。',
  '执行前先用 shell.analyze 预检 PowerShell 命令，确认分级与解析出的路径。',
  'shell.invoke / shell.bash 是动态分级：L0 直放，L2/L3 返回 APPROVAL_REQUIRED（此时未执行），需用户明确批准后原样重发并带 __approvalId。',
  '硬禁命令（-enc/iex/DownloadString|iex/curl|sh/eval/rm -rf //exit 等）直接返回 COMMAND_BLOCKED，没有审批通道，也不要把它们包装进脚本绕过。',
  'runAsAdmin 在非提权会话直接返回 ADMIN_REQUIRED；不要用其它工具尝试提权。',
].join('');

await runServer({
  name: 'win-mcp-shell',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => shellCapabilities(bridge),
  buildClassifier: ({ bridge }) => createShellClassifier(bridge),
});