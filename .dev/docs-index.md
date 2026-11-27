# 文档索引

> 文档版本：v0.8.0 · 最后更新：2026-11-27
> 规则：文档是代码行为的唯一来源；代码与文档不符即缺陷（NFR-6）。

## Phase 1 调研

| 文档 | 说明 | 版本 | 状态 |
|---|---|---|---|
| `docs/01-investigation/PROJECT-OVERVIEW.md` | 项目概况、任务理解、变更目标、环境与上游资产 | v0.1.0 | ✅ |
| `docs/01-investigation/CONTEXT-ANALYSIS-cl002.md` | CL-002 现状、fallback 实测偏差、任务范围、目标 G1–G6、风险 | v0.2.0 | ✅ |

## Phase 2 设计

| 文档 | 说明 | 版本 | 状态 |
|---|---|---|---|
| `docs/02-design/REQUIREMENT-v0.1.0.md` | FR-101..109、NFR-1..7、需求→测试追溯 | v0.1.0 | ✅ 已基线 |
| `docs/02-design/TECHNICAL-SOLUTION-core.md` | 选型、ADR-001..010、模块映射、接口签名、数据模型、实现逻辑、与本地项目差异 | v0.1.0 | ✅ 已基线（含实现回写） |
| `docs/02-design/TEST-PLAN-v0.1.0.md` | 测试策略、用例清单、通过标准、不可测项 | v0.1.0 | ✅ 已基线 |
| `docs/02-design/TECHNICAL-SOLUTION-bridge.md` | 桥协议、Node 接口、失败模型、路径证据贯通（§4.4） | v0.2.0 | ✅ 已基线 |
| `docs/02-design/TEST-PLAN-cl002.md` | 协议 6 + 桥 10 + 真机 12 + 冒烟 6 | v0.2.0 | ✅ 已基线 |

## Phase 4 验证

| 文档 | 说明 | 版本 | 状态 |
|---|---|---|---|
| `docs/03-verification/TEST-REPORT-v0.1.0.md` | 106 单测 + 12 冒烟结果、覆盖率、缺陷修正、遗留风险 | v0.1.0 | ✅ |
| `docs/03-verification/TEST-REPORT-cl002.md` | 139 测试 + 6 桥冒烟、bridge 覆盖率 84.4%、4 个缺陷、与 fallback 对比 | v0.2.0 | ✅ |

## Phase 6 配套

| 文档 | 说明 | 版本 | 状态 |
|---|---|---|---|
| `docs/04-peripherals/DEPLOYMENT-GUIDE.md` | 安装、stdio/HTTP 接入、策略配置、排障、生产检查清单 | v0.1.0 | ✅ |
| `docs/04-peripherals/USER-GUIDE.md` | 能力清单、审批交互、风险等级、错误码、隐私与限制 | v0.1.0 | ✅ |

## Phase 7 交付（按 CL）

| 文档 | 说明 | 状态 |
|---|---|---|
| `docs/changes/CL-003.md` | win-system 合并版记录（方案/实测/缺陷/遗留） | ✅ |
| `docs/changes/CL-004.md` | win-shell 合并版记录（bash 分级/两个策略缺口修复） | ✅ |
| `docs/changes/CL-005-006.md` | apps + resource 合并版记录（含与架构设计的偏差） | ✅ |
| `docs/changes/CL-007-008.md` | desktop + browser 合并版记录（URL 误判修复） | ✅ |
| `docs/changes/CL-009-010.md` | Skill bundle 与接入包 | ✅ |
| `docs/changes/CL-011.md` | UIA 语义树 / 键鼠 / 桌面门控（含 Electron 结论） | ✅ |

## 仓库根

| 文档 | 说明 |
|---|---|
| `README.md` | 项目定位、快速开始、安全模型、路线图 |

## 上游参考（仓库外，只读）

| 文档 | 说明 |
|---|---|
| `deep-research/win-mcp-skill-plugin/win-mcp-skill-16-proj-review.md` | 16 项目深度调研 + 架构设计（本项目设计依据） |
| `deep-research/win-mcp-skill-plugin/Windows-MCP-Servers_6类基线选型与README核验.md` | 6 类基线选型 |

## 变更记录

| 日期 | 文档 | 变更 |
|---|---|---|
| 2026-11-26 | 全部 | 初版建立（CL-001） |
| 2026-11-26 | TECHNICAL-SOLUTION-core.md | 实现回写：`ParsedCommand.dynamicCalls`、`ExecuteFn` 上下文、`verify(entries?)`、consume reason、gateway §3.3.11、3b 命令白名单、gate 步骤 0 |
| 2026-11-26 | TECHNICAL-SOLUTION-core.md | CL-002：`PolicyRequest.pathEvidence`（命令型参数改用 AST 证据） |
| 2026-11-26 | 新增 bridge 三份文档 | CL-002：CONTEXT-ANALYSIS / TECHNICAL-SOLUTION-bridge / TEST-PLAN / TEST-REPORT |