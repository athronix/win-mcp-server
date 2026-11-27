# TECHNICAL-SOLUTION-bridge — PowerShell 桥与真 AST（CL-002）

> DDD Phase 2.2 · 日期 2026-11-26 · 代码唯一行为来源
> 前置：`TECHNICAL-SOLUTION-core.md`（底座接口不得破坏）

## 1. 选型

| 项 | 决策 | 理由 |
|---|---|---|
| 桥进程 | `pwsh`（7.x）优先，回退 `powershell`（5.1） | 本机两者都在（7.6.10 / 5.1.26100）；5.1 的 AST API 相同，回退成本低 |
| 协议 | **NDJSON over stdio**（每行一个 JSON） | 简单、可流式、无需端口；与 MCP 本身思路一致 |
| 隔离 | `invoke` 在**独立 runspace** 执行 | 不污染桥会话；超时可 `Stop()` |
| 与底座对接 | 不改 `CommandParser`（同步）签名，改为**先 await 解析、再同步注入** | 不动已验证的 106 条测试；`DynamicClassifier` 本就是 async |
| 编码 | 双向 UTF-8 | 中文输出不乱码 |

## 2. 架构

```
ToolGate.run()
  └─ DynamicClassifier（async，由 createBridgeClassifier 提供）
       ├─ await bridge.call('parse', { command })      ← NDJSON
       │      └─ ps-bridge.ps1: Parser::ParseInput
       ├─ analyzeCommand({ parser: () => parsed })      ← 底座原有同步判级，零改动
       └─ 返回 { risk, preview, impact } 或 blocked
  └─ （执行阶段）bridge.call('invoke', { command, timeoutMs })
         └─ ps-bridge.ps1: [powershell]::Create() + BeginInvoke + WaitOne + Stop
```

`ps-bridge.ps1` 放在 `packages/core/ps/`，默认路径由 `new URL('../../ps/ps-bridge.ps1', import.meta.url)` 定位（`dist/bridge/bridge.js` → `packages/core/ps/`）。

## 3. 协议

### 3.1 请求（Node → PS）

```json
{"id":"req_1","op":"parse","params":{"command":"Get-Process"}}
```

| op | params | 说明 |
|---|---|---|
| `ping` | `{}` | 就绪探测 |
| `info` | `{}` | 版本/edition/是否提权/PID |
| `parse` | `{command}` | AST 解析 |
| `invoke` | `{command, timeoutMs?, maxOutputChars?}` | 受控执行 |

### 3.2 响应（PS → Node）

```json
{"id":"req_1","ok":true,"data":{...},"durationMs":3}
{"id":"req_1","ok":false,"error":{"code":"TIMEOUT","message":"命令执行超时（5000ms）"}}
```

**硬约束**：stdout 只允许协议行。PS 脚本内所有输出必须经 `[Console]::Out.WriteLine()`；诊断走 `[Console]::Error.WriteLine()`（Node 侧 `onDiagnostic` 收集）。`Write-Output`/`Write-Host` 一律不得出现在桥主循环。

### 3.3 `parse` 数据形状

```json
{
  "syntaxValid": true,
  "errors": [{"message":"...","line":1,"column":5}],
  "commands": ["get-process","where-object"],
  "paths": ["C:\\Windows\\a.txt","$env:USERPROFILE\\a.txt"],
  "statementCount": 2,
  "dynamicCalls": ["& $cmd"],
  "parser": "powershell-ast"
}
```

采集规则（修正本地实现的两处缺陷）：

1. `commands` 来自 `CommandAst.GetCommandName()`，小写去重
2. `dynamicCalls`：`CommandElements[0]` 是 `VariableExpressionAst`，或 `GetCommandName()` 为空
3. `paths` 同时采集 **`StringConstantExpressionAst` + `ExpandableStringExpressionAst`**
   （本地只采前者，导致 `"$env:USERPROFILE\a.txt"` 漏采）
