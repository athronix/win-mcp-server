---
name: win-system
description: Windows 系统操作（服务、进程、事件日志、任务计划、注册表、启动项、网络）。只读直放，写操作需审批。
tags: [windows, system, mcp, services, registry]
triggers:
  - 系统信息 / 机器配置
  - 服务启动停止 / 进程结束
  - 注册表读写
  - 事件日志 / 蓝屏排查
  - 启动项 / 开机自启
  - 网络配置 / DNS
requirements: [win-mcp-system]
risk: L0-L2
---

# win-system 场景手册

## 能力速查

| 工具 | 风险 | 说明 |
|---|---|---|
| `system.info.get` | L0 | OS/CPU/内存/机型/提权状态（2-4s） |
| `system.service.list` | L0 | 服务列表，可按名称过滤 |
| `system.service.control` | L2 | start/stop/restart（**审批**） |
| `system.process.list` | L0 | 按 CPU 倒序列进程 |
| `system.process.terminate` | L2 | 按 PID/名称结束（**审批**；受保护进程直拒） |
| `system.eventlog.query` | L0 | 按级别查事件日志 |
| `system.task.list` | L0 | 计划任务 |
| `system.registry.read` | L0 | 读键值（HKCU 全量、HKLM 仅 SOFTWARE） |
| `system.registry.write` | L2 | 写键值（**审批** + 自动备份，默认仅 HKCU） |
| `system.startup.list` | L0 | 启动项 |
| `system.network.get` | L0 | 适配器/IP/网关/DNS |

## SOP

### 排查"某服务异常"
1. `system.service.list { filter: "<服务名>" }` → 看 `status` / `startType`
2. `system.eventlog.query { logName: "System", level: "error", maxEvents: 20 }` → 找对应来源
3. 需要重启服务：`system.service.control { name, action: "restart" }` → **向用户展示 impact 并等批准**

### 排查"系统变慢"
1. `system.info.get` → 内存总量/可用、运行时长
2. `system.process.list { top: 15 }` → 找 CPU 时间异常者
3. 需要结束：`system.process.terminate { id }`（**审批**）
4. 不要杀 `lsass/csrss/winlogon/services/wininit` —— 会被 `POLICY_DENIED`，且属系统关键进程

### 修改注册表项
1. `system.registry.read { path, name }` → 确认当前值与类型
2. `system.registry.write { path, name, value, type }` → **审批**
3. 返回里带 `backupPath`；需要回滚时把旧值写回

### 排查开机自启
`system.startup.list` → 得到 `registry:HKCU` / `startup-folder` 来源；删除需走 `system.registry.write` 或直接告警

## 不要做

- 不要试图用审批绕过 `POLICY_DENIED`（策略拒绝发生在审批之前）
- 不要写 `HKLM`（默认拒绝）；如确需，让用户在部署配置里加白
- 不要一次拉全部服务（`maxItems` 默认 200，取太多会撑上下文）
- 事件日志消息随系统语言变化，**只依赖 `eventId` 与 `level`，不要匹配中文文案**