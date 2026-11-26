# TEST-PLAN-v0.1.0 — 底座测试方案与用例

> DDD Phase 2.3 · 日期 2026-11-26 · 框架：vitest
> 原则：测试先于实现；每条用例都能追溯到 FR；安全相关用例必须"失败即红"，不允许以跳过方式通过。

## 1. 测试策略

| 层级 | 范围 | 工具 | 准入 |
|---|---|---|---|
| 单元 | contracts / registry / classify / policy / approval / audit / guard / taskmgr | vitest | 全部通过才允许 build 发布 |
| 集成 | ToolGate 8 步编排（注入假 executor，不触真实系统） | vitest | 同上 |
| 冒烟 | P0 分级/审批 12 项（含 stdio 工具可见性） | `scripts/smoke.mjs` | 12/12 通过 |
| 手工 | MCP Inspector 连 stdio 看 tools/list（可选） | MCP Inspector | 不作为门禁 |

**不做**：真实系统写操作、UI 自动化、浏览器 CDP（本轮无业务 server）。

## 2. 用例清单

### 2.1 registry.test.ts（FR-101）

| ID | 用例 | 输入 | 期望 |
|---|---|---|---|
| R-01 | ID 三段式合法 | `system.info.get` | 通过，domain=`system` |
| R-02 | 缺段非法 | `system.info` | throw `INVALID_CAPABILITY_ID` |
| R-03 | 未知域非法 | `foo.bar.baz` | throw |
| R-04 | 大写/空格非法 | `System.Info.Get` | throw |
| R-05 | 默认值归一 | 最小 spec | `idempotent=false,requiresSession=false,dynamicRisk=false,policyControl=false,timeoutMs=30000,snapshot='none'` |
| R-06 | destructivePath 兜底 | `destructivePath:true` | policy.commandDenylist 含 `del /s /q` 与 `rm -rf` |
| R-07 | 重复注册 | 同 ID 两次 | throw |
| R-08 | 分组 | 3 域各 2 个 | `byDomain` 各 2，`list()` 6 |
| R-09 | annotations 推导 | risk=L0 未给 annotations | `readOnlyHint=true` |
| R-10 | 静态 risk 与 readOnly 冲突 | risk=L2 + readOnlyHint=true | throw（启动失败） |

### 2.2 classify.test.ts（FR-102）

| ID | 用例 | 输入 command | 期望 |
|---|---|---|---|
| C-01 | 只读 L0 | `Get-Process` | risk=L0, blocked=false |
| C-02 | 用户域写 L1 | `Set-Content -Path $env:USERPROFILE\a.txt` | risk=L1 |
| C-03 | 越界写升 L2 | `Set-Content -Path C:\Windows\a.txt` | risk=L2 |
| C-04 | 无路径写升 L2 | `Set-Content -Value x` | risk=L2 |
| C-05 | 破坏性 L2 | `Remove-Item foo.txt` | risk=L2 |
| C-06 | 高危 L3 | `Restart-Computer` | risk=L3 |
| C-07 | 前缀规则 L3 | `Stop-Service spooler` | risk=L3 |
| C-08 | 未知命令 L2 | `MyCustomTool -x` | risk=L2 + warning |
| C-09 | HKLM 升 L2 | `Get-Item HKLM:\SYSTEM` | risk=L2 |
| C-10 | 硬禁 `iex` | `iex (New-Object Net.WebClient)` | blocked=true, risk=L3 |
| C-11 | 硬禁 `-enc` | `powershell -enc AAAA` | blocked=true（外壳拦截） |
| C-12 | 硬禁 `DownloadString` | `$c.DownloadString('http://x')` | blocked=true |
| C-13 | 硬禁 `exit` | `Write-Output 1; exit` | blocked=true |
| C-14 | 提权+写 L3 | `Set-Content a.txt`, runAsAdmin | risk=L3 |
| C-15 | 提权只读 >=L2 | `Get-Process`, runAsAdmin | risk=L2 |
| C-16 | 语法错误 | `Get-Process -Name (` | syntaxValid=false, blocked=true, risk=L3 |
| C-17 | 超长 | 8001 字符 | blocked=true, reason 含长度 |
| C-18 | 空命令 | `   ` | blocked=true |
| C-19 | 多命令取最大 | `Get-Process; Remove-Item a` | risk=L2 |
| C-20 | 解析器注入 | parser 返回 custom | 结果 `parser:'powershell-ast'` |
| C-21 | 用户域判定 | `$env:TEMP\x` / `C:\Windows` | true / false |