4. `paths` 中**排除命令名**：`CommandAst` 首元素也是 `StringConstant`，否则每命令都会混入 "Get-Process" 之类噪音
5. 路径正则：盘符 `^[A-Za-z]:[\\/]`、UNC `^\\\\`、注册表 `^HK[A-Z_]+[:\\]`、环境变量 `^\$env:`、家目录 `^~`

### 3.4 `invoke` 数据形状

```json
{"ok":true,"data":{"output":"...","errors":"","truncated":false}}
{"ok":false,"error":{"code":"TIMEOUT","message":"..."}}
```

- 独立 runspace，`AddScript` → `BeginInvoke` → `AsyncWaitHandle.WaitOne(timeoutMs)`
- 超时 → `Stop()` 并返回 `TIMEOUT`（若 `Stop()` 仍卡住，Node 侧超时后杀死桥进程兜底）
- 输出上限 `maxOutputChars`（默认 100000），超出截断并标 `truncated:true`

## 4. Node 侧接口（代码必须一致）

### 4.1 `src/bridge/protocol.ts`

```ts
export interface BridgeRequest { id: string; op: string; params: Record<string, unknown> }
export interface BridgeOkResponse { id: string; ok: true; data: unknown; durationMs?: number }
export interface BridgeFailResponse {
  id: string; ok: false;
  error: { code: string; message: string; details?: unknown };
}
export type BridgeResponse = BridgeOkResponse | BridgeFailResponse;

export function encodeRequest(req: BridgeRequest): string;             // JSON + '\n'
export function parseResponseLine(line: string): BridgeResponse | undefined;  // 非法行返回 undefined
```

`parseResponseLine` 必须容错：PS 的启动横幅、空行、半行 JSON 都不得抛异常（返回 undefined 交给上层忽略）。

### 4.2 `src/bridge/bridge.ts`

```ts
export interface BridgeInfo {
  version: string;
  edition: string;      // 'Core' | 'Desktop'
  elevated: boolean;
  pid: number;
  executable: string;
  platform: string;
}

export type BridgeErrorCode =
  | 'BRIDGE_UNAVAILABLE' | 'BRIDGE_EXITED' | 'TIMEOUT'
  | 'BRIDGE_PROTOCOL' | 'BRIDGE_REMOTE';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly detail?: unknown;
}

export interface ChildProcessLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  pid?: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): boolean;
}
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessLike;

export interface BridgeOptions {
  executable?: string;
  scriptPath?: string;
  requestTimeoutMs?: number;   // 默认 30000
  startTimeoutMs?: number;     // 默认 15000
  maxRestarts?: number;        // 默认 2
  cwd?: string;
  env?: Record<string, string>;
  onDiagnostic?: (line: string) => void;
  spawnImpl?: SpawnImpl;       // 测试注入
}

export interface BridgeStatus {
  running: boolean;
  info?: BridgeInfo;
  pending: number;
  restarts: number;
}

export class PowerShellBridge {
  constructor(opts?: BridgeOptions);
  start(): Promise<BridgeInfo>;
  call<T = unknown>(
    op: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
  stop(): Promise<void>;
  get status(): BridgeStatus;
  get info(): BridgeInfo | undefined;
}
```

**行为约定**

| 场景 | 行为 |
|---|---|
| `call` 时未启动 | 抛 `BridgeError('BRIDGE_UNAVAILABLE')` |
| `start` 时 `pwsh` 不存在（ENOENT） | 自动回退 `powershell`；两者都缺 → `BRIDGE_UNAVAILABLE` |
| 请求超时 | 该请求 reject `TIMEOUT`，迟到响应丢弃（不 resolve） |
| 桥进程退出 | 所有 pending reject `BRIDGE_EXITED`；未 `stop()` 且未超重启上限时自动重启 |
| 收到非法行 | 忽略（可 `onDiagnostic` 记录），不影响其他请求 |
| `ok:false` 响应 | reject `BridgeError('BRIDGE_REMOTE', { code, message })` |

### 4.3 `src/bridge/ast.ts`

