# 项目开发状态

> 版本：v0.14.0 · 更新：2026-11-27 · 当前 CL：无（CL-017 已完成）

## 总体进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 1 调研 | ✅ | PROJECT-OVERVIEW、CONTEXT-ANALYSIS-cl002 |
| Phase 2 设计 | ✅ | core / bridge 技术方案、两份测试方案 |
| Phase 3 实现 | ✅ | 底座 10 模块 + 网关 + PS 桥 |
| Phase 4 验证 | ✅ | 139 测试 + 12 底座冒烟 + 6 桥冒烟 |
| Phase 5 迭代 | ✅ | CL-001 修 4 缺陷、CL-002 修 4 缺陷 |
| Phase 6 配套 | ✅ | 部署/用户指南 + README |
| Phase 7 交付 | ✅ | 索引同步 + 原子提交 |

## 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | DDD 基线文档与六索引 | ✅ |
| M1 | contracts/registry/classify/policy | ✅ |
| M2 | approval/audit/guard/taskmgr | ✅ |
| M3 | MCP 网关 stdio + HTTP | ✅ |
| M4 | 单测全绿 + 冒烟 12/12 | ✅ |
| M5 | 配套文档 + 索引同步 + 提交 | ✅ |
| M6 | PowerShell 桥 + 真 AST（CL-002） | ✅ |
| M7 | win-system 第一个业务 server（CL-003） | ✅ |
| M8 | win-shell 双命令通道（CL-004） | ✅ |
| M9 | win-apps + win-resource（CL-005/006） | ✅ |
| M10 | win-desktop + win-browser（CL-007/008） | ✅ |
| M11 | 6 Skill bundle + 接入包（CL-009/010） | ✅ |
| M12 | win-desktop UIA + 键鼠 + 门控（CL-011） | ✅ |
| M13 | win-browser CDP 通道（CL-012） | ✅ |
| M14 | 计划与回滚（CL-013） | ✅ |
| M15 | 资源调优快照与回滚（CL-014） | ✅ |
| M16 | 等待机制 + 门控指示器（CL-015） | ✅ |
| M17 | attach / 服务调优 / 精确已装检测（CL-016） | ✅ |
| M18 | 跨请求 watch + 事件负结果归档（CL-017） | ✅ |

## 质量基线（当前）

| 指标 | 值 |
|---|---|
| 单元/集成测试 | **302 passed / 26 files / 0 skip** |
| 底座冒烟 | 12/12 |
| 桥冒烟 | 6/6 |
| 类型检查 | 0 error（strict） |
| 关键 API 文档一致性 | 45/45 |
| 核心模块覆盖率 | classify 93.5% · policy 96.9% · approval 92.2% · audit 96.8% · bridge 84.4% · guard 92.0% · taskmgr 100% |

## Backlog（按优先级）

| CL | 内容 | 优先级 | 依赖 |
|---|---|---|---|
| — | 计划内 CL 已全部完成 | — | — |
| — | 计划内 CL 已全部完成 | — | — |
| — | 计划内 CL 已全部完成 | — | — |
| CL-006 | `win-resource`（指标 + 清理 + 调优回滚） | P1 | CL-003 |
| CL-007 | `win-desktop`（UIA + ref + 门控） | P2 | CL-004 |
| CL-008 | `win-browser`（CDP + 书签自研 + guard） | P2 | — |
| CL-009 | 6 个 Skill bundle（含"需审批/硬禁"清单） | P2 | CL-003..008 |
| CL-010 | 客户端接入包（WorkBuddy/Claude Code/Cursor） | P3 | CL-009 |

## 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| runspace `Stop()` 不打断同步死循环 | 桥可能卡死 | Node 侧超时杀进程兜底（已实现） |
| 默认路径白名单不含 `D:\Users\**` | 写操作被 `pathAllowlist:miss` 拒绝 | 部署指南 4.1 要求显式加白 |
| 单进程审批状态 | 多实例不共享凭证 | 设计限定单进程网关 |
| 执行结果未结构化 | 上层需自行解析文本 | 各 server CL 按 cmdlet 适配 |
| 错误消息随系统语言 | 文案匹配不可靠 | 只依赖错误码，不匹配文案 |
| `runAsAdmin` 仅判级 | 尚未真正提权 | CL-004 |