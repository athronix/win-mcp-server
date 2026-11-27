# 客户端接入

`mcp.json` 是 6 个 server 的完整 stdio 配置。把 `args[0]` 里的绝对路径换成你的仓库位置，`WIN_MCP_AUDIT_SECRET` 换成自己的值。

## 各客户端放置位置

| 客户端 | 位置 | 说明 |
|---|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | 直接把 `mcpServers` 合并进去 |
| Cursor | 项目 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json` | 格式相同 |
| WorkBuddy | 连接器/自定义 MCP 配置页 | 粘贴同等 JSON |
| 其他 MCP 客户端 | 任意支持 stdio 的客户端 | `command` + `args` 即可 |

## 只启用需要的 server

按需删掉不需要的条目。建议日常只挂 `win-system` + `win-resource`（只读为主、审批少），
需要跑命令时再临时加 `win-shell`。

## HTTP 模式

不用 stdio 时，单独启动一个 server：

```bash
WIN_MCP_HTTP_PORT=8765 node packages/servers/dist/system/bin.js
curl http://localhost:8765/health
```

客户端填 `http://localhost:8765/mcp`（**用 `localhost` 而非 `127.0.0.1`**，避免本机代理/TUN 拦截）。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即退出，stderr 有 `PowerShell 桥启动失败` | 本机没有 pwsh/powershell | 安装 PowerShell 7，或确认 PATH |
| 工具调用报 `BRIDGE_UNAVAILABLE` | 桥进程被外部杀掉 | 重启 server；客户端会自动重连 |
| 写操作报 `pathAllowlist:miss` | 目标不在默认白名单（`C:\Users\**` 等） | 在 runner 的 policy 中加白 |
| 审批卡不出现 | 客户端把 `isError:false` 结果当失败隐藏 | 检查客户端是否展示 structuredContent |
| 中文乱码 | 终端编码 | 桥已设 UTF-8；检查客户端控制台编码 |

## 审批交互要点

1. 首次调用 L2 工具返回 `error.code=APPROVAL_REQUIRED` + `approval.impact`
2. 把 `impact` / `preview` 展示给用户
3. 用户批准后，**用完全相同的参数** 加 `__approvalId` 重发
4. 参数有任何变化 → `APPROVAL_MISMATCH`（凭证作废，需重新发起）

详见 `docs/04-peripherals/USER-GUIDE.md`。