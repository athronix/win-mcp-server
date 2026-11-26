# 项目开发状态

> 版本：v0.1.0 · 更新：2026-11-26 · 当前 CL：无（CL-001 已完成）

## 总体进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1 调研 | ✅ 完成 | PROJECT-OVERVIEW |
| Phase 2 设计 | ✅ 完成 | 需求 / 技术方案 / 测试方案 |
| Phase 3 实现 | ✅ 完成 | 底座 8 模块 + 网关 |
| Phase 4 验证 | ✅ 完成 | 106 单测 + 12 冒烟 + 覆盖率 |
| Phase 5 迭代 | ✅ 无返工 | 实现中修正 4 个缺陷 |
| Phase 6 配套 | ✅ 完成 | 部署指南 + 用户指南 + README |
| Phase 7 交付 | ✅ 完成 | 索引同步 + git 提交 |

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | DDD 基线文档与六索引 | ✅ |
| M1 | contracts/registry/classify/policy 编译通过 | ✅ |
| M2 | 审批/审计/守卫/并发可用 | ✅ |
| M3 | MCP 网关 stdio + HTTP 跑通 | ✅ |
| M4 | 单测全绿 + 冒烟 12/12 | ✅ 106 / 12 |
| M5 | 配套文档 + 索引同步 + 提交 | ✅ |

## 质量基线（当前）

| 指标 | 值 |
|---|---|
| 单元/集成测试 | 106 passed / 9 files / 0 skip |
| 冒烟 | 12/12 |
| 类型检查 | 0 error（strict） |
| 关键 API 文档一致性 | 37/37 |
| 核心模块覆盖率 | classify 93.5% · policy 97.3% · approval 91.0% · audit 96.8% · guard 92.0% · taskmgr 100% |

## Backlog（按优先级）

| CL | 内容 | 优先级 | 依赖 |
|---|---|---|---|
| CL-002 | PowerShell 常驻桥 + 真 AST 解析注入 | P0 | 底座 `parser` 注入点 |
| CL-003 | `win-system`（注册表/服务/进程/事件日志/任务计划） | P0 | CL-002 |
| CL-004 | `win-shell`（可见控制台 + Git-Bash adapter） | P0 | CL-002 |
| CL-005 | `win-apps`（winget adapter + planId 分支） | P1 | CL-003 |
| CL-006 | `win-resource`（指标 + 清理 + 调优回滚） | P1 | CL-003 |
| CL-007 | `win-desktop`（UIA + ref + 门控） | P2 | CL-004 |
| CL-008 | `win-browser`（CDP + 书签自研 + guard） | P2 | — |
| CL-009 | 6 个 Skill bundle（含"需审批/硬禁"清单） | P2 | CL-003..008 |
| CL-010 | 客户端接入包（WorkBuddy/Claude Code/Cursor） | P3 | CL-009 |

## 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 真 AST 未接，fallback 偏保守 | 复杂命令多一次审批 | CL-002 优先解决 |
| 默认路径白名单不含 `D:\Users\**` | 写操作被 `pathAllowlist:miss` 拒绝 | 部署指南 4.1 明确要求显式加白 |
| 单进程审批状态 | 多实例不共享凭证 | 设计上限定单进程网关，多实例需外部存储 |
| HTTP 分支单测覆盖低 | 异常/并发路径风险 | 冒烟覆盖主路径；CL-002 补集成测试 |