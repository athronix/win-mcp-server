# TEST-REPORT-v0.1.0 — 底座验证报告

> DDD Phase 4 · 日期：2026-11-26 · 被测版本：`@win-mcp/core@0.1.0`
> 结论：**单元/集成 106 条全绿，冒烟 12/12，类型检查 0 error，构建成功。**

## 1. 环境

| 项 | 值 |
|---|---|
| OS | Windows (win32) |
| Node | v22.22.2 |
| TypeScript | 5.7.x（strict，`noUncheckedIndexedAccess`） |
| vitest | 2.1.9（+ @vitest/coverage-v8 2.1.9） |
| MCP SDK | @modelcontextprotocol/sdk 1.32.2 |
| zod | 3.25.76 |

## 2. 执行结果

| 关卡 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 error |
| 构建 | `npm run build` | ✅ dist 生成 |
| 单元 + 集成 | `npm test` | ✅ **106 passed / 9 files，0 skip** |
| 冒烟（真实 MCP 客户端） | `npm run smoke` | ✅ **12/12** |
| 文档-代码一致性 | `npm run verify:docs` | ✅ 37 个关键 API 对齐 |

## 3. 用例执行明细

| 测试文件 | 条数 | 覆盖需求 |
|---|---|---|
| `registry.test.ts` | 10 | FR-101（ID 校验、默认值、destructivePath 兜底、注解读导冲突） |
| `classify.test.ts` | 23 | FR-102（L0-L3、硬禁、路径感知、提权、语法错误、注入解析器、动态调用） |
| `policy.test.ts` | 20 | FR-103（glob、拒绝优先、注册表读写、进程保护、autoApprove、并集、命令白名单） |
| `approval.test.ts` | 13 | FR-104（canonical hash、TTL、一次性、掉包、防自我放权四方向） |
| `audit.test.ts` | 6 | FR-105（链串联、篡改定位、脱敏、副本隔离、traceId 检索） |
| `guard.test.ts` | 9 | FR-106（equals/exists/contains、≤16 条、unknown 禁重试、resolve） |
| `semaphore.test.ts` | 5 | FR-107（DESKTOP 互斥、SHELL=3、超时、release 幂等、stats） |
| `gate.test.ts` | 14 | FR-104/109（8 步编排、硬禁/策略拒绝不入审批、放权强制、effectState、TIMEOUT） |
| `gateway.test.ts` | 6 | FR-108/109（审批不置 isError、instructions 上限、非回环拒绝） |

## 4. 覆盖率（vitest --coverage）

核心模块（排除 examples/scripts/index 汇总文件）：

| 模块 | Stmts | Branch |
|---|---|---|
| `approval/gate.ts` | 90.66% | 71.42% |
| `approval/hash.ts` | 95.23% | 65.21% |
| `approval/policy-control.ts` | 100% | 100% |
| `approval/store.ts` | 87.95% | 100% |
| `audit/chain.ts` | 96.77% | 88.57% |
| `classify/command.ts` | 92.70% | 83.33% |
| `classify/parser.ts` | 91.30% | 85.07% |
| `classify/vocab.ts` | 100% | 88.23% |
| `policy/engine.ts` | 98.68% | 86.30% |
| `policy/glob.ts` | 92.55% | 88.09% |
| `policy/defaults.ts` | 100% | 85.71% |
| `guard/expect.ts` | 88.17% | 75% |
| `guard/ledger.ts` | 100% | 94.44% |
| `taskmgr/semaphore.ts` | 100% | 95% |
| `transport/gateway.ts` | 43.53% | 84.61% |

> **整体 70.15%** 是被 `examples/demo-server.mjs`、`scripts/*.mjs`、`src/index.ts`（纯汇总）等**非逻辑文件**拉低的。
> 按计划只有 classify/policy/approval/audit ≥85% 是目标：**四者全部达标**。
> `gateway.ts` 的 HTTP 分支（70-212 行）未被单测覆盖，由冒烟的 `/health` + stdio 端到端覆盖（T-11/T-12）。

## 5. 冒烟 12 项（真实 MCP stdio 客户端 + HTTP /health）

```
PASS  T-11  tools/list 暴露全部 5 个能力
PASS  T-01  L0 直放（无审批、ok=true）
PASS  T-02  L2 首次拦截：APPROVAL_REQUIRED 且 isError 未置位、含 impact
PASS  T-03  原样重发执行成功并落审计
PASS  T-04  改参数 → APPROVAL_MISMATCH 且 isError=true
PASS  T-05  凭证一次性：二次使用被拒
PASS  T-06  硬禁命令 COMMAND_BLOCKED，无 approvalId
PASS  T-07  语法错误 INVALID_SYNTAX，不入审批
PASS  T-08  提权只读 → 至少 L2 并触发审批
PASS  T-09  放权强制 L3 审批且提示不受 autoApprove 影响
PASS  T-10  路径黑名单 POLICY_DENIED，无审批通道
PASS  T-12  /health 返回 chainValid=true 且能力数正确
```

## 6. 实施中发现并修正的缺陷

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 空命令/动态调用未标 `blocked` | 只在语法错误分支设置 `blocked` | 末尾统一 `blockReasons.length>0 → blocked=true` |
| 2 | 审计 `entries()` 浅拷贝导致内部可被改写 | `{...entry}` 未复制 `paramsRedacted` | 改 `structuredClone` |
| 3 | 工具参数被 zod strip 成空对象 | 能力未声明 schema 时 `z.object({})` 默认剥离未知键 | schema 加 `.passthrough()` |
| 4 | `policyControl` 能力无法通过 MCP 调用 | 网关统一走 `gate.run()`，被 gate 拒绝 | 网关识别 `policyControl` → `runPolicyControl()` + `PolicyControlProvider` |

## 7. 未覆盖项与风险（诚实记录）

| 项 | 现状 | 影响 | 后续 |
|---|---|---|---|
| PowerShell 真 AST 解析 | 未接入，使用保守 `fallbackParser` | 复杂语法（如 here-string、嵌套子表达式）判级可能偏保守（升 L2），但**不会漏放** | CL-002 接 pwsh 常驻桥，通过 `parser` 注入 |
| 真实系统写操作 | 未执行（demo 全部 simulated） | 无法验证注册表/服务/进程写入的实际结果与回滚 | CL-003 起按 server 逐个接 |
| `gateway.ts` HTTP 分支单测 | 仅冒烟覆盖 | 并发/异常路径未单测 | CL-002 补 supertest 风格集成测试 |
| `errors.ts` 分支覆盖 50% | `isToolError` 部分分支未测 | 低风险（纯判定） | 下轮补 3 条 |
| 浏览器/桌面守卫真机 | 只有 `EffectLedger` 单元验证 | `expect[]` 与真实页面事实的对接未验证 | CL-007/008 |
| 多进程/多客户端并发 | 未测 | 单进程单实例假设；跨进程审批共享不支持 | 设计上明确"单进程网关"，如需多实例需外部存储 |

## 8. 结论

v0.1.0 底座的 **G1–G7 验收目标全部达成**（见 `PROJECT-OVERVIEW.md` 1.5）：

- G1 能力模型 ✅ / G2 分级 ✅ / G3 策略 ✅ / G4 审批 ✅ / G5 审计 ✅ / G6 守卫 ✅ / G7 可交付 ✅

可以在此底座上开始接第一个业务 server（建议 `win-shell` 或 `win-system`，风险最高、收益最直接）。