import { z } from 'zod';
import type { CapabilitySpec, PowerShellBridge } from '@win-mcp/core';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

/** win-system：系统信息 / 服务 / 进程 / 事件日志 / 任务计划 / 注册表 / 启动项 / 网络 */
export function systemCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> =>
    bridge.call<T>('module', { module: 'system', function: fn, args });

  return [
    {
      id: 'system.info.get',
      name: '系统概览',
      description:
        '读取 OS 版本、CPU、内存、机型、运行时长与当前会话是否提权（只读 L0）。约 2-4 秒（CIM 查询）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-SystemOverview') };
      },
    },
    {
      id: 'system.service.list',
      name: '服务列表',
      description: '列出 Windows 服务（名称/显示名/状态/启动类型），支持按名称模糊过滤（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {
        filter: z.string().optional().describe('按服务名或显示名模糊过滤'),
        maxItems: z.number().int().min(1).max(500).optional().describe('最多返回条数，默认 200'),
      },
      async handler(params) {
        return {
          data: await call('Get-ServiceList', {
            Filter: str(params.filter),
            MaxItems: num(params.maxItems, 200),
          }),
        };
      },
    },
    {
      id: 'system.service.control',
      name: '服务控制',
      description:
        '启动/停止/重启服务（L2，需人工审批）。停止服务可能中断业务；系统关键服务可能失败。action 仅支持 start/stop/restart。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 30_000,
      inputSchema: {
        name: z.string().min(1).describe('服务名（Service name，非显示名）'),
        action: z.enum(['start', 'stop', 'restart']).describe('start | stop | restart'),
      },
      async handler(params) {
        return {
          data: await call('Invoke-ServiceAction', {
            Name: str(params.name),
            Action: str(params.action),
          }),
        };
      },
    },
    {
      id: 'system.process.list',
      name: '进程列表',
      description: '按 CPU 时间倒序列出进程（PID/名称/内存/线程/路径），支持名称过滤（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {
        top: z.number().int().min(1).max(200).optional().describe('返回条数，默认 20'),
        filter: z.string().optional().describe('按进程名模糊过滤'),
      },
      async handler(params) {
        return {
          data: await call('Get-ProcessList', {
            Top: num(params.top, 20),
            Filter: str(params.filter),
          }),
        };
      },
    },
    {
      id: 'system.process.terminate',
      name: '结束进程',
      description:
        '结束指定进程（L2，需审批）。受保护进程（lsass/csrss/winlogon 等）会被策略直接拒绝，审批也无法绕过。参数 id 与 name 二选一。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 20_000,
      inputSchema: {
        id: z.number().int().optional().describe('进程 PID'),
        name: z.string().optional().describe('进程名（不含 .exe），会结束所有同名进程'),
        force: z.boolean().optional().describe('强制结束，默认 false'),
      },
      async handler(params) {
        const ids = typeof params.id === 'number' ? [params.id] : [];
        return {
          data: await call('Stop-ProcessItem', {
            Id: ids,
            Name: str(params.name),
            Force: bool(params.force),
          }),
        };
      },
    },
    {
      id: 'system.eventlog.query',
      name: '事件日志查询',
      description:
        '读取事件日志（只读 L0）。level 支持 critical/error/warning/information/verbose；返回消息截断到 400 字符。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        logName: z.string().optional().describe('日志名，默认 System（支持 Application/Security）'),
        level: z.string().optional().describe('critical|error|warning|information|verbose'),
        maxEvents: z.number().int().min(1).max(200).optional().describe('最多条数，默认 20'),
      },
      async handler(params) {
        return {
          data: await call('Get-EventLogEntries', {
            LogName: str(params.logName, 'System'),
            Level: str(params.level),
            MaxEvents: num(params.maxEvents, 20),
          }),
        };
      },
    },
    {
      id: 'system.task.list',
      name: '任务计划列表',
      description: '列出计划任务（名称/路径/状态/上次与下次运行），支持模糊过滤（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 40_000,
      inputSchema: {
        filter: z.string().optional().describe('按任务名或路径模糊过滤'),
        maxItems: z.number().int().min(1).max(200).optional().describe('最多条数，默认 50'),
      },
      async handler(params) {
        return {
          data: await call('Get-ScheduledTaskList', {
            Filter: str(params.filter),
            MaxItems: num(params.maxItems, 50),
          }),
        };
      },
    },
    {
      id: 'system.registry.read',
      name: '读注册表',
      description:
        '读取注册表键值（只读 L0）。不传 name 时列出该键下所有值。可读范围由策略限定（默认 HKCU 全量、HKLM 仅 SOFTWARE）。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {
        path: z.string().min(3).describe('注册表路径，如 HKCU:\\Software\\Microsoft'),
        name: z.string().optional().describe('值名；省略则列出全部值'),
      },
      async handler(params) {
        return {
          data: await call('Get-RegistryValue', {
            Path: str(params.path),
            Name: str(params.name),
          }),
        };
      },
    },
    {
      id: 'system.registry.write',
      name: '写注册表',
      description:
        '写入/新建注册表值（L2，需审批）。写入前自动备份旧值到 %LOCALAPPDATA%\\win-mcp\\backups。默认策略只允许 HKCU，HKLM 需配置放行。type 支持 String/DWord/QWord/ExpandString/MultiString。',
      risk: 'L2',
      destructive: true,
      snapshot: 'before',
      inputSchema: {
        path: z.string().min(3).describe('注册表路径，如 HKCU:\\Software\\Vendor\\App'),
        name: z.string().min(1).describe('值名'),
        value: z.string().describe('值内容（DWord/QWord 需为数字字符串）'),
        type: z
          .enum(['String', 'DWord', 'QWord', 'ExpandString', 'MultiString'])
          .optional()
          .describe('默认 String'),
      },
      async handler(params) {
        const result = await call<{ backupPath?: string }>('Set-RegistryValue', {
          Path: str(params.path),
          Name: str(params.name),
          Value: str(params.value),
          Type: str(params.type, 'String'),
        });
        return {
          data: result,
          ...(result.backupPath !== undefined
            ? { warnings: [`旧值已备份：${result.backupPath}`] }
            : {}),
        };
      },
    },
    {
      id: 'system.startup.list',
      name: '启动项列表',
      description: '列出开机启动项（HKCU/HKLM Run 键 + 启动文件夹），只读 L0。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-StartupItems') };
      },
    },
    {
      id: 'system.network.get',
      name: '网络配置',
      description: '读取网络适配器、IPv4、网关与 DNS（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-NetworkConfig') };
      },
    },
  ];
}