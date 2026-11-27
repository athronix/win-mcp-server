# 已完成的变更记录

> 每个 CL 测试通过后从 `changing-log.md` 迁移至此，按时间倒序。

## CL-013 计划与回滚：planId 三分支 + backupId 逆序恢复（v0.10.0）

| 项 | 内容 |
|---|---|
| 新增能力 | `apps.winget.plan`(L1) / `apps.winget.apply`(L2) / `system.backup.list`(L0) / `system.backup.restore`(L2) |
| 新模块 | core `plan/store.ts`（规范化指纹 + 一次性 + TTL + LRU）、servers `apps/plan.ts`（三分支纯函数） |
| PS 新增 | `New-SettingsBackup` / `Restore-SettingsBackup` / `Get-SettingsBackups` / `Get-WingetInstalledState` |
| 参考来源 | winutil-cn plans.mjs + worker-core.ps1（GUID-only / 逆序恢复 / 精确还原不存在） |
| 关键设计 | PLAN_MISMATCH 不消耗计划；blocked 整份拒绝；no-changes 不算失败；备份只接受 GUID |
| 修复缺陷 | system 域 handler 未走 guard 导致领域错误码退化成 INTERNAL |
| 验证 | 272 测试 / 21 文件；smoke:plan 14/14（真实 winget + 真实注册表往返） |

## CL-012 win-browser：CDP 通道（v0.9.0）

| 项 | 内容 |
|---|---|
| 新增能力 | `browser.cdp.status/launch/navigate/snapshot/act/screenshot/tabs/eval` + `browser.tab.close`（browser 域共 14 个） |
| 新模块 | servers `browser/{cdp,page,runtime}.ts`、`shared/errors.ts` |
| 参考来源 | agent-browser（ref + 重取快照）、BrowserSkill（expect 断言 / 不盲重试）、chrome-devtools-mcp（CDP 域） |
| 关键设计 | 端口 0 + DevToolsActivePort 读回；启动前删残留端口文件；就绪需 /json/version 真可达；回环主机名双试 |
| 修复缺陷 | `/json/list` 的 id 与 `Target.getTargets` 的 targetId 混用导致 attach Invalid parameters；快照空返回崩溃 |
| 验证 | 242 测试 / 19 文件；smoke:cdp 13/13（headless Edge）；smoke:desktop 11/11；底座 12/12、桥 6/6 |

## CL-011 win-desktop：UIA 语义树 + 受控键鼠 + 桌面门控（v0.8.0）

| 项 | 内容 |
|---|---|
| 新增能力 | `desktop.ui.snapshot`(L0) / `desktop.ui.act`(L2) / `desktop.input.send`(L2) / `desktop.control.state`(L0) / `desktop.control.policy`(L3) |
| 新模块 | core `desktop/{control-policy,consent,gate,io,ref}.ts`、`bridge/errors.ts`；ps `modules/desktop-uia.ps1`、`ps/consent-dialog.ps1` |
| 参考来源 | CursorTouch 门控三档+倒计时同意；agent-desktop ref 语义+Chromium settle；FlaUI-MCP 语义树渲染+模式降级 |
| 关键设计 | 未登记能力按 direct（fail closed）；控制状态查询永免检；对话框挂起 → CONTROL_DENIED（与上游故意不同） |
| 修复缺陷 | ArrayList.Add 返回值污染递归、Rect.Empty 的 -Infinity 强转崩溃、`$matches` 撞自动变量、门控/审批顺序 |
| 验证 | 221 测试 / 18 文件；smoke:desktop 11/11 真机；底座 12/12、桥 6/6 无回归 |

## CL-004 win-shell（v0.4.0）

| 项 | 内容 |
|---|---|
| 状态 | ✅ 完成（2026-11-26） |
| 类型 | feat（最高危 server） |

### 交付

- `packages/core/ps/modules/shell.ps1`：`Get-ShellInfo`（Git-Bash 探测）、`Invoke-BashCommand`（`AddScript`+`AddArgument` 避免拼接注入 + 超时 Kill）
- `packages/servers/src/shell/bash-classify.ts`：bash 词表分级 + 9 条硬禁
- `packages/servers/src/shell/capabilities.ts`：4 能力 + `createShellClassifier`（bash / runAdmin / 真 AST 三路）
- `packages/servers/src/shell/bin.ts`
- core 增强：`CapabilitySpec.analysisOnly`、`PolicyRequest.analysisOnly`、`expandEnvVars()` + `PolicyEngine` 可注入 env
- `docs/changes/CL-004.md`

### 验证

