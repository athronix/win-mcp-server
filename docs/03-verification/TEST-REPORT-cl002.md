# TEST-REPORT-cl002 — 桥与真 AST 验证报告

> DDD Phase 4（CL-002）· 日期：2026-11-26 · 被测：`@win-mcp/core` bridge 模块
> 结论：**全量 139 测试通过，桥冒烟 6/6，底座冒烟 12/12 无回归，类型 0 error。**

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows 10.0.26300 |
| pwsh | 7.6.10（Core） |
| Windows PowerShell | 5.1.26100（回退目标） |
| 当前会话 | **非提权**（`elevated=false`） |
| Node / TS | 22.22.2 / 5.7.x |
| MCP SDK | 1.32.2 |

## 2. 执行结果

| 关卡 | 命令 | 结果 |
|---|---|---|
| 构建 | `npm run build` | ✅ |
| 类型 | `npm run typecheck` | ✅ 0 error |
| 全量测试 | `npm test` | ✅ **139 passed / 12 files / 0 skip** |
| 底座冒烟 | `npm run smoke` | ✅ 12/12 |
| 桥冒烟 | `npm run smoke:bridge` | ✅ **6/6** |
| 文档门禁 | `npm run verify:docs` | ✅ 45 个关键 API 对齐 |

## 3. 覆盖率（关键模块）

| 模块 | Stmts | Branch |
|---|---|---|
| `bridge/`（bridge + ast + protocol 汇总） | **84.38%** | 72.84% |
| `bridge/bridge.ts` | 84.56% | 73.41% |
| `approval/gate.ts` | 92.43% | 75.36% |
| `policy/engine.ts` | 96.85%（含 module 汇总） | 87.58% |
| `classify`（汇总） | 93.54% | 84.93% |

> `bridge` 达到 ≥80% 目标。未覆盖的主要是 `start()` 的异常分支与 `stop()` 的 SIGKILL 兜底路径。

## 4. 冒烟明细

```
PASS  BR-01  桥启动（C:\Program Files\PowerShell\7\pwsh.exe 7.6.10, elevated=false）
PASS  BR-02  纯注释命令 → 无命令、无动态调用（修复 fallback 误升）
PASS  BR-03  语法错误 → syntaxValid=false 且带行列号
PASS  BR-04  硬禁命令经 classifier → COMMAND_BLOCKED（不产生审批）
PASS  BR-05  受控执行 → 输出 2
PASS  BR-06  注释命令端到端放行（不再被注释里的路径误拒）
```

## 5. 实现中发现并修复的缺陷（4 个）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `parse` 一律返回 `BRIDGE_ERROR: Argument types do not match` | **`$errors` 与 PowerShell 自动变量 `$Error` 同名**，赋值被忽略，后续构造字典时类型错乱 | 全部改名 `$errorList` |
| 2 | 修 #1 后仍同样报错（定位到 `[ordered]@{...}` 行） | **PowerShell 7.6 对 `@($list)`（`List[object]` 且元素为 OrderedDictionary）抛 "Argument types do not match"**，而 `List[string]` 正常 | 统一改用 `.ToArray()` |
| 3 | `invoke` 报"找不到属性 maxOutputChars" | `StrictMode -Version 2` 下访问 PSCustomObject 不存在的属性会抛异常 | StrictMode 降为 1（与已验证的本地实现一致）+ `PSObject.Properties[...]` 安全读取 |
| 4 | **纯注释命令被 `POLICY_DENIED`** | 分级用 AST（`commands=[]`，L0），但策略层仍用正则从命令原文抽路径，把注释里的 `C:\Windows\x` 当成真实目标 | 新增 `PolicyRequest.pathEvidence`：命令型参数只信任 AST 证据 |

> #4 是架构级问题，不是小 bug：**分级与策略必须共用同一份事实**。已在
> `TECHNICAL-SOLUTION-bridge.md §4.4` 记录，并加了 P-21/P-22/P-23、T-15/T-16、R-11/R-12、BR-06 共 8 条回归用例。

## 6. 与 fallback 的行为对比（实测）

| 命令 | fallback | 真 AST | 说明 |
|---|---|---|---|
| `# Remove-Item C:\Windows\x` | L2（`#` 当未知命令） | L0 | 误升消除 |
| here-string 含 `Remove-Item` | L2 | L0 | 误升消除 |
| `Get-Item -Path "$env:USERPROFILE\a.txt"` | L0 + 路径 | L0 + 路径 | 一致 |
| `Get-Process -Name (` | 括号不配（无行列） | 带 line/column | 定位更准 |
| `& $sb` | blocked | dynamicCalls | 一致 |
| `Remove-Item foo.txt` | L2 | L2 | 一致 |

**收益是"减少误升与误拒"，不是"修补漏放"**——fallback 从不漏放，只是太吵。

## 7. 遗留风险

| 项 | 说明 | 后续 |
|---|---|---|
| runspace `Stop()` 无法打断同步死循环 | PowerShell 只在管道边界响应停止；桥进程可能卡死 | Node 侧请求超时后 `stop()` 兜底杀进程；已实现 |
| 执行结果未结构化 | `invoke` 只返回文本 + stderr | 各 server CL 按 cmdlet 适配 |
| 跨多次调用的会话状态不保留 | 每次 `invoke` 用独立 runspace（隔离优先） | 如需状态，CL-004 引入显式会话 |
| 错误消息本地化 | PS 返回中文错误（系统语言） | 上层不得依赖文案匹配，只透传 |
| `runAsAdmin` 仅判级 | 非提权会话不会真的提权 | CL-004 接 UAC / 可见控制台 |

## 8. 结论

CL-002 的 G1–G6 全部达成：真 AST 可用（G1）、语义准确（G2）、路径完整（G3）、桥健壮（G4）、零回归（G5）、与 gate 对接（G6）。
下一步可安全进入 **CL-003 `win-system`** 与 **CL-004 `win-shell`**。