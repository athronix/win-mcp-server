# TEST-PLAN-cl002 — 桥与真 AST 测试方案

> DDD Phase 2.3（CL-002）· 日期 2026-11-26 · 框架 vitest 2.1.9

## 1. 分层策略

| 层 | 依赖 | 目的 | 门禁 |
|---|---|---|---|
| 协议单测 | 无（纯函数） | NDJSON 编解码容错 | 必须全绿 |
| 桥单测 | 注入假进程（`spawnImpl`） | 请求匹配/超时/退出/回退/重启 | 必须全绿 |
| 真机集成 | 真 `pwsh`（`describe.skipIf`） | AST 语义与执行正确 | 有 pwsh 时必须全绿 |
| 冒烟 | 真 `pwsh` + dist | 端到端（含 gate 贯通） | 6/6 |

## 2. 用例

### 2.1 协议（`protocol.test.ts`，6 条）

| ID | 用例 | 期望 |
|---|---|---|
| P-01 | 编码 | 单行 JSON + `\n` |
| P-02 | 解析成功响应 | 含 data/durationMs |
| P-03 | 解析失败响应 | 含 code/message/details |
| P-04 | 非协议内容 | 空行/横幅/半行 JSON/数组/null → `undefined` |
| P-05 | 结构不合法 | 缺 id、缺 error、ok 非布尔 → `undefined` |
| P-06 | `id:null` 失败响应 | 可解析（服务端无法定位请求） |

### 2.2 桥（`bridge.test.ts`，10 条，假进程）

| ID | 用例 | 期望 |
|---|---|---|
| B-01 | start | 返回 info；完成 `ping`→`info` 握手 |
| B-02 | call | 按 id 匹配响应 |
| B-03 | 请求超时 | `TIMEOUT`；pending 归零 |
| B-04 | 桥退出 | pending 全 reject `BRIDGE_EXITED` |
| B-05 | 非协议行 | 忽略并记诊断，不影响后续请求 |
| B-06 | 远端 ok:false | `BRIDGE_REMOTE` |
| B-07 | pwsh 缺失 | 回退 `powershell`，info.executable 记录正确 |
| B-08 | 两者都缺 | `BRIDGE_UNAVAILABLE` |
| B-09 | stop 后调用 | `BRIDGE_UNAVAILABLE` |
| B-10 | 迟到响应 | 丢弃，不产生未处理异常 |

### 2.3 真机 AST（`ast-bridge.test.ts`，12 条，需 pwsh）

| ID | 用例 | 期望 |
|---|---|---|
| R-01 | `info` | version 匹配、elevated 为布尔 |
| R-02 | 语法错误 | `syntaxValid=false`，errors 带 line/column |
| R-03 | 注释 / here-string | `commands=[]`（修复 fallback 误升） |
| R-04 | 双引号路径 | `paths` 含 `$env:USERPROFILE\a.txt` |
| R-05 | 动态调用 | `dynamicCalls` 非空、`commands=[]` |
| R-06 | `Remove-Item foo.txt` | L2，未 blocked |
| R-07 | 纯注释 | L0（fallback 会误判 L2） |
| R-08 | 硬禁经 classifier | `COMMAND_BLOCKED`，risk=L3 |
| R-09 | 桥未启动 | classifier fail-closed 为 `PREFLIGHT_UNAVAILABLE` |
| R-10 | 提权只读 | ≥ L2 |
| R-11 | 注释经 classifier | `paths=[]`、无 blocked |
| R-12 | 真实路径 | `paths` 含 `C:\Windows` |

### 2.4 冒烟（`scripts/smoke-bridge.mjs`，6 项）

| ID | 项 |
|---|---|
| BR-01 | 桥启动并返回版本/提权状态 |
| BR-02 | 纯注释 → 无命令（回归 fallback 误升） |
| BR-03 | 语法错误 → 带行列号 |
| BR-04 | 硬禁经 classifier → `COMMAND_BLOCKED` |
| BR-05 | `invoke` 执行 `Write-Output (1+1)` → `2` |
| BR-06 | 注释命令端到端经 gate 放行（路径证据贯通回归） |

## 3. 通过标准

| 项 | 阈值 |
|---|---|
| 全量测试 | 139 条全绿，0 skip（有 pwsh 时） |
| 桥冒烟 | 6/6 |
| 底座冒烟 | 12/12（不得回归） |
| 类型 | 0 error |
| bridge 模块覆盖率 | ≥ 80% 行覆盖 |
| 文档一致性 | 45 个关键 API 对齐 |

## 4. 不可测项

| 项 | 原因 |
|---|---|
| runspace `Stop()` 打断同步死循环 | PowerShell 只能在管道边界响应停止；由 Node 侧杀死桥兜底 |
| `runAsAdmin` 真实提权 | 需 UAC 交互，属 CL-004 |
| 多客户端并发共享桥 | 单桥单进程模型，未设计 |