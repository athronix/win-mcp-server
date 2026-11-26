# TECHNICAL-SOLUTION-core — 底座技术方案（含架构/模块/接口/数据模型/实现逻辑）

> DDD Phase 2.2 · 版本 v0.1.0 · 日期 2026-11-26
> 约束：本文档是代码的唯一行为来源。代码与本文不符即为缺陷（NFR-6）。

## 3.1 技术选型与总体架构

### 选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.x（ESM，`strict`） | mcp-builder 推荐；类型约束可把"分级/审批"这类安全逻辑的错误挡在编译期 |
| 运行时 | Node ≥ 22 | 本机 v22.22.2；原生 `node:crypto`、`AbortSignal` |
| MCP SDK | `@modelcontextprotocol/sdk` | 官方；`registerTool` + `structuredContent` + annotations |
| 校验 | `zod` | 与 SDK 原生集成；能力输入 schema 直接复用 |
| 测试 | `vitest` | ESM/TS 零配置；快 |
| 包管理 | npm workspaces | 单仓多包，底座被 6 server 共享 |

### 分层

```
┌──────────────────────────────────────────────────────────┐
│ apps (后续 CL)  win-system / win-apps / win-browser /    │
│                 win-desktop / win-resource / win-shell   │
└───────────────┬──────────────────────────────────────────┘
                │ 只依赖 core 的公开 API
┌───────────────▼──────────────────────────────────────────┐
│ @win-mcp/core                                            │
│  contracts → registry → {classify, policy, approval,     │
│  audit, guard, taskmgr} → transport(gateway)             │
└───────────────┬──────────────────────────────────────────┘
                │ 平台能力通过接口注入（无 Windows 依赖）
┌───────────────▼──────────────────────────────────────────┐
│ 注入点：CommandParser / Clock / IdFactory / Executor     │
└──────────────────────────────────────────────────────────┘
```

**依赖方向单向**：`contracts` 不依赖任何模块；`registry` 只依赖 contracts；`policy/classify/approval/audit/guard/taskmgr` 互相之间只允许 `approval → policy,audit`、`classify → contracts`；`transport` 依赖全部。

### ADR（关键决策与理由）

| ADR | 决策 | 理由 | 放弃的方案 |
|---|---|---|---|
| ADR-001 | 底座是**库**不是 server | 审批/审计状态必须单实例原子消费；跨进程会破坏"一次性" | 第 7 个 server |
| ADR-002 | 分级放在审批**之前**，硬禁/语法错误不入审批链 | 给不可接受操作发"可审批"通行证 = 变相放行 | 先审批再判级 |
| ADR-003 | 参数绑定用 `canonicalJson` + `sha256(capId\0params)` | 键序不同即误判掉包 | `JSON.stringify` 直用 |
| ADR-004 | 审批消费在**执行前** | 执行失败也不退还凭证，防"失败重试拿同一凭证据反复试" | 执行后消费 |
| ADR-005 | `autoApprove` 只跳过人工确认 | 走到审批闸时黑白名单已通过；若它还能绕红线，红线形同虚设 | autoApprove 可越过策略 |
| ADR-006 | 命令解析器**可注入** | 生产用 PowerShell AST，测试用保守 fallback；避免底座依赖 Windows | 在 core 里直调 pwsh |
| ADR-007 | fallback 解析器保守（无法确证即升 L2） | fail-closed；宁可多审批不可漏放 | 猜测性降级 |
| ADR-008 | 审计用 HashChain + 固定 secret 前缀 | 防意外/低成本篡改；非密码学级（本机文件） | 无链、或引入 KMS |
| ADR-009 | 能力输入用 Zod raw shape | MCP SDK 原生；可生成 JSON Schema 文档 | 手写 JSON Schema |
| ADR-010 | Windows 专有实现不进 core | core 可被 CI 在任意平台跑测试 | 全塞 core |

## 3.2 模块与文件映射