### 2.3 policy.test.ts（FR-103）

| ID | 用例 | 期望 |
|---|---|---|
| P-01 | glob `**` 跨分隔符 | `C:\Users\a\b` 命中 `C:\Users\**` |
| P-02 | glob `*` 不跨 | `C:\Users\a\b` 不命中 `C:\Users\*` |
| P-03 | 目录自身匹配 | `C:\Users` 命中 `C:\Users\**` |
| P-04 | 大小写不敏感 | `c:\windows\x` 命中 `C:\Windows\**` |
| P-05 | 路径黑名单优先 | 写 `C:\Windows\a` → `POLICY_DENIED`，非 APPROVAL_REQUIRED |
| P-06 | 命令黑名单 | command 含 `Invoke-Expression` → `POLICY_DENIED` |
| P-07 | 命令内嵌路径 | `Get-ChildItem C:\Windows` → 命中路径黑名单 |
| P-08 | 注册表写白名单 | `HKCU:\Software\X` 允许；`HKLM:\SOFTWARE\X` 拒绝（写能力） |
| P-09 | 注册表读白名单 | `HKLM:\SOFTWARE\X` 允许（读能力） |
| P-10 | 进程保护 | terminate `lsass` → `POLICY_DENIED` |
| P-11 | 风险封顶仅显式 | 无 maxRisk 时 L3 不被封顶；maxRisk=L2 时 L3 拒绝 |
| P-12 | 需审批 | L2 未批准 → `requiresApproval:true` |
| P-13 | autoApprove 默认关 | L2 → `APPROVAL_REQUIRED` |
| P-14 | autoApprove L2 | enabled,maxRisk=L2 → L2 通过 + `autoApproved:true`；L3 仍需审批 |
| P-15 | forceApproval 覆盖 auto | enabled,maxRisk=L3 + forceApproval → 仍需审批 |
| P-16 | 并集不可删红线 | override 空数组 → 默认红线仍在 |
| P-17 | 未注册能力 | 未知 capabilityId → `POLICY_DENIED`（注：由 registry 层保证，引擎侧校验空 id） |

### 2.4 approval.test.ts（FR-104）

| ID | 用例 | 期望 |
|---|---|---|
| A-01 | canonical 稳定 | 键序不同的等价对象 → 同 hash |
| A-02 | 嵌套数组稳定 | 嵌套对象数组 → 同 hash |
| A-03 | 首建 | `create()` → `apr_` 前缀、createdAtMs、branch |
| A-04 | 消费成功 | 同 capId+hash → `ok:true` |
| A-05 | 掉包-capId | 不同 capId → `APPROVAL_MISMATCH`，条目被销毁 |
| A-06 | 掉包-参数 | 改一个参数 → mismatch |
| A-07 | 一次性 | 同一 ID 第二次 consume → 失败 |
| A-08 | TTL 过期 | now+120001 → 失败（按未审批） |
| A-09 | sweep | 过期条目被清理，size 归零 |
| A-10 | 放权判定 loosen | current{false}→target{true,L2} → direction=loosen, risk=L3, forceApproval=true |
| A-11 | 收紧 tighten | current{true,L2}→target{false} → tighten, L1, false |
| A-12 | 不变 unchanged | 相同 → unchanged, L1, false |
| A-13 | 升级 L2→L3 | loosen（rank 2→3），L3 |

### 2.5 audit.test.ts（FR-105）

