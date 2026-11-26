# 项目目录与文件索引

> 最后更新：2026-11-26 · 版本 v0.1.0

## 根目录

| 路径 | 说明 |
|---|---|
| `package.json` | npm workspaces 根配置、scripts（build/typecheck/test/smoke/verify:docs/check） |
| `tsconfig.base.json` | 共享 TS 编译选项（strict + noUncheckedIndexedAccess） |
| `vitest.config.ts` | 测试配置 |
| `README.md` | 对外项目说明 |
| `.gitignore` | node_modules / dist / coverage / .env |
| `.dev/` | DDD 六索引 |
| `docs/` | DDD 文档（4 阶段） |
| `packages/core/` | `@win-mcp/core` 共享底座 |
| `scripts/` | 冒烟与门禁脚本 |
| `examples/` | 演示 server 与客户端配置 |

## `packages/core/src/`

| 文件 | 职责 | 需求 |
|---|---|---|
| `contracts/risk.ts` | RiskLevel、rank、比较 | FR-102 |
| `contracts/errors.ts` | 17 个错误码与 `makeError`/`isToolError` | FR-109 |
| `contracts/capability.ts` | Domain/CapabilitySpec/Capability/Handler/EffectState | FR-101 |
| `contracts/envelope.ts` | 统一返回、ApprovalPayload、三个 envelope 工厂 | FR-109 |
| `contracts/index.ts` | 汇总导出 | — |
| `registry/cap.ts` | `cap()` 归一化、ID 校验、分组、`InvalidCapabilityIdError` | FR-101 |
| `registry/registry.ts` | `CapabilityRegistry` | FR-101 |
| `classify/vocab.ts` | L0-L3 词表、14 条硬禁 | FR-102 |
| `classify/parser.ts` | `CommandParser` + 保守 fallback（含 dynamicCalls） | FR-102 |
| `classify/command.ts` | `analyzeCommand()` 判级主流程 | FR-102 |
| `policy/glob.ts` | glob/路径抽取/命令识别 | FR-103 |
| `policy/defaults.ts` | 默认红线 + `mergePolicy`（数组并集） | FR-103 |
| `policy/engine.ts` | `PolicyEngine.evaluate()`（7 步 + 3b/4b/4c） | FR-103 |
| `approval/hash.ts` | `canonicalJson` + `hashParams` | FR-104 |
| `approval/store.ts` | 审批表、TTL、一次性消费 | FR-104 |
| `approval/policy-control.ts` | 防自我放权判定 | FR-104 |
| `approval/gate.ts` | 8 步编排（`run` / `runPolicyControl`） | FR-104 |
| `audit/chain.ts` | HashChain、脱敏、`verify(entries?)` | FR-105 |
| `guard/expect.ts` | `expect[]` 断言求值（≤16 条） | FR-106 |
| `guard/ledger.ts` | effect_state 账本、禁盲重试 | FR-106 |
| `taskmgr/semaphore.ts` | 分类信号量（DESKTOP=1 等） | FR-107 |
| `transport/gateway.ts` | 工具注册、`toCallResult`、stdio/HTTP、`PolicyControlProvider` | FR-108 |
| `util/ids.ts` | traceId/approvalId/actionId | — |
| `index.ts` | 包公开 API | — |

## `packages/core/tests/`（106 条）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `registry.test.ts` | 10 | R-01..R-10 |
| `classify.test.ts` | 23 | C-01..C-23 |
| `policy.test.ts` | 20 | P-01..P-20 |
| `approval.test.ts` | 13 | A-01..A-13 |
| `audit.test.ts` | 6 | U-01..U-06 |
| `guard.test.ts` | 9 | G-01..G-09 |
| `semaphore.test.ts` | 5 | S-01..S-05 |
| `gate.test.ts` | 14 | T-01..T-14 |
| `gateway.test.ts` | 6 | G-T1..G-T6 |

## `scripts/`

| 文件 | 用途 |
|---|---|
| `smoke.mjs` | P0 12 项冒烟（真实 MCP stdio 客户端 + HTTP `/health`） |
| `verify-doc-api.mjs` | 37 个关键 API 文档-代码一致性门禁 |

## `examples/`

| 文件 | 用途 |
|---|---|
| `demo-server.mjs` | 5 能力演示 server（stdio / `--http <port>`；全部模拟，不写真实系统） |
| `client-config.json` | stdio 与 HTTP 客户端配置示例 |

## `docs/`

| 文件 | 阶段 | 状态 |
|---|---|---|
| `01-investigation/PROJECT-OVERVIEW.md` | Phase 1 | ✅ |
| `02-design/REQUIREMENT-v0.1.0.md` | Phase 2.1 | ✅ |
| `02-design/TECHNICAL-SOLUTION-core.md` | Phase 2.2 | ✅ |
| `02-design/TEST-PLAN-v0.1.0.md` | Phase 2.3 | ✅ |
| `03-verification/TEST-REPORT-v0.1.0.md` | Phase 4 | ✅ |
| `04-peripherals/DEPLOYMENT-GUIDE.md` | Phase 6 | ✅ |
| `04-peripherals/USER-GUIDE.md` | Phase 6 | ✅ |