| 模块 | 文件 | 职责 |
|---|---|---|
| contracts | `src/contracts/risk.ts` | RiskLevel、rank、比较 |
| | `src/contracts/errors.ts` | 错误码枚举与工厂 |
| | `src/contracts/capability.ts` | Domain、CapabilitySpec/Capability、Handler |
| | `src/contracts/envelope.ts` | 统一返回、ApprovalPayload |
| | `src/contracts/index.ts` | 汇总导出 |
| registry | `src/registry/cap.ts` | `cap()` 归一化、ID 校验、分组 |
| | `src/registry/registry.ts` | `CapabilityRegistry` |
| classify | `src/classify/vocab.ts` | L0-L3 词表 + 硬禁模式 |
| | `src/classify/parser.ts` | `CommandParser` 接口 + 保守 fallback |
| | `src/classify/command.ts` | `analyzeCommand()` 判级主流程 |
| policy | `src/policy/glob.ts` | glob/路径/命令识别 |
| | `src/policy/defaults.ts` | 默认红线 + mergePolicy |
| | `src/policy/engine.ts` | `PolicyEngine.evaluate()` 7 步 |
| approval | `src/approval/hash.ts` | canonicalJson + hashParams |
| | `src/approval/store.ts` | pending 表 + TTL + 一次性 |
| | `src/approval/policy-control.ts` | 防自我放权判定 |
| | `src/approval/gate.ts` | 8 步编排（核心） |
| audit | `src/audit/chain.ts` | HashChain + redact + verify |
| guard | `src/guard/expect.ts` | 断言求值 |
| | `src/guard/ledger.ts` | effect_state 账本 |
| taskmgr | `src/taskmgr/semaphore.ts` | 分类信号量 |
| transport | `src/transport/gateway.ts` | McpServer + registerTool 装饰 + stdio/HTTP |
| util | `src/util/ids.ts` | traceId/approvalId/actionId |

## 3.3 接口定义（导出签名，代码必须一致）

### 3.3.1 contracts/risk.ts

```ts
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';
export const RISK_LEVELS: readonly RiskLevel[];              // ['L0','L1','L2','L3']
export function riskRank(risk: RiskLevel): number;            // 0..3
export function isRiskLevel(value: unknown): value is RiskLevel;
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel;
export function riskAtLeast(risk: RiskLevel, min: RiskLevel): boolean; // rank(risk) >= rank(min)
```

### 3.3.2 contracts/errors.ts

```ts
export const ERROR_CODES: readonly ErrorCode[];
export type ErrorCode =
  | 'APPROVAL_REQUIRED' | 'APPROVAL_MISMATCH' | 'POLICY_DENIED' | 'ADMIN_REQUIRED'
  | 'PREFLIGHT_UNAVAILABLE' | 'PREFLIGHT_FAILED' | 'INVALID_SYNTAX' | 'COMMAND_BLOCKED'
  | 'STALE_REF' | 'AMBIGUOUS_TARGET' | 'TIMEOUT' | 'UNKNOWN_CAPABILITY'
  | 'INVALID_PARAMS' | 'PROVIDER_UNAVAILABLE' | 'EFFECT_UNKNOWN'
  | 'GUARD_ASSERTION_FAILED' | 'INTERNAL';
export interface ToolError { code: ErrorCode; message: string; details?: Record<string, unknown> }
export function makeError(code: ErrorCode, message: string, details?: Record<string, unknown>): ToolError;
export function isToolError(v: unknown): v is ToolError;
```

### 3.3.3 contracts/capability.ts

