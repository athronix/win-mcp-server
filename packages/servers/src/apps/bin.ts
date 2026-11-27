#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { appsCapabilities } from './capabilities.js';

const VERSION = '0.5.0';

const INSTRUCTIONS = [
  'win-mcp-apps：软件管理（应用清单 / winget 搜索 / 安装 / 卸载 / 启动）。',
  '只读工具（apps.list.installed、apps.winget.info、apps.winget.search）直接执行。',
  'apps.winget.install / uninstall 为 L2：首次调用返回 APPROVAL_REQUIRED（此时未安装/未卸载），需用户明确批准后原样重发并带 __approvalId。',
  '安装可能耗时数分钟；请用返回的 exitCode 与 lines 判断结果，不要只看 ok。',
  'apps.app.launch 请传可执行名（如 notepad、code）；Program Files 下的绝对路径会被路径黑名单拒绝。',
].join('');

await runServer({
  name: 'win-mcp-apps',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => appsCapabilities(bridge),
});