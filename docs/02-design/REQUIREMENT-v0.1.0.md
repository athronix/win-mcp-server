# REQUIREMENT-v0.1.0 — 底座 `@win-mcp/core` 需求基线

> DDD Phase 2.1 · 状态：已基线化 · 日期：2026-11-26
> 范围：v0.1.0 只交付共享底座，不含 6 个 server 的业务能力实现。

## 1. 功能需求（FR）

### FR-101 能力注册与归一化

| 项 | 要求 |
|---|---|
| 能力 ID | 三段式 `<domain>.<group>.<action>`，小写字母/数字/连字符，段内不得为空 |
| 域白名单 | `system \| apps \| browser \| desktop \| resource \| shell \| meta` |
| 归一化 | `cap(spec)` 补齐默认值：`idempotent=false`、`requiresSession=false`、`destructive=false`、`dynamicRisk=false`、`policyControl=false`、`timeoutMs=30000`、`snapshot='none'`、`output=空对象 schema` |
| 破坏性兜底 | `destructivePath=true` 时自动附加 `commandDenylist: ['\\bdel\\s+/s\\s+/q','\\brm\\s+-rf']`，与调用方 policy 合并 |
| 分组 | `groupByDomain()` 返回按域分组的只读视图；`assertCapabilityId()` 非法即抛错 |
| 唯一性 | 同一注册表内能力 ID 重复即抛错（fail-fast） |

### FR-102 操作分级（classify）