```ts
export async function parseWithBridge(
  bridge: PowerShellBridge,
  command: string,
  opts?: { timeoutMs?: number },
): Promise<ParsedCommand>;

export async function analyzeCommandWithBridge(
  bridge: PowerShellBridge,
  opts: AnalyzeCommandOptions & { timeoutMs?: number },
): Promise<CliAnalysis>;

export function createBridgeClassifier(
  bridge: PowerShellBridge,
  opts?: { timeoutMs?: number },
): DynamicClassifier;

export function bridgeErrorToCode(error: unknown): ErrorCode;
```

`analyzeCommandWithBridge` 的实现要点：**先 await 解析，再用同步 parser 注入**——

```ts
const parsed = await parseWithBridge(bridge, opts.command, { timeoutMs });
return analyzeCommand({ ...opts, parser: () => parsed });
```

`createBridgeClassifier` 返回值直接可传给 `ToolGate({ classify })`：

| 情况 | blocked.code |
|---|---|
| `command` 非非空字符串 | `INVALID_PARAMS` |
| 桥不可用/退出/协议错 | `PREFLIGHT_UNAVAILABLE` |
| 桥返回远端错误 / 解析失败 | `PREFLIGHT_FAILED` |
| 请求超时 | `TIMEOUT` |
| 语法无效 | `INVALID_SYNTAX` |
| 命中硬禁 | `COMMAND_BLOCKED` |

### 4.4 路径证据贯通（实现中发现并新增）

`DynamicClassification` 增加可选 `paths`：

```ts
export interface DynamicClassification {
  risk: RiskLevel;
  preview: Record<string, unknown>;
  impact: string[];
  analysis?: unknown;
  /** AST 采集的可信路径证据 */
  paths?: string[];
  blocked?: { code: ErrorCode; message: string; analysis?: unknown };
}
```

`ToolGate` 把 `paths` 作为 `PolicyRequest.pathEvidence` 传给策略引擎：

- 提供 `pathEvidence` 时：**命令型参数**不再用正则从命令原文抽路径，只信任 AST 证据
- 显式路径参数（如 `path`）不受影响，仍按值判定
- 注册表范围检查同理：命令型参数改用证据里的注册表路径

**为什么必须这么做**（CL-002 实测发现）：`# Remove-Item C:\Windows\x` 是一条纯注释命令，
AST 判定 `commands=[]`（L0），但策略层若对原文做正则，会把注释里的 `C:\Windows\x`
当成真实目标返回 `POLICY_DENIED` —— **一条注释被拒绝执行**。反之 `Get-ChildItem C:\Windows`
的真实目标在 AST 证据里，仍会被正确拦截。

> 教训：分级与策略必须共用同一份事实。两处各自推断，必然出现"一处认为是操作目标、
> 另一处认为不是"的分裂。

## 5. 失败模型（fail-closed 链）

```
桥起不来        → PREFLIGHT_UNAVAILABLE（gate 拒绝，不执行）
parse 报错      → PREFLIGHT_FAILED
parse 语法无效  → INVALID_SYNTAX（不提供 approvalId）
parse 命中硬禁  → COMMAND_BLOCKED（不提供 approvalId）
请求超时        → TIMEOUT
invoke 超时     → TIMEOUT（且该次副作用未知 → 上层应记 effect_state=unknown）
```

> 任何一环失败都**不会**退化为"用 fallback 猜一下再放行"——宁可拒绝。

## 6. 实现逻辑（关键片段）

### 6.1 桥启动参数

```text
pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <scriptPath>
```

`-ExecutionPolicy Bypass` 对 WinPS 5.1 必要；pwsh 7 忽略。

### 6.2 提权判定

```powershell
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
(New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
```

非 Windows 或异常 → `elevated=false`（fail-safe）。

### 6.3 本轮不做但已预留

- `runAsAdmin=true` 在 `elevated=false` 时由上层返回 `ADMIN_REQUIRED`（`analyzeCommand` 已判 L3；上层再加会话校验）→ CL-004
- 人类可见控制台 / 密码不进 AI → CL-004