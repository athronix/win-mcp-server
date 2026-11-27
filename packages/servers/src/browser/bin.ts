#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { browserCapabilities } from './capabilities.js';

const VERSION = '0.6.0';

const INSTRUCTIONS = [
  'win-mcp-browser：浏览器操作（书签读写 + 打开网页）。本版本不通过 CDP 控制页面，不支持点击/填表/截图网页。',
  '书签操作必须先 browser.profile.list 拿到 profilePath，再 browser.bookmark.list 查看现有书签与 id。',
  'browser.bookmark.add / delete 为 L2：首次返回 APPROVAL_REQUIRED，需用户确认后原样重发；写入前自动备份原文件（返回 backupPath）。',
  '重要：修改书签前必须让用户关闭浏览器，否则浏览器退出时会用内存状态覆盖 Bookmarks 文件。',
  'browser.url.open 只接受 http/https，会用默认浏览器新开标签页。',
].join('');

await runServer({
  name: 'win-mcp-browser',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => browserCapabilities(bridge),
});