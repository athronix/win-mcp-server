# PROJECT-OVERVIEW — win-mcp-servers

> DDD 场景 A（NEW-PROJECT）· Phase 1.1 项目概况 / 1.4 任务理解 / 1.5 变更目标
> 版本：v0.1.0 · 日期：2026-11-26 · 作者：agent
> 上游依据：`D:/Users/towyq/Documents/Projects/deep-research/win-mcp-skill-plugin/win-mcp-skill-16-proj-review.md` 第 3 章（16 项目深度调研 + 架构设计）

## 1.1 项目概况

### 要解决什么问题

在 Windows 上，AI Agent 需要安全、可控地完成六类操作：

| 业务目标 | 典型任务 |
|---|---|
| Windows 系统操作 | 查/改注册表、服务、进程、任务计划、账户、防火墙、事件日志、电源 |
| 软件操作管理 | 搜索、安装、升级、卸载、打开/关闭、功能项调整 |
| 浏览器操作 | 打开网页、读取、点击、填表、标签、下载、书签、登录态 |
| 桌面操作 | 截屏、窗口管理、UI 元素定位与点击、键鼠、剪贴板 |
| 系统及资源管理&优化 | CPU/GPU/内存/磁盘/进程指标、清理、调优与回滚 |
| 命令通道 | PowerShell / Git-Bash 任意命令（最高危） |

现成开源项目各有所长但都只覆盖一部分（详见上游第 1–2 章 16 项目调研）。本项目**站在巨人肩膀上**，取各家已验证的机制，做一个 6 server + 1 底座的完整产品。

### 交付形态

- **对外 6 个 MCP server**：`win-system` / `win-apps` / `win-browser` / `win-desktop` / `win-resource` / `win-shell`
- **1 个共享底座库** `@win-mcp/core`（不是第 7 个对外 server）：分级、策略、审批、审计、守卫、并发、传输、能力注册
- 传输：单端口 streamable-HTTP（回环）+ stdio 双模
- 每个 server 配一个 Skill bundle（`SKILL.md` + `references/`），教 Agent 场景 SOP

### 硬约束（来自用户与上游设计）

1. **仅 Windows**，不做跨平台抽象（`PlatformAdapter` 边界预留但不实现）。
2. **不重复造轮子**：分级/审批/策略/审计优先移植 `windows-capability-service` 已验证的实现；工具面借鉴 agent-desktop/agent-browser/BrowserSkill/winutil-cn/winget-cli。
3. **默认只读、拒绝优先**：写操作必须显式审批，红线不可通过审批绕过。
4. **密码/密钥不进 LLM 上下文**：沿用人类可见控制台 + auth vault 范式。
5. 文档驱动：本仓库一切代码必须先有文档定义（DDD 原则 7）。

## 1.4 任务理解

### 本轮任务范围（用户请求）

> 基于「win-mcp-servers 整体技术架构与业务功能结构设计」开始开发项目 `D:\Users\towyq\Documents\Projects\win-mcp-servers`，开发过程严格遵循 mcp-builder / ddd-skill / plan-first 三个 skill 的规范。

### 拆解

| # | 任务 | 归属阶段 |
|---|---|---|
| 1 | 建立 DDD 六索引与目录骨架 | T1 / Phase 1-2 |
| 2 | 写需求、技术方案、测试方案文档（含接口定义） | T1 / Phase 2 |
| 3 | 实现底座 `@win-mcp/core`：contracts / registry / classify / policy / approval / audit / guard / taskmgr | T2–T4 |
| 4 | 实现网关与传输：单端口多 server、stdio/HTTP、`/health` | T5 |
| 5 | 单测 + P0 审批分级 12 项冒烟 | T6 / Phase 4 |
| 6 | 配套文档、索引同步、原子提交 | T7 / Phase 6-7 |

### 明确不在本轮范围

- 6 个业务 server 的具体能力实现（注册表/服务/进程/winget/CDP/UIA…）——属后续 CL，本轮只保证**底座可承载**并留出注册入口。
- PowerShell 常驻桥的真实进程管理（需 Windows 运行时联调）——本轮先定义接口 + 可注入实现，真桥在 CL-002 落地。
- 浏览器扩展、书签 API、Git-Bash adapter——记录为已知缺口。

## 1.5 变更目标（验收标准）

本轮（v0.1.0）以「底座可信」为唯一目标：

| 编号 | 目标 | 可验证标准 |
|---|---|---|
| G1 | 能力模型可用 | `cap()` 归一化 + 三段式 ID 校验；单测通过 |
| G2 | 分级可信 | L0-L3 判级、13 条硬禁、未知命令 L2、路径感知升级、提权升级；单测通过 |
| G3 | 策略可信 | 拒绝优先 7 步（含 4b/4c）、数组并集不可删红线；单测通过 |
| G4 | 审批可信 | 两阶段 8 步、hash 绑定、TTL、一次性、掉包拒绝、防自我放权；单测 + 冒烟通过 |
| G5 | 审计可信 | HashChain 追加 + 篡改可检出 + 参数脱敏 |
| G6 | 守卫可信 | `expect[]` 动作前断言；`effect_state=unknown` 禁止盲重试 |
| G7 | 可交付 | `npm run build` 与 `npm test` 全绿；README/接入指南可用；索引与代码一致 |

> **不做完 G1–G6 不进入 6 个 server 的能力实现**——底座不可信时，上层能力越多风险越大。

## 1.1 补充：现状与依赖

### 上游可复用资产（本机已存在，只读参考）

| 资产 | 路径 | 用法 |
|---|---|---|
| 本地能力服务（分级/审批蓝本） | `C:/Users/towyq/.agents/mcps/windows-capability-service` | 阅读实现，重写为 TS（不直接依赖其 dist） |
| 上游调研与架构文档 | `D:/Users/towyq/Documents/Projects/deep-research/win-mcp-skill-plugin/` | 设计与来源映射依据 |

> 选择**重写而非直接依赖**的理由：原实现是编译后 JS + PowerShell 模块，且能力 ID/域模型与本项目 6 域不一致；TS 重写可获得类型约束与可测试性，同时保留其判定语义（逐条对照，差异写入 ADR）。

### 运行环境

| 项 | 值 |
|---|---|
| OS | Windows（win32），交互会话 |
| Node | v22.22.2 |
| 包管理 | npm 12.0.1（workspaces）；pnpm 12.11.2 可用 |
| 网络 | registry = registry.npmmirror.com；HTTP(S)_PROXY 指向本机代理 |
| 注意 | 本地联调优先 `localhost`（解析 ::1），避免 NekoBox TUN 拦截 `127.0.0.1` 裸 TCP |