| ID | 用例 | 期望 |
|---|---|---|
| U-01 | 追加链 | 3 条 → seq 1..3，prevHash 正确串联 |
| U-02 | 校验通过 | `verify().valid=true` |
| U-03 | 篡改检出 | 改第 2 条 paramsRedacted → `valid=false, brokenAtSeq=2` |
| U-04 | 脱敏 | `password/token/cookie` → `***`；普通字段保留 |
| U-05 | 只读视图 | `entries()` 返回值不可改内部状态 |

### 2.6 guard.test.ts（FR-106）

| ID | 用例 | 期望 |
|---|---|---|
| G-01 | equals 通过 | facts 一致 → ok |
| G-02 | equals 失败 | 值变 → ok=false，failures[0] 带 path/expected/actual |
| G-03 | exists | 缺失 → 失败 |
| G-04 | contains | 子串命中/未命中 |
| G-05 | 超限 | 17 条 → normalize 抛错 |
| G-06 | unknown 阻断重试 | record unknown → assertRetryable 同 target = false |
| G-07 | resolve 后可重试 | resolve(committed) → allowed=true |
| G-08 | 不同 target 不受影响 | 其它 target 未核销不影响本 target |

### 2.7 semaphore.test.ts（FR-107）

| ID | 用例 | 期望 |
|---|---|---|
| S-01 | DESKTOP 互斥 | 第二个 acquire 排队，release 后进入 |
| S-02 | SHELL=3 | 3 个并发通过，第 4 个排队 |
| S-03 | 超时 | timeoutMs=10 → reject TIMEOUT |
| S-04 | release 幂等 | 连续调用两次不报错、不多减 |
| S-05 | stats | running/queued/limit 数值正确 |

### 2.8 gate.test.ts + smoke（FR-104/108/109，集成）

| ID | 用例 | 期望 |
|---|---|---|
| T-01 | L0 直放 | 不产生 approval，executed=true |
| T-02 | L2 首次拦截 | `isError:false, ok:false, APPROVAL_REQUIRED`，**executor 未被调用** |
| T-03 | 原样重发 | 带 approvalId 成功，executed=true，audit 有 executed |
| T-04 | 改参掉包 | 改参数 → `APPROVAL_MISMATCH`，executor 未调用 |
| T-05 | 二次使用 | 再用同 ID → 失败 |
| T-06 | 硬禁不入审批 | dynamic classify blocked → `COMMAND_BLOCKED`，**无 approvalId 返回** |
| T-07 | 策略拒绝不入审批 | 黑名单 → `POLICY_DENIED`，无 approvalId |
| T-08 | 放权强制审批 | runPolicyControl loosen → L3 + forceApproval，即使 autoApprove 开启 |
| T-09 | 审计完整性 | 上述各情形后 `verify().valid=true` |
| T-10 | effectState 透传 | executor 返回 unknown → envelope 带 `effectState:'unknown'` |
| T-11 | tools/list 可见 | stdio 连上后能看到注册的能力工具名 |
| T-12 | /health chainValid | HTTP 模式 `/health` 返回 `chainValid:true` |

## 3. 通过标准

| 维度 | 阈值 |
|---|---|
| 单元 + 集成 | 100% 通过，0 skip |
| 冒烟 | 12/12 |
| 类型 | `tsc --noEmit` 0 error |
| 覆盖率（安全模块） | classify/policy/approval/audit ≥ 85% 行覆盖（v0.1.0 目标，非门禁） |
| 文档一致性 | 所有导出符号在 TECHNICAL-SOLUTION 中有签名 |

## 4. 已知不可测项（本轮）

| 项 | 原因 | 后续 |
|---|---|---|
| PowerShell 真 AST 解析 | 需 Windows + pwsh 常驻桥 | CL-002，用 `parser` 注入点接真实现 |
| 真实注册表/进程写操作 | 底座不含业务能力 | 各 server CL |
| 浏览器/桌面真机动作 | 同上 | 各 server CL |