```ts
export const CAPABILITY_DOMAINS = ['system','apps','browser','desktop','resource','shell','meta'] as const;
export type Domain = (typeof CAPABILITY_DOMAINS)[number];

export interface CapabilityPolicy {
  pathDenylist?: string[]; pathAllowlist?: string[];
  commandDenylist?: string[]; commandAllowlist?: string[];
  processDenylist?: string[];
  registryWriteAllowlist?: string[]; registryReadAllowlist?: string[];
}

export interface HandlerContext { traceId: string; risk: RiskLevel }
export interface Artifact { kind: string; name: string; mime?: string }

export interface CapabilityResult {
  data?: unknown;
  artifacts?: Artifact[];
  effectState?: EffectState;                 // 见 guard/ledger
  backupStatus?: 'confirmed' | 'unconfirmed';
  warnings?: string[];
}

export interface CapabilitySpec {
  id: string; name: string; description: string; risk: RiskLevel;
  inputSchema?: ZodRawShape;
  handler?: CapabilityHandler;
  idempotent?: boolean; requiresSession?: boolean; destructive?: boolean;
  destructivePath?: boolean;
  dynamicRisk?: boolean; policyControl?: boolean;
  timeoutMs?: number; snapshot?: 'none' | 'before';
  policy?: CapabilityPolicy;
  annotations?: Partial<ToolAnnotations>;
}

export interface Capability {
  readonly id: string; readonly domain: Domain; readonly name: string;
  readonly description: string; readonly risk: RiskLevel;
  readonly inputSchema: ZodRawShape;
  readonly handler?: CapabilityHandler;
  readonly idempotent: boolean; readonly requiresSession: boolean;
  readonly destructive: boolean; readonly destructivePath: boolean;
  readonly dynamicRisk: boolean; readonly policyControl: boolean;
  readonly timeoutMs: number; readonly snapshot: 'none' | 'before';
  readonly policy?: CapabilityPolicy;
  readonly annotations: ToolAnnotations;
}
export type CapabilityHandler = (params: Record<string, unknown>, ctx: HandlerContext) => Promise<CapabilityResult>;
```

### 3.3.4 contracts/envelope.ts

```ts
export type ApprovalBranch = 'local' | 'plan' | 'elicitation';
export interface ApprovalPayload {
  approvalId: string; risk: RiskLevel; capabilityId: string;
  preview: Record<string, unknown>;
  impact: string[];
  resumeHint: string;
  branch: ApprovalBranch;
}
export interface ToolEnvelope<T = unknown> {
  traceId: string; ok: boolean; risk: RiskLevel;
  data?: T; artifacts?: Artifact[]; auditRef?: string; durationMs?: number;
  approval?: ApprovalPayload; autoApproved?: boolean;
  effectState?: EffectState; backupStatus?: 'confirmed' | 'unconfirmed';
  error?: ToolError; analysis?: unknown; warnings?: string[];
}
export function successEnvelope<T>(p: { traceId; risk; data: T; auditRef?; durationMs?; artifacts?; autoApproved?; effectState?; warnings? }): ToolEnvelope<T>;
export function failureEnvelope(p: { traceId; risk; error: ToolError; analysis? }): ToolEnvelope<never>;
export function approvalEnvelope(p: { traceId; risk; approval: ApprovalPayload; analysis? }): ToolEnvelope<never>;
```

### 3.3.5 registry

```ts
export function assertCapabilityId(id: string): void;   // 非法 → throw Error('INVALID_CAPABILITY_ID: ...')
export function cap(spec: CapabilitySpec): Capability;
export function groupByDomain(caps: readonly Capability[]): Map<Domain, Capability[]>;

export class CapabilityRegistry {
  register(spec: CapabilitySpec): Capability;
  registerAll(specs: readonly CapabilitySpec[]): Capability[];
  get(id: string): Capability | undefined;
  has(id: string): boolean;
  list(): readonly Capability[];
  byDomain(domain: Domain): readonly Capability[];
  get size(): number;
}
```

### 3.3.6 classify

```ts
export const GEN_MAX_CHARS: number;                       // 8000
export const GEN_MAX_STATEMENTS: number;                  // 10（超过仅告警）
export const GEN_L0: readonly string[];
export const GEN_L1_WRITE: readonly string[];
export const GEN_L2: readonly string[];
export const GEN_L3: readonly string[];
export const GEN_BLOCK_PATTERNS: readonly RegExp[];

export interface ParseError { message: string; line: number; column: number }
export interface ParsedCommand {
  syntaxValid: boolean;
  errors: ParseError[];
  commands: string[];
  paths: string[];
  statementCount: number;
  /** `& $var` / `. $var` 这类无法静态判定的动态调用（命中即 blocked） */
  dynamicCalls: string[];
  parser: 'fallback' | 'powershell-ast';
}
export type CommandParser = (command: string) => ParsedCommand;
export function fallbackParser(command: string): ParsedCommand;

export interface CliAnalysis {
  ok: true;
  syntaxValid: boolean;
  parseErrors: ParseError[];
  blocked: boolean;
  blockReasons: string[];
  risk: RiskLevel;
  riskReasons: string[];
  commands: string[];
  paths: string[];
  warnings: string[];
  suggestions: string[];
  runAsAdmin: boolean;
  statementCount: number;
  normalizedCommand: string;
  parser: 'fallback' | 'powershell-ast';
}
export interface AnalyzeCommandOptions {
  command: string;
  runAsAdmin?: boolean;
  parser?: CommandParser;
  homeDir?: string;
  env?: Record<string, string>;
}
export function analyzeCommand(opts: AnalyzeCommandOptions): CliAnalysis;

export function isL0Name(name: string): boolean;
export function isL1WriteName(name: string): boolean;
export function isL2Name(name: string): boolean;
export function isL3Name(name: string): boolean;
export function isInUserScope(pathValue: string, opts?: { homeDir?: string; env?: Record<string, string> }): boolean;
```