| 项 | 要求 |
|---|---|
| 四档 | L0 只读 / L1 用户域可逆写 / L2 破坏性或系统态变更 / L3 高危不可逆 |
| 词表判级 | 命令名 → L3/L2/L1/L0；L3 含 `stop-*`/`restart-*`/`disable-*`/`unregister-*` 前缀规则 |
| 未知命令 | 按 **L2 保守**处理并记 warning（fail-closed） |
| 硬禁 | 13 条模式（`-enc`、`FromBase64String`、`iex`、`Invoke-Expression`、`DownloadString(`、`DownloadFile(`、`Start-BitsTransfer`、`curl|iex`、`IEX` 管道、`exit`、杀 `$PID`、删 `$PSHOME`、`Read-Host`/`pause`）→ `blocked=true` 且 `risk=L3`，**不可审批放行** |
| 语法 | 解析器报告语法错误 → `syntaxValid=false`、`blocked=true`、`risk=L3`，不进入审批链 |
| 路径感知 | 存在 L1 写命令且（有非用户域明确路径 或 无用户域路径）→ 升 L2；`HKLM\` → 升 L2 |
| 提权 | `runAsAdmin=true` + 任何写/破坏命令 → L3；纯只读 + 提权 → 至少 L2 |
| 取最大 | 多命令取最高级；`blocked` 强制 L3 |
| 解析器可注入 | `analyzeCommand({ command, runAsAdmin, parser })`；`parser` 返回命令名/路径/语法错误。默认使用保守 fallback 解析器，并在结果标注 `parser:'fallback'` |

### FR-103 策略判定（policy）

| 项 | 要求 |
|---|---|
| 判定顺序 | 1 能力未注册 → 2 路径黑名单 → 3 命令黑名单 → 4 路径白名单 → 4b 注册表读写范围 → 4c 进程黑名单 → 5 maxRisk 封顶（仅显式声明时） → 6 审批闸 → 7 通过 |
| 拒绝优先 | 任一黑名单命中立即 `POLICY_DENIED`，不进入审批 |
| 路径提取 | 命令型参数须用 `extractPathTokens()` 抽取内嵌路径，防"整条命令当路径"绕过 |
| glob | `**` 跨分隔符、`*` 不跨、大小写不敏感；匹配时补尾分隔符比对，避免目录自身被误杀 |
| 注册表 | 写默认仅 `HKCU:\**`/`HKEY_CURRENT_USER\**`；读含 `HKLM:\SOFTWARE\**`；按能力 ID 末端动词判定读/写 |
| 进程保护 | `lsass/csrss/winlogon/services/smss/wininit/ntoskrnl/system/win-mcp-*` 禁止操作 |
| autoApprove | 默认 `{enabled:false, maxRisk:'L2'}`；只跳过人工确认，**不绕过任何黑名单/白名单/进程保护/风险封顶** |
| 配置合并 | 数组合并集（用户无法删除红线）；标量用户优先 |
| forceApproval | 为 true 时无视 autoApprove，强制 `APPROVAL_REQUIRED` |

### FR-104 审批（approval）

| 项 | 要求 |
|---|---|
| 触发 | 风险 ≥ L2 且未获批准 |
| 首次拦截 | 生成 `apr_*`，存 pending，**不调用执行器**，返回 `isError:false + ok:false + error.code=APPROVAL_REQUIRED + approval{approvalId,risk,capabilityId,preview,impact,resumeHint}` |
| 参数绑定 | `paramsHash = sha256(capabilityId + '\0' + canonicalJson(params))`；canonical 序列化按键排序，保证同参数同 hash |
| 掉包 | 能力 ID 或 hash 不符 → 销毁 pending，返回 `APPROVAL_MISMATCH`（`isError:true`） |
| TTL | 默认 120000ms，超时删除 pending，按未审批处理 |
| 一次性 | 消费（delete）在**执行前**完成；二次使用同一 ID 视为无效 |
| 三分支归一 | `local`（`__approvalId`）/ `plan`（`planId`+`confirmPlan`）/ `elicitation`（协议同意）；凭证前缀与域绑定双重校验，**互不可冒用** |
| 防自我放权 | `policyControl` 能力：`rank = enabled ? (maxRisk==='L3'?3:2) : 0`；target>current = loosen → `effectiveRisk=L3` + `forceApproval=true`；其余 L1 直放 |
| 宿主边界 | 服务端不感知弹卡内容；只校验第二次请求是否带合法凭证 |

### FR-105 审计（audit）

| 项 | 要求 |
|---|---|
| 结构 | `{seq, ts, traceId, capabilityId, risk, paramsHash, outcome, paramsRedacted, prevHash, hash}` |
| 链式 | `hash = sha256(prevHash + canonicalJson(entry 不含 hash))`；`verify()` 返回 `{valid, brokenAtSeq?}` |
| 记录时机 | 拒绝、审批拦截、掉包、自动批准、执行成功、执行失败全部记录 |
| 脱敏 | 键名命中 `password|passwd|secret|token|apikey|api_key|credential|cookie|authorization` 的值替换为 `***`；长字符串截断 |
| 只增 | 不提供删除/修改 API |

### FR-106 写动作守卫（guard）

| 项 | 要求 |
|---|---|
| 断言 | `expect[]` ≤16 条，`{path, op:'equals'|'exists'|'contains', value?}`；动作执行**前**对当前事实求值 |
| 失败 | 任一断言失败 → `GUARD_ASSERTION_FAILED`，不执行动作 |
| 效果态 | 执行后返回 `effectState: 'none'|'committed'|'unknown'` |
| unknown 账本 | `unknown` 必须 `resolve()` 核销后才允许同目标再次写；未核销时重试 → `EFFECT_UNKNOWN` |

### FR-107 并发控制（taskmgr）

| 项 | 要求 |
|---|---|
| 分类上限 | `DESKTOP=1`（互斥）、`SHELL=3`、`FILE=5`、`QUERY=10` |
| 行为 | 超限排队；支持超时；`release()` 幂等 |
| 可观测 | `stats()` 返回各分类 running/queued |

### FR-108 传输与网关

| 项 | 要求 |
|---|---|
| 单端口 | streamable-HTTP 单端口 + 域路径路由（`/mcp/system` 等）；stdio 双模 |
| 回环 | 默认仅绑定 `localhost`/`::1`；非回环需显式 `--allow-remote` + token |
| instructions | 每个 server ≤4096 字节，写明"审批必须由用户确认、不可跳过" |
| /health | 返回 `ok`、`chainValid`、能力数、各分类并发统计 |
| 工具注册 | 统一装饰：注入 `__approvalId`、annotations、envelope；`readOnlyHint` 由 risk=L0 推导，不一致即启动失败 |

### FR-109 统一返回与错误码

| 项 | 要求 |
|---|---|
| envelope | `{traceId, ok, risk, data?, artifacts?, auditRef?, durationMs?, approval?, autoApproved?, error?, effectState?}` |
| 错误码 | `APPROVAL_REQUIRED/APPROVAL_MISMATCH/POLICY_DENIED/ADMIN_REQUIRED/PREFLIGHT_UNAVAILABLE/PREFLIGHT_FAILED/INVALID_SYNTAX/COMMAND_BLOCKED/STALE_REF/AMBIGUOUS_TARGET/TIMEOUT/UNKNOWN_CAPABILITY/INVALID_PARAMS/PROVIDER_UNAVAILABLE/EFFECT_UNKNOWN/GUARD_ASSERTION_FAILED/INTERNAL` |
| isError 语义 | 仅"审批请求"为 `isError:false`；其余失败均为 `isError:true` |

## 2. 非功能需求（NFR）

| 编号 | 要求 |
|---|---|
| NFR-1 | 安全默认 fail-closed：任何不确定（未知命令/解析失败/预检不可用）均按更高风险或直接拒绝 |
| NFR-2 | TypeScript strict，禁用 `any`（`unknown` + 类型守卫替代） |
| NFR-3 | 底座逻辑层零 IO 依赖（时间/随机/hash 可注入），保证 100% 可单测 |
| NFR-4 | 判级与策略为纯 CPU 规则，单次 <5ms；审批查找 O(1) |
| NFR-5 | 底座不 import 任何 Windows-only API；平台能力由上层注入 |
| NFR-6 | 文档逻辑一致性：所有导出 API 在 `INTERFACE-DEFINITION-core.md` 有签名，代码与文档不符即缺陷 |
| NFR-7 | 可观测：每个操作有 traceId；审计链可校验 |

## 3. 需求 → 测试追溯

| 需求 | 测试文件 | 关键用例 |
|---|---|---|
| FR-101 | `registry.test.ts` | ID 格式、默认值、重复注册、destructivePath 兜底 |
| FR-102 | `classify.test.ts` | 13 硬禁、未知 L2、用户域 L1/越界 L2、提权 L3、语法错误 |
| FR-103 | `policy.test.ts` | 拒绝优先、4b 注册表、4c 进程、并集、autoApprove 不绕红线 |
| FR-104 | `approval.test.ts` + `smoke` | 首次拦截、原样重发、改参掉包、TTL、一次性、放权 L3 |
| FR-105 | `audit.test.ts` | 链校验、篡改检出、脱敏 |
| FR-106 | `guard.test.ts` | 断言失败阻断、unknown 禁重试、resolve 后可重试 |
| FR-107 | `semaphore.test.ts` | DESKTOP 互斥、超时、release 幂等 |
| FR-108/109 | `gateway.test.ts` + `smoke` | tools/list、instructions 长度、/health、envelope 一致性 |