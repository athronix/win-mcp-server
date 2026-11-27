---
name: win-resource
description: 资源与存储（CPU/内存/GPU 指标、磁盘空间、清理分析、清理执行）。
tags: [windows, resource, disk, cleanup, performance, mcp]
triggers:
  - 磁盘满了 / 空间不足
  - CPU 高 / 内存高
  - 清理垃圾 / 临时文件
  - 磁盘使用率
requirements: [win-mcp-resource]
risk: L0-L2
---

# win-resource 场景手册

## 能力速查

| 工具 | 风险 | 说明 |
|---|---|---|
| `resource.metrics.get` | L0 | CPU/内存/进程数/GPU 单次采样 |
| `resource.disk.space` | L0 | 各卷容量/可用/使用率/健康 |
| `resource.cleanup.analyze` | L0 | 用户/系统 TEMP 占用（只读） |
| `resource.cleanup.execute` | L2 | 清理用户 TEMP（**审批**） |

## SOP

### "磁盘满了"
1. `resource.disk.space` → 定位是哪个盘（`usedPercent` 高的）
2. `resource.cleanup.analyze` → 看 TEMP 可释放量
3. 若 TEMP 占比可观：`resource.cleanup.execute { olderThanMinutes: 1440 }` → **审批**（说明只删 1 天前的临时文件）
4. 批准后返回 `deleted / failed / freedMB`
5. 复查 `resource.disk.space`

> 不要承诺"清完能腾出 X GB"——先 analyze 再报数字。

### "机器卡"
1. `resource.metrics.get` → CPU% / 内存使用率 / 进程数
2. 内存 > 90% 或 CPU 持续高 → 用 `system.process.list`（win-system）定位进程
3. 需要结束进程走 `system.process.terminate`（另一个 server）

### 定期体检
`resource.metrics.get` + `resource.disk.space` + `resource.cleanup.analyze` 三个 L0 工具可无审批串起来跑。

## 边界

- 清理**只作用于当前用户 TEMP 根目录下的文件**，不递归删目录、不碰系统目录、不清回收站
- 系统 TEMP（`C:\Windows\Temp`）只统计不清理（需管理员）
- 无调优能力（电源计划/服务禁用/注册表优化）——不要声称能"优化性能"
- 指标是单次采样，不是持续监控；不要把一次采样当趋势