### 3.3.7 policy

```ts
export function globToRegex(pattern: string): RegExp;
export function normalizePath(p: string): string;
export function pathMatchesAny(p: string, regexes: readonly RegExp[]): boolean;
export function looksLikePath(s: string): boolean;
export function looksLikeRegistryPath(s: string): boolean;
export function looksLikeCommandValue(s: string): boolean;
export function extractPathTokens(s: string): string[];
export interface StringValue { key: string; value: string }
export function collectStringValues(params: unknown, prefix?: string, out?: StringValue[]): StringValue[];

export interface AutoApproveConfig { enabled: boolean; maxRisk: 'L2' | 'L3' }
export interface PolicyConfig {
  pathDenylist: string[]; pathAllowlist: string[];
  commandDenylist: string[]; commandAllowlist: string[];
  processDenylist: string[];
  registryWriteAllowlist: string[]; registryReadAllowlist: string[];
  defaultMaxRisk: RiskLevel; approvalTimeoutMs: number;
  autoApprove: AutoApproveConfig;
  disablePathAllowlist?: boolean;
}
export const DEFAULT_POLICY: PolicyConfig;
export function mergePolicy(base: PolicyConfig, override?: Partial<PolicyConfig>): PolicyConfig;

export interface PolicyRequest {
  capabilityId: string; params: Record<string, unknown>; risk: RiskLevel;
  approved: boolean; maxRisk?: RiskLevel; forceApproval?: boolean;
  capabilityPolicy?: CapabilityPolicy;
}
export interface PolicyVerdict {
  allowed: boolean; matchedRule: string; requiresApproval: boolean;
  autoApproved?: boolean; error?: ToolError;
}
export class PolicyEngine {
  constructor(config?: PolicyConfig);
  readonly config: PolicyConfig;
  evaluate(req: PolicyRequest): PolicyVerdict;
}
```

### 3.3.8 approval

```ts
export function canonicalJson(value: unknown): string;
export function hashParams(capabilityId: string, params: Record<string, unknown>): string;

export interface PendingApproval {
  approvalId: string; branch: ApprovalBranch; capabilityId: string;
  risk: RiskLevel; paramsHash: string; params: Record<string, unknown>;
  preview: Record<string, unknown>; impact: string[]; createdAtMs: number;
}
export class ApprovalStore {
  constructor(opts?: { ttlMs?: number; now?: () => number; idFactory?: () => string });
  create(input: Omit<PendingApproval, 'approvalId' | 'createdAtMs'>): PendingApproval;
  /**
   * 消费凭证（一次性，执行前消费）。
   * 失败统一返回 APPROVAL_MISMATCH，`error.details.reason` 区分：
   * not_found（不存在/已使用）| expired（超 TTL）| mismatch（能力ID或参数哈希不符，且已销毁该凭证）
   */
  consume(id: string, capabilityId: string, paramsHash: string):
    | { ok: true; pending: PendingApproval }
    | { ok: false; error: ToolError };
  peek(id: string): PendingApproval | undefined;
  sweep(): number;
  get size(): number;
}

export interface AutoApproveState { enabled: boolean; maxRisk: 'L2' | 'L3' }
export interface PolicyControlVerdict {
  direction: 'loosen' | 'tighten' | 'unchanged';
  effectiveRisk: RiskLevel; forceApproval: boolean;
  from: AutoApproveState; to: AutoApproveState;
}
export function evaluatePolicyControl(current: AutoApproveState, target: AutoApproveState): PolicyControlVerdict;
```

