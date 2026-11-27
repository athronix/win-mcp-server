# 进行中的变更

> 当前无进行中变更。

## 已完成机制总览

| 机制 | 参考项目 | CL |
|---|---|---|
| UIA 语义树 + ref | agent-desktop / FlaUI-MCP | CL-011 |
| 受控键鼠注入 | CursorTouch Windows-MCP | CL-011 |
| 桌面门控（三档 + 倒计时同意 + 夺回 + 琥珀指示器） | CursorTouch | CL-011 / CL-015 |
| CDP 页面自动化 + 等待 | agent-browser / BrowserSkill | CL-012 / CL-015 |
| CDP attach 复用登录态 | BrowserSkill（共享控制思路） | CL-016 |
| planId 三分支 + backupId 回滚 | winutil-cn | CL-013 |
| 调优快照 + 一键回滚（含服务项） | agentic-workstation-optimizer | CL-014 / CL-016 |
| 服务端等待（UIA / CDP） | agent-desktop `wait` | CL-015 |

## 仍待补（需要时再做）

| 项 | 说明 |
|---|---|
| UIA 真事件订阅 | wait 已是服务端轮询（命中 ~86ms），但没有 Automation 事件回调 |
| 浏览器文件上传/下载、iframe 递归 | CDP 侧未做，`browser.cdp.eval` 可绕过 |
| 浏览器遮挡检测 | `element.click()` 会绕过遮挡 |
| 桌面批量动作 | FlaUI-MCP 的 batch 未做，多步需多次调用 |
