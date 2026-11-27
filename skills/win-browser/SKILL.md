---
name: win-browser
description: 浏览器书签读写（Chrome/Edge，直接改 Bookmarks JSON）与打开网页。不做页面点击/填表。
tags: [windows, browser, bookmarks, chrome, edge, mcp]
triggers:
  - 书签 / 收藏夹
  - 添加书签 / 删除书签
  - 浏览器配置文件
  - 打开网页
requirements: [win-mcp-browser]
risk: L0-L2
---

# win-browser 场景手册

## 能力速查

| 工具 | 风险 | 说明 |
|---|---|---|
| `browser.profile.list` | L0 | Chrome/Edge 配置目录与 Bookmarks 路径 |
| `browser.bookmark.list` | L0 | 书签扁平列表（id/名称/URL/文件夹） |
| `browser.bookmark.add` | L2 | 加书签到书签栏（**审批** + 自动备份） |
| `browser.bookmark.delete` | L2 | 按 id/url 删除（**审批** + 自动备份） |
| `browser.url.open` | L1 | 默认浏览器打开 http/https |

## SOP

### 添加书签（严格按序）
1. `browser.profile.list` → 选 `browser` + `profile`，得到 `bookmarksPath`
2. **提醒用户关闭浏览器**（关键：浏览器退出时会用内存状态覆盖文件，写入会丢）
3. `browser.bookmark.add { profilePath, name, url }` → **审批**（展示 name/url）
4. 批准后返回 `backupPath` 与 `id`
5. `browser.bookmark.list { profilePath, filter: "<名称>" }` 核验

> `profilePath` 是配置目录（如 `...\User Data\Default`），不是 Bookmarks 文件路径。

### 删除书签
1. `browser.bookmark.list { profilePath, filter }` → 拿到 `id` 与 `url`
2. 向用户确认要删哪一条（同名书签可能多条）
3. `browser.bookmark.delete { profilePath, id }` → **审批**
4. 返回 `removed` 数量；`backupPath` 可回滚

### 打开网页
`browser.url.open { url: "https://..." }` —— 只接受 http/https。

## 不要做

- 不要承诺"帮你在网页里点按钮/填表"——本 server 不接 CDP
- 浏览器运行中不要写书签（应明确拒绝并让用户先关闭）
- 不要一次列全部书签（默认 500，可按 `filter` 缩小）
- Firefox 不支持（`places.sqlite` 结构不同）