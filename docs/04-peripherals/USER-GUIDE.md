# USER-GUIDE — 能力与审批交互

> 版本 v0.1.0（底座 + 演示能力）

## 1. 能力清单（v0.1.0 演示）

| 工具 | 风险 | 说明 |
|---|---|---|
| `system.info.get` | L0 | 操作系统/架构/CPU/内存/主机名（只读） |
| `system.file.write` | L1 | 写用户文件；系统目录被路径黑名单拒绝 |
| `system.service.control` | L2 | 服务启停；需审批（演示环境不真实执行） |
| `shell.cmd.invoke` | 动态 L0–L3 | 命令执行；硬禁直接拒绝，L2+ 需审批（演示不真实执行） |
| `meta.policy.set` | L3 | 调整 autoApprove；放权强制审批 |

> 6 个业务 server 的能力清单在各自 CL 落地后补充。

## 2. 审批交互（Agent 与用户各自要做什么）

### 2.1 时序

```
Agent: 调用 system.service.control { name: "spooler", action: "stop" }
Server: 返回 APPROVAL_REQUIRED（ok=false, isError=false）
        + approval: { approvalId, risk: "L2", impact: [...], preview: {...} }
Agent: 把 impact / preview 展示给用户，等待明确批准
用户: 批准
Agent: 用完全相同参数 + __approvalId 重发一次
Server: 执行 → ok=true + auditRef
```

### 2.2 四条铁律

1. **未批准不执行**：首次调用只登记审批，系统状态不变
2. **参数逐字一致**：除 `__approvalId` 外任何变化 → `APPROVAL_MISMATCH`，凭证作废
3. **一次一用**：凭证执行前即消费，重放无效
4. **超时作废**：默认 120 秒

### 2.3 用户该怎么看审批卡

重点看两处：

- `approval.impact`：受影响的具体对象（路径/注册表项/服务名）
- `approval.preview`：判级理由（`riskReasons`）、解析出的命令、涉及路径

若 `impact` 出现 `C:\Windows\...`、`HKLM\SYSTEM`、`lsass` 等，应当拒绝——这类目标通常也已被策略直接拒绝。

## 3. 风险等级含义

| 级别 | 含义 | 默认行为 |
|---|---|---|
| L0 | 只读/变换 | 直接执行 |
| L1 | 用户域可逆写 | 直接执行（策略收紧时为最低档） |
| L2 | 破坏性/系统态变更 | 需审批（可按策略自动批准，默认关） |
| L3 | 高危不可逆 | 强制审批；策略放权绕过自动批准 |

**硬禁**（编码执行、`iex`、下载执行、`exit`、杀桥进程、`Read-Host` 等）**即使审批也拒绝**。

## 4. 常见场景

| 场景 | 建议路径 |
|---|---|
| 查系统信息 | `system.info.get`（L0，无摩擦） |
| 查某服务状态 | 优先只读能力；若只有 `service.control`，读操作也可能触发 L2 审批——这是保守设计 |
| 停服务做排障 | 会走审批；确认 `impact` 里的服务名与预期一致 |
| 跑一条诊断命令 | `shell.cmd.invoke`：`Get-*` 类 L0 直放；含 `Remove-`/`Stop-` 会升 L2/L3 |
| 提权执行 | 需 `runAsAdmin`，风险至少 L2；写操作直接 L3 |

## 5. 错误码速查

| 错误码 | 含义 | 该怎么做 |
|---|---|---|
| `APPROVAL_REQUIRED` | 待用户确认（不是失败） | 展示 impact/preview，等批准后原样重发 |
| `APPROVAL_MISMATCH` | 凭证失效/参数变了/已用过 | 重新发起，不要修改参数 |
| `POLICY_DENIED` | 命中红线 | 换目标或放弃；审批无法绕过 |
| `COMMAND_BLOCKED` | 硬禁命令 | 改写命令；硬禁无审批通道 |
| `INVALID_SYNTAX` | 语法错误（带行列） | 按 `analysis.parseErrors` 修正 |
| `ADMIN_REQUIRED` | 非提权会话要求提权 | 用提权会话，不会静默降级 |
| `PREFLIGHT_UNAVAILABLE` | 判级器不可用 | 修复环境（fail-closed，不做冒险执行） |
| `EFFECT_UNKNOWN` | 上次动作效果未知 | 先核销（`ledger.resolve`），禁止盲重试 |
| `GUARD_ASSERTION_FAILED` | 动作前事实断言不成立 | 重新观察目标当前状态 |
| `TIMEOUT` | 执行超时 | 不要直接重试写操作；先确认效果 |

## 6. 隐私与数据

- 审计记录全部写在本机内存/本地存储，不发往外部
- 参数中的 `password/token/secret/cookie/authorization` 等在审计中替换为 `***`
- 密码类交互设计上走"人类可见控制台"，不进入模型上下文（CL-004 落地）

## 7. 已知限制（v0.1.0）

- 演示 server 的所有写操作均为**模拟**，不触碰真实系统
- 未接入 PowerShell 真 AST：复杂命令可能被判得偏保守（多一次审批），但不会漏放
- 单进程网关：不支持多实例共享审批状态
- 无 UI：审批卡由宿主（WorkBuddy/Claude Code/Cursor）渲染