# CONTEXT-ANALYSIS-cl002 — PowerShell 常驻桥与真 AST 解析

> DDD 场景 D（现有项目继续完善）· Phase 1.2 现状分析 / 1.4 任务理解 / 1.5 目标
> 日期：2026-11-26 · 前置版本：v0.1.0（底座已完成）

## 1. 现状

### 1.1 v0.1.0 已有的

- `classify/command.ts` 的判级主流程完整（词表、硬禁、路径感知、提权升级）
- `classify/parser.ts` 提供 `CommandParser` 注入点，默认 `fallbackParser`（正则 + 状态机）
- `approval/gate.ts` 的 `DynamicClassifier` 是 **async** 接口，天然容纳"先 await 解析、再判级"
- 判级结果已验证：106 单测 + 12 冒烟全绿

### 1.2 缺什么

**没有真正的 PowerShell 语法解析，也没有命令执行通道。** 具体三处：

1. `fallbackParser` 无法识别语义结构（注释、here-string、嵌套子表达式、动态调用），只能靠正则猜
2. 无法执行命令（demo 全部 simulated），`win-shell` / `win-system` 都缺执行层
3. `runAsAdmin` 只能判级，无法感知"当前会话是否已提权"

## 2. 问题定位（实测证据）

对同一批命令，fallback 与真 AST 的差异：

| 命令 | fallback 结果 | 真 AST 应有结果 | 性质 |
|---|---|---|---|
| `# Remove-Item C:\Windows\x` | risk=L2，commands=[`#`] | 无命令 → L0 | **误升**（注释被当命令） |
| `@"…Remove-Item C:\Windows\x…"@`（here-string） | risk=L2，commands=[`@`] | 无命令 → L0 | **误升** |
| `Write-Output "Remove-Item"` | L0 | L0 | 一致 |
| `Get-Item -Path "$env:USERPROFILE\a.txt"` | L0，paths 正确 | L0 | 一致 |
| `Set-Content -Path (Join-Path $env:USERPROFILE "a.txt")` | L2（无路径） | L2（子表达式不可静态求值） | 一致（都保守） |
| `& $cmd` | blocked（动态调用） | dynamicCalls 命中 | 一致 |

**结论：fallback 不会漏放（所有偏差都是偏保守），代价是"注释/here-string 也要走一次审批"** —— 这会显著增加日常使用摩擦，是本次要解决的主要问题。

另外两条实测事实（作为实现依据）：

1. **`StringConstantExpressionAst` 会包含命令名本身**（`Get-Process` 被当成字符串常量），因此采集路径时必须把命令名排除，否则 "C:\..." 校验前会多出一堆命令名噪音
2. **双引号字符串（`ExpandableStringExpressionAst`）不在 `StringConstant` 中** —— 本地 `windows-capability-service` 只查 `StringConstant`，`"$env:USERPROFILE\a.txt"` 这类路径会漏采；本次必须同时采集两类

## 3. 任务理解

### 输入

用户指令："继续" —— 承接 v0.1.0 交付说明中的 CL-002：**PowerShell 常驻桥 + 真 AST 解析注入**。

### 范围（本轮做）

| # | 内容 |
|---|---|
| 1 | `ps-bridge.ps1`：NDJSON 请求循环，`op = ping/info/parse/invoke` |
| 2 | `parse`：官方 `Parser::ParseInput`，返回语法错误（含行列）、命令名、路径、动态调用 |
| 3 | `invoke`：独立 runspace 执行 + 超时 `Stop()` + 输出截断 |
| 4 | `info`：pwsh 版本、edition、是否提权、PID |
| 5 | `PowerShellBridge`（Node）：spawn、分帧、id 匹配、超时、崩溃重启、可执行文件回退 |
| 6 | `parseWithBridge` / `analyzeCommandWithBridge` / `createBridgeClassifier`：与底座无缝对接 |
| 7 | 测试：协议层单测（fake spawn）+ 真机集成（skipIf 无 pwsh）+ 冒烟 |

### 明确不做

- 人类可见控制台、密码不进 AI（PowerShell.MCP 范式）→ **CL-004**（win-shell）
- `runAsAdmin` 的实际提权（`Start-Process -Verb RunAs`）→ CL-004；本轮只做**提权状态检测 + 非提权直接 ADMIN_REQUIRED**
- 命令执行结果的结构化解析（每个 cmdlet 单独适配）→ 各 server CL
- Git-Bash 通道 → CL-004

## 4. 目标与验收

| 编号 | 目标 | 可验证标准 |
|---|---|---|
| G1 | 真 AST 可用 | `parse('Get-Process -Name (')` 返回 `syntaxValid=false` 且 errors 含 line/column |
| G2 | 语义准确 | 注释、here-string 不被当命令（与 fallback 的偏差消失） |
| G3 | 路径完整 | `"$env:USERPROFILE\a.txt"` 与 `C:\Windows\a.txt` 均被采集 |
| G4 | 桥健壮 | 请求超时→TIMEOUT；桥崩溃→pending 全 reject 且可重启；pwsh 缺失→回退 powershell，都缺→明确报错 |
| G5 | 零回归 | 底座 106 单测仍全绿；新增桥测试全绿；冒烟 12+5 全过 |
| G6 | 与 gate 对接 | `createBridgeClassifier` 返回的 classifier 可直接传给 `ToolGate`；桥不可用时 → `PREFLIGHT_UNAVAILABLE` |

## 5. 风险与约束

| 风险 | 说明 | 应对 |
|---|---|---|
| PowerShell 单线程无法中断同步脚本 | `& $sb` 里的死循环无法被 `Stop()` 打断（runspace Stop 只在管道边界生效） | 用 runspace + `BeginInvoke` + 超时 `Stop()`；仍卡住则杀死桥进程并重启（Node 侧兜底） |
| 编码 | 中文输出乱码 | 桥启动设 `[Console]::OutputEncoding = UTF8` + `$OutputEncoding = UTF8`，Node 侧按 utf8 解码 |
| stdout 污染 | PS 模块的 Write-Host 会写 stdout，破坏 NDJSON | 桥内重定向 `Write-Host`/`Write-Output`（协议输出用 `[Console]::Out.WriteLine`），诊断走 stderr |
| 可执行文件差异 | pwsh 7 与 WinPS 5.1 的 AST API 一致，但 `ConvertTo-Json` 深度默认 2 | 统一 `-Depth 8 -Compress` |
| 提权语义 | 当前会话非提权，`runAsAdmin` 不能静默降级 | 桥返回 `elevated:false`，上层对 `runAsAdmin=true` 直接 `ADMIN_REQUIRED` |