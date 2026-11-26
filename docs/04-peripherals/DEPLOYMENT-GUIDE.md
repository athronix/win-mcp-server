# DEPLOYMENT-GUIDE — 安装与接入

> 版本 v0.1.0 · 适用：底座 `@win-mcp/core` 与基于它构建的 server

## 1. 环境要求

| 项 | 要求 |
|---|---|
| OS | Windows 10/11（底座本身跨平台可测，业务 server 需 Windows） |
| Node | ≥ 22 |
| 端口 | HTTP 模式默认自选（示例 8765）；**仅回环** |

## 2. 安装与构建

```bash
git clone <repo> && cd win-mcp-servers
npm install
npm run build
npm test && npm run smoke      # 可选：验证环境
```

产物：`packages/core/dist/index.js` + `.d.ts`。

## 3. 客户端接入

### 3.1 stdio（推荐本地使用）

```json
{
  "mcpServers": {
    "win-mcp": {
      "command": "node",
      "args": ["D:/Users/towyq/Documents/Projects/win-mcp-servers/examples/demo-server.mjs"],
      "env": {}
    }
  }
}
```

- Claude Desktop：`%APPDATA%\Claude\claude_desktop_config.json`
- Cursor：`.cursor/mcp.json`（项目级）或全局设置
- WorkBuddy：连接器/自定义 MCP 中粘贴同等结构

### 3.2 streamable-HTTP（多客户端/长驻）

```bash
node examples/demo-server.mjs --http 8765
curl http://localhost:8765/health
```

客户端 URL：`http://localhost:8765/mcp`

> **务必用 `localhost` 而非 `127.0.0.1`**：本机若启用 NekoBox TUN 模式，裸 IPv4 回环可能被拦截；
> `localhost` 解析到 `::1` 更稳。

### 3.3 远程访问（不推荐）

默认拒绝非回环绑定（`NON_LOOPBACK_BIND`）。确需远程时须显式 `allowRemote: true` 并自行加鉴权层（反向代理 + Token），**底座不内置远程鉴权**。

## 4. 运行期配置

### 4.1 策略基线（必须按环境调整）

默认 `pathAllowlist` 只有 `C:\Users\**`、`C:\Temp\**`、`C:\tmp\**`、`D:\Data\**`。
**如果你的工作目录不在其中（例如 `D:\Users\...`），写操作会被 `pathAllowlist:miss` 拒绝。**
这是刻意的安全默认，请显式加白：

```ts
import { DEFAULT_POLICY, mergePolicy, PolicyEngine } from '@win-mcp/core';

const policy = new PolicyEngine(
  mergePolicy(DEFAULT_POLICY, {
    pathAllowlist: ['D:\\Users\\**'],   // 与默认并集，不会删除默认项
  }),
);
```

> 数组字段一律**并集**：用户配置无法删除默认红线（`mergePolicy` 保证）。

### 4.2 自动批准（默认关闭）

```ts
mergePolicy(DEFAULT_POLICY, { autoApprove: { enabled: true, maxRisk: 'L2' } })
```

- 只放行"风险 ≤ maxRisk"的操作，且**仅跳过人工确认**
- 黑名单、路径白名单、进程保护、风险封顶仍全部生效
- 策略放权类操作（`policyControl`）永远绕过自动批准

### 4.3 审计密钥

```ts
new AuditChain({ secret: process.env.WIN_MCP_AUDIT_SECRET })
```

固定 secret 用于 HMAC 链校验，防止低成本篡改。变更 secret 会使历史链无法校验（需保留旧值做迁移）。

## 5. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具直接执行、没弹审批卡 | `autoApprove` 开启且风险 ≤ 上限 | 查返回 `autoApproved:true`；关掉 autoApprove |
| 返回 `POLICY_DENIED` 而非审批 | 命中黑名单/白名单/进程保护/封顶 | 看 `error.details.rule`；不要试图用审批绕过 |
| `APPROVAL_REQUIRED` 但界面没卡 | 宿主未按 `instructions` 弹卡 | 检查客户端是否把 `isError:false` 的结果当失败隐藏 |
| 重发后 `APPROVAL_MISMATCH` | 参数被改写 / ID 已消费 / 超时 | 对比首次与重发的 `arguments`（除 `__approvalId`） |
| 重发仍 `APPROVAL_REQUIRED` | `__approvalId` 放在了顶层而非 `arguments` | 确认字段位置 |
| 写操作报 `pathAllowlist:miss` | 目标不在默认白名单 | 按 4.1 加白 |
| `INSTRUCTIONS_TOO_LONG` | instructions > 4096 字节 | 精简行为契约文案 |
| HTTP 连不上 | 用了 `127.0.0.1` 且本机 TUN 拦截 | 改 `localhost`；或检查端口占用 |

## 6. 升级与回滚

- 版本号遵循 `0.x`：接口可能变动，升级前跑 `npm run check`
- 审计日志与 `secret` 绑定，升级不清空；如需迁移用 `AuditChain.verify(entries)` 校验后导入
- 回滚：`git checkout <tag> && npm ci && npm run build`

## 7. 生产检查清单

- [ ] `pathAllowlist` 已按实际工作目录配置（最小范围）
- [ ] `autoApprove` 保持关闭，或上限不高于 L2
- [ ] 审计 secret 从环境变量注入，不写死在代码
- [ ] HTTP 模式仅回环；远程访问有独立鉴权
- [ ] `npm run check` 全绿
- [ ] 每次上线前用 `docs/03-verification/TEST-REPORT-v0.1.0.md` 的 12 项冒烟复验