### 3.3.9 gate（核心编排）

```ts
export interface DynamicClassification {
  risk: RiskLevel;
  preview: Record<string, unknown>;
  impact: string[];
  analysis?: unknown;
  blocked?: { code: ErrorCode; message: string };   // 有值即直接失败，不入审批
}
export type DynamicClassifier = (
  capability: Capability,
  params: Record<string, unknown>,
) => Promise<DynamicClassification> | DynamicClassification;

export interface GateDeps {
  policy: PolicyEngine;
  store: ApprovalStore;
  audit: AuditChain;
  classify?: DynamicClassifier;
  now?: () => number;
  traceIdFactory?: () => string;
}
export interface GateRequest {
  capability: Capability;
  params: Record<string, unknown>;
  approvalId?: string;
  traceId?: string;
  branch?: ApprovalBranch;
}
export interface GateOutcome { envelope: ToolEnvelope; executed: boolean }
/** 执行上下文：handler 需要 traceId 做日志/审计关联，risk 为最终判级 */
export interface ExecuteContext { risk: RiskLevel; traceId: string }
export type ExecuteFn = (params: Record<string, unknown>, ctx: ExecuteContext) => Promise<CapabilityResult>;

export class ToolGate {
  constructor(deps: GateDeps);
  /** 普通能力入口；`policyControl=true` 的能力会被拒绝（INVALID_PARAMS），必须走 runPolicyControl */
  run(req: GateRequest, execute: ExecuteFn): Promise<GateOutcome>;
  /** 策略自管理入口：按目标状态判定方向，放权=L3+forceApproval */
  runPolicyControl(
    req: GateRequest & { current: AutoApproveState; target: AutoApproveState },
    apply: ExecuteFn,
  ): Promise<GateOutcome>;
}
```

### 3.3.10 audit / guard / taskmgr / util

```ts
export type AuditOutcome = 'denied' | 'approval_required' | 'approval_mismatch' | 'auto_approved' | 'executed' | 'failed';
export interface AuditEntry {
  seq: number; ts: number; traceId: string; capabilityId: string; risk: RiskLevel;
  paramsHash: string; outcome: AuditOutcome;
  paramsRedacted: Record<string, unknown>; prevHash: string; hash: string;
}
export class AuditChain {
  constructor(opts?: { secret?: string; now?: () => number });
  append(input: { traceId; capabilityId; risk; paramsHash; outcome; params: Record<string, unknown> }): AuditEntry;
  entries(): readonly AuditEntry[];
  /** 校验链；可选传外部条目（如从磁盘加载审计日志后校验） */
  verify(entries?: readonly AuditEntry[]): { valid: boolean; brokenAtSeq?: number };
  findByTraceId(traceId: string): AuditEntry[];
}
export function redactParams(params: unknown): Record<string, unknown>;

export type AssertionOp = 'equals' | 'exists' | 'contains';
export interface ExpectAssertion { path: string; op: AssertionOp; value?: unknown }
export const MAX_ASSERTIONS: number;   // 16
export function normalizeAssertions(raw: unknown): ExpectAssertion[];
export interface GuardVerdict { ok: boolean; failures: { index: number; path: string; op: AssertionOp; expected?: unknown; actual?: unknown }[] }
export function evaluateAssertions(assertions: readonly ExpectAssertion[], facts: Record<string, unknown>): GuardVerdict;

export type EffectState = 'none' | 'committed' | 'unknown';
export interface LedgerRecord { actionId: string; target?: string; state: EffectState; createdAtMs: number; resolvedAtMs?: number }
export class EffectLedger {
  constructor(opts?: { now?: () => number });
  record(actionId: string, state: EffectState, target?: string): LedgerRecord;
  resolve(actionId: string, actual: 'committed' | 'none'): LedgerRecord;
  assertRetryable(target?: string): { allowed: boolean; blocking?: LedgerRecord };
  pending(): LedgerRecord[];
}

export const CATEGORY_LIMITS: Record<Category, number>;
export type Category = 'DESKTOP' | 'SHELL' | 'FILE' | 'QUERY';
export class CategorySemaphore {
  constructor(limits?: Partial<Record<Category, number>>);
  acquire(category: Category, opts?: { timeoutMs?: number }): Promise<() => void>;
  stats(): Record<Category, { running: number; queued: number; limit: number }>;
}

export function newTraceId(): string;
export function newApprovalId(): string;
export function newActionId(): string;
```

