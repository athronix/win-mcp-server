---
name: win-desktop
description: 桌面操作（截屏、窗口枚举与控制、剪贴板）。不含 UIA 元素定位与键鼠注入。
tags: [windows, desktop, screenshot, window, clipboard, mcp]
triggers:
  - 截屏 / 屏幕截图
  - 窗口列表 / 最小化 / 最大化 / 关窗口
  - 剪贴板
requirements: [win-mcp-desktop]
risk: L0-L2
---

# win-desktop 场景手册

## 能力速查

| 工具 | 风险 | 说明 |
|---|---|---|
| `desktop.screen.capture` | L0 | 全屏（多显示器）截图 → PNG 路径；`maxWidth` 可缩放 |
| `desktop.window.list` | L0 | 可见窗口（handle/标题/进程） |
| `desktop.window.control` | L2 | minimize/maximize/restore/activate/close（**审批**） |
| `desktop.clipboard.get` | L0 | 读剪贴板文本 |
| `desktop.clipboard.set` | L1 | 写剪贴板文本（会覆盖用户内容） |

## SOP

### "看看我的屏幕"
1. `desktop.screen.capture { maxWidth: 1280 }` → 得到 `path`
2. 用文件读取能力加载该 PNG 展示给用户（路径在 `%TEMP%`）

### "把某个窗口关掉/最小化"
1. `desktop.window.list { filter: "记事本" }` → 拿到 `handle` 与 `title`
2. 向用户确认"是关闭《标题》吗"
3. `desktop.window.control { handle, action: "close" }` → **审批**
4. 返回 `visible` 可用于核验

### 剪贴板传值
`desktop.clipboard.set { text }` —— L1 直放，但会覆盖用户剪贴板，操作前提示一句。

## 不要做

- 不要假设能"点击按钮"——本 server 没有 UIA / 键鼠注入
- 不要连续枚举窗口几百个（`maxItems` 默认 100）
- `close` 可能让应用丢未保存内容：先确认，或用 `minimize` 替代
- 截图是文件路径而非图片数据；客户端不支持读文件时，只能拿到路径