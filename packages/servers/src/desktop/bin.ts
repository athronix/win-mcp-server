#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { desktopCapabilities } from './capabilities.js';

const VERSION = '0.8.0';

const INSTRUCTIONS = [
  'win-mcp-desktop：桌面操作（截图 / 窗口 / 剪贴板 / UIA 语义树 / 受控键鼠 / 桌面门控）。',
  '桌面自动化的标准循环：desktop.ui.snapshot 拿带 ref 的语义树 → desktop.ui.act 按 ref 操作 → 读返回的 readback 验证 → UI 变化后重新快照。',
  'ref 形如 @s3:e12，只在生成它的快照内有效；裸 @e8 会被拒绝。跨快照使用会返回 STALE_REF，双胞胎元素会返回 AMBIGUOUS_TARGET —— 两者都应重新快照，不要猜。',
  '优先用语义动作（click 会先试 invoke/toggle/selection 控件模式），只有无控件模式时才回退物理鼠标；allowMouseFallback=false 可强制语义路径。',
  'desktop.ui.act 与 desktop.input.send 为 L2：首次返回 APPROVAL_REQUIRED，需用户确认后原样重发并带 __approvalId。',
  '两者还受桌面门控约束：按策略（relaxed/balanced/strict）可能弹倒计时对话框征求控制权。用户移动鼠标即夺回控制，后续调用返回 USER_CONTROL —— 这是正常语义，不是故障，别重试，先确认是否继续。',
  'denied 时返回 CONTROL_DENIED。无人值守场景由 WIN_MCP_DESKTOP_CONSENT_SECONDS=0 关闭弹窗（默认 10 秒）。',
  'desktop.control.policy 是 L3 强制人工审批：放宽门控等于允许 AI 静默干扰用户，不要代用户决定。',
  '截屏返回 PNG 文件路径（在 %TEMP% 下），不是 base64。',
].join('');

await runServer({
  name: 'win-mcp-desktop',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => desktopCapabilities(bridge),
});