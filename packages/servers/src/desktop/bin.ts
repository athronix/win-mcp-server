#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { desktopCapabilities } from './capabilities.js';

const VERSION = '0.6.0';

const INSTRUCTIONS = [
  'win-mcp-desktop：桌面操作（截屏 / 窗口枚举与控制 / 剪贴板）。',
  '推荐顺序：desktop.window.list 拿到 handle 与标题 → 需要时 desktop.window.control 操作。',
  'desktop.window.control（close/minimize/maximize/restore/activate）为 L2：首次返回 APPROVAL_REQUIRED，需用户确认后原样重发并带 __approvalId。关闭窗口可能导致未保存内容丢失。',
  '截屏返回 PNG 文件路径（在 %TEMP% 下），不是 base64；需要时可再读取该文件。',
  '本 server 不含 UIA 元素定位与键鼠注入（留后续版本），不要假设能点击界面元素。',
].join('');

await runServer({
  name: 'win-mcp-desktop',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => desktopCapabilities(bridge),
});