| 关卡 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm test` | **163 passed / 14 files** |
| 真机 | analyze(iex)=blocked L3 / invoke(iex)=COMMAND_BLOCKED 无 approvalId / invoke(1+1)=2 / Remove-Item $env:TEMP=APPROVAL_REQUIRED / runAsAdmin=ADMIN_REQUIRED / bash echo=ok |

### 缺陷修正（策略缺口）

1. 预检能力被命令黑名单误拦 → 新增 `analysisOnly` 豁免（仅限无副作用能力）
2. `$env:TEMP` 未展开致白名单误拒 → `expandEnvVars` + env 注入
3. 能力 ID 两段式非法 → 统一三段式

---

## CL-003 win-system（v0.3.0）

| 项 | 内容 |
|---|---|
| 状态 | ✅ 完成（2026-11-26） |
| 类型 | feat（第一个业务 server） |

### 交付

- 桥新增 `op=module`（双层白名单：module + function），脚本作用域 dot-source
- `packages/core/ps/modules/system.ps1`：11 个函数（概览/服务/进程/事件日志/任务/注册表读+写带备份/启动项/网络）
- `packages/servers`：`@win-mcp/servers` 包（ADR-011：同包 6 bin）
  - `src/shared/runner.ts` 统一运行器
  - `src/system/capabilities.ts`（11 能力）+ `src/system/bin.ts`
- `docs/changes/CL-003.md`（合并版 DDD 记录）

### 验证

| 关卡 | 结果 |
|---|---|
| `npm run typecheck` | 0 error（core + servers） |
| `npm test` | **146 passed / 13 files** |
| 真机 | info/service.list/registry.read 返回真实数据；service.control → APPROVAL_REQUIRED；lsass 与 HKLM 写 → POLICY_DENIED |

### 缺陷修正

1. hashtable 字面量内不能写 `try/catch`（5 处改为先算变量）
2. 函数内 dot-source 导致模块函数作用域丢失（改为主循环加载）

---

## CL-002 PowerShell 常驻桥 + 真 AST 解析（v0.2.0）

| 项 | 内容 |
|---|---|
| 状态 | ✅ 完成（2026-11-26） |
| 类型 | feat（新增 bridge 模块） |
| 关联需求 | G1–G6（CONTEXT-ANALYSIS-cl002 §4） |

### 交付内容

**代码**
- `packages/core/ps/ps-bridge.ps1`：NDJSON 请求循环（`ping/info/parse/invoke`）、官方 AST 解析、独立 runspace 受控执行 + 超时 Stop
- `packages/core/src/bridge/protocol.ts`：请求编码、响应容错解析
- `packages/core/src/bridge/bridge.ts`：`PowerShellBridge`（spawn、分帧、id 匹配、超时、崩溃重启、pwsh→powershell 回退、可注入 spawn）
- `packages/core/src/bridge/ast.ts`：`parseWithBridge` / `analyzeCommandWithBridge` / `createBridgeClassifier` / `bridgeErrorToCode`
- `packages/core/src/policy/engine.ts`：新增 `PolicyRequest.pathEvidence`（命令型参数改用 AST 证据）
- `packages/core/src/approval/gate.ts`：`DynamicClassification.paths` → `pathEvidence` 贯通
- `examples/demo-server.mjs`：`--ps` 开关启用真 AST

**测试**
- `tests/protocol.test.ts`（6）、`tests/bridge.test.ts`（10，假进程）、`tests/ast-bridge.test.ts`（12，真机）
- `scripts/smoke-bridge.mjs`（6 项）
- `policy.test.ts` +3、`gate.test.ts` +2（路径证据回归）

**文档**
- `docs/01-investigation/CONTEXT-ANALYSIS-cl002.md`
- `docs/02-design/TECHNICAL-SOLUTION-bridge.md`（含 §4.4 路径证据贯通）
- `docs/02-design/TEST-PLAN-cl002.md`
- `docs/03-verification/TEST-REPORT-cl002.md`
- `TECHNICAL-SOLUTION-core.md`：`PolicyRequest.pathEvidence`
- `README.md`：`--ps` 用法、路线图

### 验证结果

| 关卡 | 结果 |
|---|---|
| `npm run build` / `typecheck` | ✅ 0 error |
| `npm test` | **139 passed / 12 files / 0 skip** |
| `npm run smoke` | 12/12（无回归） |
| `npm run smoke:bridge` | **6/6** |
| `npm run verify:docs` | 45 个关键 API 对齐 |
| bridge 覆盖率 | 84.38% |

### 实现中修正的缺陷

1. `$errors` 与 PowerShell 自动变量 `$Error` 冲突 → 改名 `$errorList`
2. PowerShell 7.6 的 `@($list[object])` 抛 "Argument types do not match" → 改 `.ToArray()`
3. `StrictMode 2` 下访问不存在的 PSCustomObject 属性抛错 → StrictMode 1 + `PSObject.Properties` 安全读取
4. **纯注释命令被 `POLICY_DENIED`** → `pathEvidence` 贯通（分级与策略共用同一份事实）

### 已知遗留

见 `docs/03-verification/TEST-REPORT-cl002.md` §7（死循环无法 Stop、执行结果未结构化、会话状态不保留、错误消息本地化、runAsAdmin 仅判级）。

---

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