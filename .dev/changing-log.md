# 进行中的变更

> 规则：每个 CL 开始前在此登记；测试通过并迁移到 `changed-log.md` 后清空本节。

（暂无进行中的变更）

## 下一步候选

**CL-002 PowerShell 常驻桥 + 真 AST 解析注入**（P0）

| 项 | 内容 |
|---|---|
| 目标 | 用常驻 pwsh 子进程提供 `CommandParser`（官方 `Parser::ParseInput`）与命令执行，替换 fallback |
| 依赖 | 底座 `parser` 注入点（已就绪） |
| 验收 | 复杂语法（here-string、嵌套子表达式、注释）判级与 PowerShell 一致；桥异常时 `PREFLIGHT_UNAVAILABLE` fail-closed |
| 风险 | Windows 进程管理、NDJSON 协议、自动重启 |

**CL-003 `win-system`**（P0）：注册表/服务/进程/事件日志/任务计划，全部经底座 gate。