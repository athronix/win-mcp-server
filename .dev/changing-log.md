# 进行中的变更

> 规则：每个 CL 开始前在此登记；测试通过并迁移到 `changed-log.md` 后清空本节。

（暂无进行中的变更）

## 下一步

**CL-004 `win-shell`**（P0）

| 项 | 内容 |
|---|---|
| 目标 | `shell.analyze` / `shell.invoke`（真 AST 判级 + 受控执行）、`shell.bash`（Git-Bash adapter）、非提权会话 `runAsAdmin` → `ADMIN_REQUIRED` |
| 依赖 | 底座 + CL-002 桥（均已就绪） |
| 验收 | 硬禁不返 approvalId；L2 走审批；Bash 命令同样分级；非提权提权请求直接失败 |
| 不做 | 人类可见控制台（需独立窗口进程与 UAC，留 CL-004b） |