#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { browserCapabilities } from './capabilities.js';

const VERSION = '0.12.0';

const INSTRUCTIONS = [
  'win-mcp-browser：浏览器操作。两条通道别混用：书签走 Bookmarks 文件（browser.bookmark.*），页面操作走 CDP（browser.cdp.*）。',
  '页面自动化标准循环：browser.cdp.launch → browser.cdp.snapshot 拿 @b<N>:e<M> ref → browser.cdp.act 操作 → 读 readback 或重新快照验证。',
  'CDP 默认用独立 profile（%LOCALAPPDATA%\\win-mcp\\browser-profile）：没有你的登录态与扩展，但也不会污染日常浏览器。要复用真实登录态属已知边界。',
  'ref 只对本次快照有效；导航或框架重建后必须重新快照，否则返回 STALE_REF。动作前的 expect 是字面断言（≤16 条），页面已变就失败而不是硬点。',
  'launch/navigate/act/tab.close 为 L2：首次返回 APPROVAL_REQUIRED，需用户确认后原样重发并带 __approvalId。browser.cdp.eval 是 L3，必须人工审批。',
  '导航 load 超时不等于失败（SPA 可能仍在加载）：先 snapshot 看实际状态，不要盲目重试导航。',
  '等待不要靠反复快照：browser.cdp.wait 支持 selector / text / urlContains，命中后附一份新快照（ref 可直接用），超时抛 TIMEOUT。',
  '书签通道：先 browser.profile.list 拿 profilePath，再 bookmark.list/add/delete。修改前必须让用户关闭浏览器，否则浏览器退出会用内存状态覆盖 Bookmarks 文件。',
  '目标若是 Electron 桌面程序而非浏览器：UIA 通常拿不到语义树（desktop.ui.snapshot 会在 warnings 里说明），改用 CDP 连它的调试端口，不要硬啃 UIA。',
].join('');

await runServer({
  name: 'win-mcp-browser',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => browserCapabilities(bridge),
});