# 项目目录与文件索引

> 最后更新：2026-11-27 · 版本 v0.11.0

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
| `packages/servers/` | `@win-mcp/servers`：6 个业务 server（独立 bin 入口） |
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
| `bridge/protocol.ts` | NDJSON 请求编码、响应容错解析 | CL-002 |
| `bridge/bridge.ts` | `PowerShellBridge`（spawn/分帧/超时/重启/回退） | CL-002 |
| `bridge/ast.ts` | `parseWithBridge` / `analyzeCommandWithBridge` / `createBridgeClassifier` | CL-002 |
| `index.ts` | 包公开 API | — |

## `packages/core/ps/`

| 文件 | 职责 |
|---|---|
| `ps-bridge.ps1` | NDJSON 主循环；`ping/info/parse/invoke/module`；官方 AST 解析；独立 runspace 受控执行 + 超时 Stop（全英文输出，兼容 PS 5.1 编码） |
| `modules/system.ps1` | 11 个系统函数（概览/服务/进程/事件日志/任务/注册表读写/启动项/网络） |
| `modules/shell.ps1` | Git-Bash 探测与 `bash -lc` 受控执行 |

## `packages/core/tests/`（139 条）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `registry.test.ts` | 10 | R-01..R-10 |
| `classify.test.ts` | 23 | C-01..C-23 |
| `policy.test.ts` | 23 | P-01..P-23（含 pathEvidence） |
| `approval.test.ts` | 13 | A-01..A-13 |
| `audit.test.ts` | 6 | U-01..U-06 |
| `guard.test.ts` | 9 | G-01..G-09 |
| `semaphore.test.ts` | 5 | S-01..S-05 |
| `gate.test.ts` | 16 | T-01..T-16 |
| `gateway.test.ts` | 6 | G-T1..G-T6 |
| `protocol.test.ts` | 6 | P-01..P-06（NDJSON） |
| `bridge.test.ts` | 10 | B-01..B-10（假进程） |
| `ast-bridge.test.ts` | 12 | R-01..R-12（真机 pwsh） |

## `scripts/`

| 文件 | 用途 |
|---|---|
| `smoke.mjs` | P0 12 项冒烟（真实 MCP stdio 客户端 + HTTP `/health`） |
| `smoke-bridge.mjs` | CL-002 6 项桥冒烟（真机 pwsh + gate 贯通） |
| `verify-doc-api.mjs` | 45 个关键 API 文档-代码一致性门禁 |

## `examples/`

| 文件 | 用途 |
|---|---|
| `demo-server.mjs` | 5 能力演示 server（stdio / `--http <port>` / `--ps` 真 AST；全部模拟，不写真实系统） |
| `client-config.json` | stdio 与 HTTP 客户端配置示例 |

## `docs/`

| 文件 | 阶段 | 状态 |
|---|---|---|
| `01-investigation/PROJECT-OVERVIEW.md` | Phase 1 | ✅ |
| `01-investigation/CONTEXT-ANALYSIS-cl002.md` | Phase 1（CL-002） | ✅ |
| `02-design/REQUIREMENT-v0.1.0.md` | Phase 2.1 | ✅ |
| `02-design/TECHNICAL-SOLUTION-bridge.md` | Phase 2.2（CL-002） | ✅ |
| `02-design/TEST-PLAN-cl002.md` | Phase 2.3（CL-002） | ✅ |
| `03-verification/TEST-REPORT-cl002.md` | Phase 4（CL-002） | ✅ |
| `02-design/TECHNICAL-SOLUTION-core.md` | Phase 2.2 | ✅ |
| `02-design/TEST-PLAN-v0.1.0.md` | Phase 2.3 | ✅ |
| `03-verification/TEST-REPORT-v0.1.0.md` | Phase 4 | ✅ |
| `04-peripherals/DEPLOYMENT-GUIDE.md` | Phase 6 | ✅ |
| `04-peripherals/USER-GUIDE.md` | Phase 6 | ✅ |
