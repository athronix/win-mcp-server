# win-mcp-servers — 开发说明

## 项目信息

| 项 | 值 |
|---|---|
| 项目名 | win-mcp-servers |
| 定位 | Windows 系统/软件/浏览器/桌面/资源/命令通道 的 MCP server 套件 |
| 形态 | 6 个对外 MCP server + 1 个共享底座库 `@win-mcp/core` |
| 仓库 | `D:/Users/towyq/Documents/Projects/win-mcp-servers` |
| 上游设计 | `deep-research/win-mcp-skill-plugin/win-mcp-skill-16-proj-review.md` 第 3 章 |
| 当前版本 | v0.1.0（底座） |
| 技术栈 | TypeScript 5 + Node 22 + @modelcontextprotocol/sdk + zod + vitest |
| 开发规范 | ddd-skill（七阶段 + 六索引）、plan-first（任务树）、mcp-builder（MCP 规范） |

## 开发流程（DDD 七阶段）

```
Phase 1 调研 → Phase 2 设计（需求/技术方案/测试方案）→ Phase 3 实现（测试先行）
→ Phase 4 验证 → Phase 5 迭代（失败才进入）→ Phase 6 配套 → Phase 7 交付
```

**硬性前置（原则 7）**：任何代码变更前，逻辑必须已写入 `docs/02-design/`；文档与代码冲突时先改文档。

## 原子变更流程

1. 在 `.dev/changing-log.md` 登记 CL（含范围、涉及文件、验收）
2. 改文档 → 写测试（红）→ 写实现（绿）→ 跑全量
3. 5 大索引同步：`project-dir-file-index.md`、`docs-index.md`、`project-dev-status.md`、`changed-log.md`（从 changing 迁移）、`changing-log.md`（清空）
4. git 提交：`feat(CL-XXX): ...` 与 `docs(CL-XXX): 5-index sync` 两次提交

## 命令

```bash
npm install                 # 安装 workspace 依赖
npm run build               # tsc 构建（含 typecheck）
npm test                    # vitest 全量
npm run smoke               # P0 12 项冒烟
npm run dev --workspace @win-mcp/core   # 本地跑网关（stdio）
```

## 目录约定

| 目录 | 用途 |
|---|---|
| `packages/core/src/contracts` | 类型/错误码/envelope（零依赖） |
| `packages/core/src/{classify,policy,approval,audit,guard,taskmgr}` | 安全与治理逻辑（纯逻辑，可注入时钟/ID） |
| `packages/core/src/transport` | MCP 网关与传输 |
| `packages/core/tests` | 单元 + 集成测试 |
| `docs/01-investigation` | Phase 1 文档 |
| `docs/02-design` | Phase 2 文档（代码唯一行为来源） |
| `docs/03-verification` | 测试报告 |
| `docs/04-peripherals` | 部署/产品/用户手册 |
| `.dev` | 六索引（不含本文件参与常规同步） |

## 安全红线（不可协商）

1. 硬禁命令/语法错误/预检不可用 → **进审批链之前** fail-closed
2. 黑名单拒绝不可通过审批绕过；`autoApprove` 不绕任何红线
3. 审批凭证一次性、TTL 120s、与 `capId + 全部参数` 哈希绑定
4. 策略放权必须 `forceApproval`（覆盖 autoApprove）
5. 密码/密钥不进 LLM 上下文与审计明文