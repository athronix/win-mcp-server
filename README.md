# win-mcp-servers

Windows 系统 / 软件 / 浏览器 / 桌面 / 资源 / 命令通道 的 MCP server 套件。

**当前版本 v0.1.0：共享底座 `@win-mcp/core` 已可用，6 个业务 server 待接入（见路线图）。**

## 设计目标

让 AI Agent 安全地操作 Windows：默认只读、拒绝优先、写操作两阶段审批、全量审计、可回滚。

- **6 个对外 server + 1 个共享底座**（底座是库，不是第 7 个 server）
- 分级 **L0–L3** + 动态 AST 判级 → 决定"能不能执行 / 要不要审批 / 能否自动批准"
- **两阶段审批**：首次只登记 `approvalId`（系统状态不变），用户确认后同参数重发才执行
- 参数哈希绑定 + TTL + 一次性消费 → 防掉包、防重放
- HashChain 审计 + 参数脱敏 → 可追溯、可校验

设计来源：16 个开源项目的深度调研（见 `docs/01-investigation/PROJECT-OVERVIEW.md` 上游依据）。

## 快速开始

```bash
npm install
npm run build

npm test              # 139 条单元/集成测试（含真机 AST）
npm run smoke         # 12 项分级/审批冒烟（真实 MCP 客户端）
npm run smoke:bridge  # 6 项 PowerShell 桥冒烟（真机 pwsh）
npm run check         # build + typecheck + test + 两个冒烟 + 文档门禁
```

跑一个演示 server（不执行任何真实系统写操作）：

```bash
node examples/demo-server.mjs               # stdio（内置保守 fallback 解析）
node examples/demo-server.mjs --ps          # stdio + 真 PowerShell AST
node examples/demo-server.mjs --http 8765   # HTTP + /health
```

**`--ps` 会启动常驻 pwsh 桥**（`ps/ps-bridge.ps1`），用于官方 AST 解析与受控执行；
桥启动失败会自动回退 fallback，并在 stderr 说明原因。

## 已实现的 server

| server | 入口（stdio） | 能力数 | 状态 |
|---|---|---|---|
| `win-system` | `node packages/servers/dist/system/bin.js` | 13 | ✅ v0.10.0（含备份回滚） |
| `win-shell` | `node packages/servers/dist/shell/bin.js` | 4 | ✅ v0.4.0 |
| `win-apps` | `node packages/servers/dist/apps/bin.js` | 8 | ✅ v0.10.0（plan/apply） |
| `win-resource` | `node packages/servers/dist/resource/bin.js` | 9 | ✅ v0.11.0（含调优回滚） |
| `win-desktop` | `node packages/servers/dist/desktop/bin.js` | 12 | ✅ v0.14.0（UIA + 键鼠 + 门控 + wait/watch） |
| `win-browser` | `node packages/servers/dist/browser/bin.js` | 16 | ✅ v0.13.0（书签 + CDP + wait + attach） |

system 能力：`system.info.get`、`service.list/control`、`process.list/terminate`、`eventlog.query`、`task.list`、`registry.read/write`、`startup.list`、`network.get`。
只读全部 L0 直放；服务控制/结束进程/写注册表为 L2，走审批；受保护进程与 HKLM 写由策略直拒。

## 架构

```
MCP Client (WorkBuddy / Claude Code / Cursor)
        │  stdio 或 streamable-HTTP（回环）
        ▼
┌──────────────────────────────────────────────┐
│ @win-mcp/core（单实例，6 server 共用）        │
│ contracts → registry → classify → policy     │
│   → approval（两阶段 + 三分支归一）           │
│   → audit（HashChain） / guard / taskmgr      │
│   → transport（MCP 网关）                     │
└──────────────────────────────────────────────┘
```

