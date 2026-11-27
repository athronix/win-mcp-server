import { z } from 'zod';
import type { CapabilitySpec, PowerShellBridge } from '@win-mcp/core';

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** win-resource：资源指标、磁盘空间、清理分析（只读）与清理执行（L2） */
export function resourceCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    bridge.call<T>('module', { module: 'resource', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {});

  return [
    {
      id: 'resource.metrics.get',
      name: '资源指标',
      description:
        '采样 CPU 使用率、内存总量/可用/使用率、进程数、GPU 名称与驱动版本（只读 L0）。单次采样，非持续监控。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-ResourceMetrics') };
      },
    },
    {
      id: 'resource.disk.space',
      name: '磁盘空间',
      description: '列出各卷的容量/可用空间/使用率/健康状态（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-VolumeSpace') };
      },
    },
    {
      id: 'resource.cleanup.analyze',
      name: '清理分析',
      description:
        '统计用户 TEMP 与系统 TEMP 的占用大小与文件数（只读 L0，不删除）。根据结果再决定是否执行清理。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 120_000,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-CleanupAnalysis', {}, 120_000) };
      },
    },
    {
      id: 'resource.cleanup.execute',
      name: '清理用户临时文件',
      description:
        '删除当前用户 TEMP 目录下的文件（L2，需审批）。只处理 TEMP 根目录下的文件，不递归删除目录、不触碰系统目录。返回删除数与释放空间。',
      risk: 'L2',
      destructive: true,
      destructivePath: true,
      timeoutMs: 120_000,
      inputSchema: {
        olderThanMinutes: z
          .number()
          .int()
          .min(0)
          .max(43200)
          .optional()
          .describe('只删除早于 N 分钟的文件；0 表示不限'),
        maxDelete: z.number().int().min(1).max(5000).optional().describe('单次最多删除文件数，默认 2000'),
      },
      async handler(params) {
        return {
          data: await call(
            'Clear-UserTempFiles',
            {
              OlderThanMinutes: num(params.olderThanMinutes, 0),
              MaxDelete: num(params.maxDelete, 2000),
            },
            120_000,
          ),
          effectState: 'committed',
        };
      },
    },
  ];
}