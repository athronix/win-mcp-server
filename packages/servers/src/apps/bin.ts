#!/usr/bin/env node
import { runServer } from '../shared/runner.js';
import { appsCapabilities } from './capabilities.js';

const VERSION = '0.13.0';

const INSTRUCTIONS = [
  'win-mcp-apps：软件管理（应用清单 / winget 搜索 / 安装 / 卸载 / 启动）。',
  '只读工具（apps.list.installed、apps.winget.info、apps.winget.search）直接执行。',
  '已装检测默认走精确模式（逐个 winget list --id -e）；ids 超过 10 个会降级为一次 list + 子串匹配，结果里的 source 会写明精度。',
  '推荐走计划模式：apps.winget.plan 先预览（L1，无副作用），拿到 planId 与三分支状态（blocked / no-changes / ready），再带相同 operation/ids + planId + confirm=true 调 apps.winget.apply。',
  'planId 5 分钟过期、一次性；参数与预览不一致返回 PLAN_MISMATCH；blocked 计划执行返回 PLAN_BLOCKED；no-changes 计划执行不做任何动作。planId 只证明"与预览一致"，不代替用户同意。',
  'apps.winget.install / uninstall 为 L2 直连通道（跳过计划）：首次调用返回 APPROVAL_REQUIRED（此时未安装/未卸载），需用户明确批准后原样重发并带 __approvalId。有变更意图时优先用 plan/apply。',
  '第三方安装器不支持自动回滚：apply 返回 rollback 字段说明人工撤销方式；部分失败时 effectState=unknown，不要重试同一个 planId。',
  '安装可能耗时数分钟；请用返回的 exitCode 与 lines 判断结果，不要只看 ok。',
  'apps.app.launch 请传可执行名（如 notepad、code）；Program Files 下的绝对路径会被路径黑名单拒绝。',
].join('');

await runServer({
  name: 'win-mcp-apps',
  version: VERSION,
  instructions: INSTRUCTIONS,
  buildCapabilities: ({ bridge }) => appsCapabilities(bridge),
});