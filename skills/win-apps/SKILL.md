---
name: win-apps
description: 软件管理（已安装清单、winget 搜索/安装/卸载、启动应用）。
tags: [windows, apps, winget, mcp]
triggers:
  - 装了哪些软件 / 应用清单
  - 安装软件 / 卸载软件
  - winget
  - 启动应用
requirements: [win-mcp-apps]
risk: L0-L2
---

# win-apps 场景手册

## 能力速查

| 工具 | 风险 | 说明 |
|---|---|---|
| `apps.list.installed` | L0 | 注册表 Uninstall 汇总（名称/版本/发布者/卸载命令） |
| `apps.winget.info` | L0 | winget 是否可用与版本 |
| `apps.winget.search` | L0 | 搜索包（返回 exitCode + 前 80 行） |
| `apps.winget.install` | L2 | 安装（silent，自动接受协议；**审批**） |
| `apps.winget.uninstall` | L2 | 卸载（**审批**） |
| `apps.app.launch` | L1 | 按命令名启动应用 |

## SOP

### 安装软件
1. `apps.winget.info` → 确认 `available=true`
2. `apps.winget.search { query: "vscode" }` → 从 `lines` 里找精确包 ID
3. `apps.winget.install { id: "Microsoft.VisualStudioCode" }` → **审批**（展示包 ID 与影响）
4. 批准后原样重发；用返回 `exitCode === 0` 判断成功，再看 `lines`
5. `apps.list.installed { filter: "Visual Studio Code" }` 核验

### 卸载软件
1. `apps.list.installed { filter }` → 找到确切名称
2. `apps.winget.uninstall { id }` → **审批**
3. 卸载后再 `apps.list.installed` 确认已不在列表

### 启动应用
`apps.app.launch { name: "notepad" }` —— 传可执行名，**不要传 `C:\Program Files\...` 绝对路径**（路径黑名单会拒）。

## 不要做

- 安装大包时不要反复重试（超时先查 `apps.list.installed` 是否已装上）
- 不要用 `apps.list.installed` 判断"软件能否卸载"——它只列注册表项，能否卸载看 `uninstallString`
- 卸载系统组件（Edge/WebView2/VC++ 运行库）前必须提醒用户风险