### 3.3.11 transport（MCP 网关）

```ts
export const MAX_INSTRUCTIONS_BYTES: number;   // 4096

export interface CallToolResultLike {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}
/** envelope → MCP 结果：APPROVAL_REQUIRED 不置 isError（否则宿主会当失败隐藏掉审批卡） */
export function toCallResult(envelope: ToolEnvelope): CallToolResultLike;

/** 策略自管理 provider：只读当前状态 / 落库目标状态；方向判定由 gate 负责 */
export interface PolicyControlProvider {
  get(): AutoApproveState;
  apply(target: AutoApproveState): Promise<CapabilityResult>;
}

export function registerCapabilityTools(
  server: McpServer,
  capabilities: readonly Capability[],
  gate: ToolGate,
  policyControl?: PolicyControlProvider,
): void;

export interface WinMcpServerOptions {
  name: string; version: string; instructions: string;
  registry: CapabilityRegistry; gate: ToolGate;
  policyControl?: PolicyControlProvider;
}
/** instructions 超过 4096 字节直接抛 INSTRUCTIONS_TOO_LONG */
export function createWinMcpServer(opts: WinMcpServerOptions): McpServer;

export async function startStdio(server: McpServer): Promise<void>;

export interface HttpGatewayOptions {
  port: number; host?: string; path?: string;
  allowRemote?: boolean;
  health?: () => Record<string, unknown>;
}
/** 非回环绑定需 allowRemote=true，否则抛 NON_LOOPBACK_BIND */
export function startHttp(server: McpServer, opts: HttpGatewayOptions): Promise<Server>;
```

**参数 schema 的关键设计**：`registerCapabilityTools` 用
`z.object({ ...capability.inputSchema, __approvalId: z.string().optional() }).passthrough()` 注册工具。
`passthrough()` 是必须的——zod 默认会 strip 未知键，若能力未声明 `inputSchema`，调用方参数会被清空，
导致参数哈希与审批预览失真（"审批了一个空对象"）。

**能力输入约定**：`policyControl` 类能力的参数固定为 `{ enabled: boolean, maxRisk?: 'L2'|'L3' }`
（与本地项目一致），由网关解释为 `target` 后交给 `gate.runPolicyControl()`。

## 3.4 数据模型

### 审批生命周期

```
(无凭证) --call--> classify(硬禁/语法错) --> 失败,不入审批
                        |
                        v 通过
                  policy.evaluate --> POLICY_DENIED --> 失败(不可审批绕过)
                        |
                        v 需审批
                  store.create --> PendingApproval{branch:'local', paramsHash, ttl}
                        |
                        v 返回 APPROVAL_REQUIRED (isError:false)
(用户批准) --同参数 + __approvalId-->  store.consume(id, capId, hash)
                        |                    |
                        |                    +-- hash 不符 -> APPROVAL_MISMATCH, 销毁
                        v 匹配
                  delete(id) [执行前消费]
                        |
                        v
                  execute -> audit executed/failed
```

### 审计条目

```
entry_n = { seq:n, ts, traceId, capabilityId, risk, paramsHash, outcome, paramsRedacted,
            prevHash: hash(entry_{n-1}), hash: sha256(secret? + prevHash + canonicalJson(正文)) }
```

## 3.5 实现逻辑

### ToolGate.run（对应需求 FR-104，8 步）

