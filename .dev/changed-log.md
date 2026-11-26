# 已完成的变更记录

> 每个 CL 测试通过后从 `changing-log.md` 迁移至此，按时间倒序。

## CL-001 底座 `@win-mcp/core` v0.1.0

| 项 | 内容 |
|---|---|
| 状态 | ✅ 完成（2026-11-26） |
| 类型 | feat（新项目首版） |
| 关联需求 | FR-101 ~ FR-109、NFR-1 ~ NFR-7 |

### 交付内容

**文档（先于代码）**
- `docs/01-investigation/PROJECT-OVERVIEW.md`
- `docs/02-design/REQUIREMENT-v0.1.0.md`
- `docs/02-design/TECHNICAL-SOLUTION-core.md`
- `docs/02-design/TEST-PLAN-v0.1.0.md`
- `docs/03-verification/TEST-REPORT-v0.1.0.md`
- `docs/04-peripherals/DEPLOYMENT-GUIDE.md`、`USER-GUIDE.md`

**代码（`packages/core/src`）**
- contracts：`risk.ts` / `errors.ts` / `capability.ts` / `envelope.ts` / `index.ts`
- registry：`cap.ts` / `registry.ts`
- classify：`vocab.ts` / `parser.ts` / `command.ts`
- policy：`glob.ts` / `defaults.ts` / `engine.ts`
- approval：`hash.ts` / `store.ts` / `policy-control.ts` / `gate.ts`
- audit：`chain.ts`
- guard：`expect.ts` / `ledger.ts`
- taskmgr：`semaphore.ts`
- transport：`gateway.ts`
- util：`ids.ts`；`index.ts`

**测试与工具**
- `packages/core/tests/*.test.ts`（9 文件 / **106 条**）
- `scripts/smoke.mjs`（12 项冒烟）
- `scripts/verify-doc-api.mjs`（37 个关键 API 文档-代码一致性）
- `examples/demo-server.mjs`、`examples/client-config.json`

**工程**
- `package.json`（workspaces）、`tsconfig.base.json`、`packages/core/tsconfig.json`、`vitest.config.ts`、`.gitignore`、`README.md`

### 验证结果

| 关卡 | 结果 |
|---|---|
| `npm run typecheck` | 0 error（strict + noUncheckedIndexedAccess） |
| `npm run build` | 成功 |
| `npm test` | **106 passed / 9 files，0 skip** |
| `npm run smoke` | **12/12** |
| `npm run verify:docs` | 37 个关键 API 对齐 |
| 核心模块覆盖率 | classify 93.5% / policy 97.3% / approval 91.0% / audit 96.8% / guard 92.0% / taskmgr 100% |

### 实现中修正的缺陷

1. 空命令/动态调用未标 `blocked` → 末尾统一 `blockReasons.length>0 → blocked`
2. 审计 `entries()` 浅拷贝可被外部改写 → `structuredClone`
3. 工具参数被 zod strip → schema `.passthrough()`
4. `policyControl` 能力无法经 MCP 调用 → 网关分支 + `PolicyControlProvider`

### 已知遗留

见 `docs/03-verification/TEST-REPORT-v0.1.0.md` 第 7 节（真 AST 未接、真实系统写未验证、HTTP 分支仅冒烟覆盖等）。