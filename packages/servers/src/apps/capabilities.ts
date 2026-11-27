import { z } from 'zod';
import type { CapabilitySpec, PowerShellBridge } from '@win-mcp/core';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** win-apps：应用清单、winget 搜索与装卸、启动应用 */
export function appsCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    bridge.call<T>('module', { module: 'apps', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {});

  return [
    {
      id: 'apps.list.installed',
      name: '已安装应用',
      description:
        '从注册表 Uninstall 键（HKLM 64/32 + HKCU）汇总已安装应用：名称/版本/发布者/安装日期/卸载命令（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 60_000,
      inputSchema: {
        filter: z.string().optional().describe('按应用名模糊过滤'),
        maxItems: z.number().int().min(1).max(1000).optional().describe('最多返回条数，默认 200'),
      },
      async handler(params) {
        return {
          data: await call('Get-InstalledApps', {
            Filter: str(params.filter),
            MaxItems: num(params.maxItems, 200),
          }),
        };
      },
    },
    {
      id: 'apps.winget.info',
      name: 'winget 环境',
      description: '检查 winget 是否可用及版本（只读 L0）。装卸前先确认。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-WingetInfo') };
      },
    },
    {
      id: 'apps.winget.search',
      name: '搜索软件包',
      description: '用 winget 搜索软件包（只读 L0，自动接受源协议）。返回 exitCode 与前 80 行输出。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 120_000,
      inputSchema: {
        query: z.string().min(1).describe('搜索关键词或包名'),
      },
      async handler(params) {
        return {
          data: await call(
            'Invoke-WingetAction',
            { Action: 'search', Target: str(params.query) },
            180_000,
          ),
        };
      },
    },
    {
      id: 'apps.winget.install',
      name: '安装软件包',
      description:
        'winget 安装（L2，需审批）。默认 --silent 并接受包协议；可能耗时数分钟。参数 id 为 winget 包 ID（精确匹配）。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 360_000,
      inputSchema: {
        id: z.string().min(1).describe('winget 包 ID，如 Microsoft.VisualStudioCode'),
      },
      async handler(params) {
        return {
          data: await call(
            'Invoke-WingetAction',
            { Action: 'install', Target: str(params.id) },
            300_000,
          ),
          effectState: 'committed',
        };
      },
    },
    {
      id: 'apps.winget.uninstall',
      name: '卸载软件包',
      description:
        'winget 卸载（L2，需审批）。仅对 winget 可识别的包生效；卸载后建议用 apps.list.installed 核验残留。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 360_000,
      inputSchema: {
        id: z.string().min(1).describe('winget 包 ID'),
      },
      async handler(params) {
        return {
          data: await call(
            'Invoke-WingetAction',
            { Action: 'uninstall', Target: str(params.id) },
            300_000,
          ),
          effectState: 'committed',
        };
      },
    },
    {
      id: 'apps.app.launch',
      name: '启动应用',
      description:
        '按命令名启动应用（L1）：先按 PATH 解析，再按现有文件路径解析。请传可执行名（如 notepad、code），不要传 Program Files 下的绝对路径——那会被路径黑名单拒绝。',
      risk: 'L1',
      inputSchema: {
        name: z.string().min(1).describe('可执行名或命令名，如 notepad、code、explorer'),
        arguments: z.string().optional().describe('启动参数（原样传给进程）'),
      },
      async handler(params) {
        return {
          data: await call('Start-Application', {
            Name: str(params.name),
            Arguments: str(params.arguments),
          }),
          effectState: 'committed',
        };
      },
    },
  ];
}