---
name: win-shell
description: PowerShell 与 Git-Bash 命令通道。动态 L0-L3 分级，L2+ 需审批，硬禁命令直接拒绝。
tags: [windows, shell, powershell, bash, mcp]
triggers:
  - 执行命令 / 跑脚本
  - PowerShell / pwsh
  - bash / git-bash
  - 命令预检 / 风险确认
requirements: [win-mcp-shell]
risk: L0-L3
---

# win-shell 场景手册

## 能力速查

| 工具 | 风险 | 说明 |
|---|---|---|
| `shell.env.info` | L0 | PS 版本、是否提权、Git-Bash 路径 |
| `shell.cmd.analyze` | L0 | AST 预检：分级、语法错误（行列）、命令、路径。**不执行** |
| `shell.cmd.invoke` | 动态 | 执行 PowerShell；L2+ 审批，硬禁直拒 |
| `shell.bash.invoke` | 动态 | 执行 Git-Bash；同构分级 |

## SOP

### 执行任意命令前（强制）
1. `shell.cmd.analyze { command }` → 看 `risk` / `blocked` / `parseErrors`
2. `blocked=true` → 改写命令，**不要尝试换写法绕过**
3. `syntaxValid=false` → 按 `parseErrors[].line/column` 修语法
4. `risk=L0` → 直接 `shell.cmd.invoke`
5. `risk>=L2` → invoke 会返回 APPROVAL_REQUIRED，把 `impact`（含解析出的路径）展示给用户，批准后原样重发

### 常用只读诊断
```
Get-Process | Sort-Object CPU -Descending | Select-Object -First 10
Get-Service | Where-Object Status -eq 'Stopped'
Get-WinEvent -LogName System -MaxEvents 20
Get-ChildItem $env:TEMP | Measure-Object -Property Length -Sum
```
这些均为 L0，可直接执行。

### Git-Bash
`shell.env.info` 先确认 `bashAvailable=true`；然后 `shell.bash.invoke { command: "ls -la /c/Users" }`。

## 硬禁（无审批通道）

- 编码执行（`-enc` / `FromBase64String`）、`iex` / `Invoke-Expression`
- 下载执行（`DownloadString|iex`、`curl|sh`、`wget|sh`）
- `exit`、杀当前进程、删 `$PSHOME`、`Read-Host` / `pause`
- bash：`rm -rf /`、fork bomb、`eval`、`dd of=/dev/`、`mkfs`

遇到这些先想"用户真正要做什么"，用受控能力替代（如 `system.service.control` 代替 `Stop-Service`）。

## 不要做

- 不要用 `powershell.exe -Command "..."` 外壳包裹（会被拒）
- 不要指望提权：`runAsAdmin=true` 在非提权会话直接 `ADMIN_REQUIRED`
- 不要执行超过 3 分钟的命令（超时后副作用未知，需用户核销）
- 不要用 bash 跑需要管理员权限的操作