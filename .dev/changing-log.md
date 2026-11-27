# 进行中的变更

> 当前无进行中变更。

## 已补齐的五个机制（对应参考项目）

| 机制 | 参考项目 | 落地 |
|---|---|---|
| UIA 语义树 + ref | agent-desktop / FlaUI-MCP | CL-011 `desktop.ui.snapshot` / `ui.act` |
| 受控键鼠注入 | CursorTouch Windows-MCP | CL-011 `desktop.input.send` |
| 桌面门控（三档 + 倒计时同意 + 夺回） | CursorTouch | CL-011 `desktop.control.*` |
| CDP 页面自动化 | agent-browser / BrowserSkill / chrome-devtools-mcp | CL-012 `browser.cdp.*` |
| planId 三分支 + backupId 回滚 | winutil-cn | CL-013 `apps.winget.plan/apply` + `system.backup.*` |
| 调优快照 + 一键回滚 | agentic-workstation-optimizer | CL-014 `resource.tune.*` |

## 仍待补（需要时再做）

| 项 | 说明 |
|---|---|

| 桌面控制视觉指示器 | 只有同意对话框，无屏幕边缘指示 |
| 浏览器真实登录态复用 | 需先退出日常浏览器再带调试端口启动 |
| 服务类调优项 | 备份数据结构已支持，目录里还没放 |