```
0  若 capability.policyControl -> INVALID_PARAMS（必须走 runPolicyControl）
1  const { approvalId: rawId, ...rest } = params；校验 rawId 为 string 或 undefined
2  traceId = req.traceId ?? 生成；risk = capability.risk
3  if capability.dynamicRisk:
     r = await deps.classify(capability, rest)
     if r.blocked -> audit(denied) + failureEnvelope(blocked.code) + return {executed:false}
     risk = r.risk；preview/impact/analysis = r.*
   else if capability.policyControl:（由 runPolicyControl 处理）
4  hash = hashParams(capability.id, rest)
5  approved = false
   if rawId:
     res = store.consume(rawId, capability.id, hash)
     if !res.ok -> audit(approval_mismatch) + failureEnvelope(APPROVAL_MISMATCH) + return
     approved = true
6  verdict = policy.evaluate({capabilityId, params:rest, risk, approved, forceApproval, capabilityPolicy})
7  if !verdict.allowed:
     if verdict.requiresApproval:
        pending = store.create({branch, capabilityId, risk, paramsHash:hash, params:rest, preview, impact})
        audit(approval_required)
        return { envelope: approvalEnvelope(...), executed:false }
     else: audit(denied, verdict.error) ; return { failureEnvelope, executed:false }
8  if verdict.autoApproved: audit(auto_approved)
   try r = await execute(rest, risk)
        audit(executed) ; return successEnvelope(+effectState/backupStatus/warnings)
   catch e
        audit(failed) ; return failureEnvelope(INTERNAL/TIMEOUT)
```

**不变量**：第 3 步失败绝不进入第 7 步；第 5 步消费先于第 8 步执行；解析器/时钟/ID 全部可注入。

### analyzeCommand（对应 FR-102）

```
1 规范化：\r\n -> \n、trim；空/超长/含 NUL/带 powershell 外壳 -> blocked
2 parser(command) -> {syntaxValid, errors, commands, paths, statementCount, parser}
   !syntaxValid -> 返回 blocked, risk=L3（不做后续判级）
3 硬禁扫描：命中任一 GEN_BLOCK_PATTERNS -> blocked
4 命令名判级：L3 > L2 > L1 > L0；未知 -> L2 + warning
5 路径证据：parser.paths 中明文盘符/UNC/注册表路径；HKLM -> L2
6 路径感知升级：有 L1 写命令 且 (存在非用户域路径 或 无用户域路径) -> L2
7 提权升级：runAsAdmin && (有写/破坏命令 || risk>=L2) -> L3；else runAsAdmin -> >=L2
8 blocked -> risk=L3；suggestions 按 risk 生成
```

### PolicyEngine.evaluate（对应 FR-103）

按 3.3.7 顺序实现，另加一步 **3b 命令白名单**：仅当 `commandAllowlist` 非空时启用，
命令型参数必须命中其一，否则 `POLICY_DENIED`（默认空 = 不启用，策略以路径与能力边界为主）。
`risk>=L2 && !approved` 进入审批闸，`forceApproval` 时 `auto` 置 undefined。

## 3.6 与本地 `windows-capability-service` 的差异（诚实记录）

| 项 | 本地实现 | 本项目 | 原因 |
|---|---|---|---|
| 语言 | JS（编译后）+ PowerShell psmod | TS | 类型约束 + 可测试 |
| 能力输入 | 手写 JSON Schema | Zod raw shape | 与 MCP SDK 原生集成 |
| AST 解析 | 必选 PowerShell `Parser::ParseInput` | 可注入；默认保守 fallback | core 需跨平台可测；生产接 AST |
| 能力 ID | `<domain>.<group>.<action>`，域为 6 类业务域 | 同，域为 6 server + meta | 对齐 server 切分 |
| 审批分支 | 单分支（`__approvalId`） | 三分支归一 | 需兼容 winutil planId、winget elicitation |
| 守卫 | 无 | 新增 expect/effect_state 账本 | 浏览器/桌面写动作需事实断言 |
| 审计 secret | 未固定 | 固定 secret 前缀可配 | 便于测试与防意外篡改 |

> **未移植项（本轮）**：`policyControl` 在本地是"读取当前 autoApprove 再判定"的完整链路；本轮只实现纯判定函数 `evaluatePolicyControl()` 与 gate 的 `runPolicyControl()`，真实策略持久化留到 `win-shell`/`meta` 落地时接。