| 包/目录 | 说明 |
|---|---|
| `packages/core/src/contracts` | 风险等级、错误码、能力模型、统一 envelope |
| `packages/core/src/classify` | L0–L3 词表、14 条硬禁、AST 判级（可注入） |
| `packages/core/src/bridge` | PowerShell 常驻桥（NDJSON）、真 AST 解析、受控执行 |
| `packages/core/ps/ps-bridge.ps1` | 桥脚本：`ping/info/parse/invoke` |
| `packages/core/src/policy` | glob、默认红线、拒绝优先 7 步判定 |
| `packages/core/src/approval` | 参数哈希、审批表、防自我放权、8 步编排 |
| `packages/core/src/audit` | HashChain + 脱敏 + 校验 |
| `packages/core/src/guard` | `expect[]` 断言 + `effect_state` 账本 |
| `packages/core/src/transport` | `registerTool` 装饰、stdio/HTTP、`/health` |

## 安全模型（不可协商）

1. 硬禁命令、语法错误、预检不可用 → **进审批链之前** fail-closed
2. 黑名单/进程保护/风险封顶被拒 → 审批无法绕过
3. `autoApprove` 只跳过人工确认，不绕过任何红线，且默认关闭
4. 策略放权（`policyControl`）→ 强制 L3 审批，绕过 `autoApprove`
5. 审批凭证一次性、TTL 120s、与 `能力ID + 全部参数` 哈希绑定
6. 密码/密钥不进 LLM 上下文，审计中脱敏为 `***`

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| v0.1.0 | 底座：分级/策略/审批/审计/守卫/并发/网关 | ✅ |
| CL-002 | PowerShell 常驻桥 + 真 AST 解析注入 | ✅ |
| CL-003 | `win-system`（注册表/服务/进程/事件日志） | ✅ |
| CL-004 | `win-shell`（命令通道 + Git-Bash adapter） | ✅ |
| CL-005 | `win-apps`（winget + 应用清单） | ✅ |
| CL-006 | `win-resource`（指标 + 磁盘 + 清理） | ✅ |
| CL-007 | `win-desktop`（截图/窗口/剪贴板） | ✅ |
| CL-008 | `win-browser`（书签 + 打开 URL） | ✅ |
| CL-009/010 | 6 个 Skill bundle + 客户端接入包 | ✅ |
| CL-011 | `win-desktop`：UIA 语义树 + 受控键鼠 + 桌面门控 | ✅ |
| CL-012 | `win-browser`：CDP 通道（导航/快照/动作/断言/截图/tabs） | ✅ |
| CL-013 | 计划与回滚：planId 三分支 + backupId 逆序恢复 | ✅ |
| CL-014 | 资源调优：声明式目录 + 快照 + 一键回滚 | ✅ |
| CL-015 | 等待机制（UIA / CDP）+ 门控视觉指示器 | ✅ |
| CL-016 | CDP attach 复用登录态 + 服务类调优项 + winget 精确已装检测 | ✅ |
| CL-017 | 跨请求 watch（arm/status）+ 移除会卡死的事件/渲染宿主探测 | ✅ |

## 文档

| 文档 | 内容 |
|---|---|
| `docs/01-investigation/PROJECT-OVERVIEW.md` | 背景、任务理解、验收目标 |
| `docs/02-design/REQUIREMENT-v0.1.0.md` | FR/NFR 需求基线 |
| `docs/02-design/TECHNICAL-SOLUTION-core.md` | **代码唯一行为来源**（接口签名/数据模型/实现逻辑） |
| `docs/02-design/TEST-PLAN-v0.1.0.md` | 用例清单与通过标准 |
| `docs/03-verification/TEST-REPORT-v0.1.0.md` | 验证结果、覆盖率、遗留风险 |
| `docs/04-peripherals/DEPLOYMENT-GUIDE.md` | 接入配置与排障 |
| `docs/04-peripherals/USER-GUIDE.md` | 能力清单与审批交互 |
| `skills/<server>/SKILL.md` | 6 个场景手册（能力速查 + SOP + 不要做） |
| `examples/clients/mcp.json` | 6 server 的客户端接入配置 |

## 许可

私有项目（`private: true`），未发布到 npm。