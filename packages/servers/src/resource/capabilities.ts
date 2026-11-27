import { z } from 'zod';
import { PlanStore, ToolFailure, type CapabilitySpec, type PowerShellBridge } from '@win-mcp/core';
import { guard } from '../shared/errors.js';

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** win-resource：资源指标、磁盘空间、清理分析（只读）与清理执行（L2） */
export function resourceCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    guard(
      bridge.call<T>('module', { module: 'resource', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {}),
    );

  // 计划：key 集合 + snapshotId 绑定；一次性、5 分钟过期
  const plans = new PlanStore();
  const PLAN_OPERATION = 'tune.apply';

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
    // ---------------- CL-014: 调优快照 + 一键回滚 ----------------
    {
      id: 'resource.tune.catalog',
      name: '调优目录',
      description:
        '列出可用调优项（key/说明/是否需要管理员/当前值/本会话是否可应用），只读 L0。' +
        '目录是**硬编码白名单**：不支持任意注册表写入，只能选这些 key。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-TuningCatalog') };
      },
    },
    {
      id: 'resource.tune.plan',
      name: '生成调优计划（含快照）',
      description:
        '为选中的 key 建立快照并返回 planId（L1）。快照在**第一次修改之前**落盘，记录每一项的原值/原类型。' +
        '需要管理员的项在当前未提权时会标为 blocker（不会静默跳过）。确认后用 planId + confirm=true 调 resource.tune.apply。',
      risk: 'L1',
      timeoutMs: 60_000,
      inputSchema: {
        keys: z.array(z.string().min(1)).min(1).max(10).describe('来自 resource.tune.catalog 的 key'),
      },
      async handler(params) {
        const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
        const catalog = await call<{
          items: { key: string; requiresAdmin: boolean; applicable: boolean; description: string; currentValue: string }[];
          elevated: boolean;
        }>('Get-TuningCatalog');

        const known = new Map(catalog.items.map((item) => [item.key, item]));
        const blockers: string[] = [];
        const changes: { key: string; currentValue: string; description: string }[] = [];

        // 目录外的 key 无法快照（不知道要备份什么），直接整份拒绝，别去动系统
        const unknownKeys = keys.filter((key) => !known.has(key));
        for (const key of unknownKeys) {
          blockers.push(`未知 key：${key}（只能用 resource.tune.catalog 列出的）`);
        }
        for (const key of keys) {
          const item = known.get(key);
          if (item === undefined) continue;
          if (!item.applicable) {
            blockers.push(`${key} 需要管理员权限，当前会话未提权`);
            continue;
          }
          changes.push({ key, currentValue: item.currentValue, description: item.description });
        }

        // 未知 key 存在时连快照都不建；其余情况先快照（便于审计与回滚）
        let snapshot: { snapshotId: string; path: string } | null = null;
        if (unknownKeys.length === 0) {
          snapshot = await call<{ snapshotId: string; path: string }>('New-TuningSnapshot', {
            Operation: PLAN_OPERATION,
            TweakKeysJson: JSON.stringify(keys),
          });
        }

        const plan = {
          supported: blockers.length === 0,
          status: blockers.length === 0 ? 'ready' : 'blocked',
          blockers,
          changes,
          snapshotId: snapshot?.snapshotId ?? null,
          snapshotPath: snapshot?.path ?? null,
          elevated: catalog.elevated,
        };
        const added = plans.add(PLAN_OPERATION, { keys }, plan);

        return {
          data: {
            planId: added.planId,
            expiresAt: new Date(added.expiresAt).toISOString(),
            plan,
            nextStep:
              plan.status === 'ready'
                ? '向用户展示 changes 与快照位置，得到同意后带相同 keys + planId + confirm=true 调 resource.tune.apply'
                : '先解决 blockers（通常是提权）；blocked 计划无法执行',
          },
          warnings:
            snapshot !== null
              ? [`快照已写入 ${snapshot.path}（回滚用 resource.tune.rollback + snapshotId=${snapshot.snapshotId}）`]
              : ['未创建快照：计划含未知 key，先修正 keys 再预览'],
        };
      },
    },
    {
      id: 'resource.tune.apply',
      name: '执行调优计划',
      description:
        '按 planId 应用调优（L2 需审批）。keys 必须与预览完全一致，否则 PLAN_MISMATCH。' +
        '逐项记录 before/after 与 verified；需要管理员但未提权的项会被跳过并标注 ADMIN_REQUIRED。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 120_000,
      inputSchema: {
        planId: z.string().min(8).describe('resource.tune.plan 返回的 planId'),
        keys: z.array(z.string().min(1)).min(1).max(10).describe('必须与预览时完全一致'),
        confirm: z.literal(true).describe('必须显式 true，表示已展示给用户并获得同意'),
      },
      async handler(params) {
        const keys = Array.isArray(params.keys) ? (params.keys as string[]) : [];
        interface TunePlan {
          supported: boolean;
          status: string;
          blockers: string[];
          changes: unknown[];
          snapshotId: string;
        }
        const consumed = plans.consume<TunePlan>(String(params.planId ?? ''), PLAN_OPERATION, { keys });
        if (!consumed.ok) throw new ToolFailure(consumed.code, consumed.message);
        if (!consumed.plan.supported) {
          throw new ToolFailure('PLAN_BLOCKED', `计划被拒绝：${consumed.plan.blockers.join('；')}`, {
            blockers: consumed.plan.blockers,
          });
        }

        const result = await call<{ appliedCount: number; failedCount: number; failures: unknown[] }>(
          'Invoke-TuningApply',
          { SnapshotId: consumed.plan.snapshotId, TweakKeysJson: JSON.stringify(keys) },
          90_000,
        );

        return {
          data: { ...result, snapshotId: consumed.plan.snapshotId, rollbackHint: `resource.tune.rollback { snapshotId: "${consumed.plan.snapshotId}" }` },
          effectState: result.failedCount === 0 ? 'committed' : 'unknown',
          ...(result.failedCount > 0
            ? { warnings: [`${result.failedCount} 项未能应用（见 failures）；已应用部分可用快照回滚`] }
            : {}),
        };
      },
    },
    {
      id: 'resource.tune.rollback',
      name: '一键回滚调优',
      description:
        '按 snapshotId 逆序回滚一次调优（L2 需审批）。原本不存在的值会被删除而不是写默认值；' +
        '电源方案恢复到快照时的活动方案。只接受快照 GUID，不接受路径。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 120_000,
      inputSchema: {
        snapshotId: z.string().min(8).describe('resource.tune.plan 返回的 snapshotId（GUID）'),
      },
      async handler(params) {
        return {
          data: await call('Restore-TuningSnapshot', { SnapshotId: String(params.snapshotId ?? '') }, 90_000),
          effectState: 'committed',
        };
      },
    },
    {
      id: 'resource.tune.snapshots',
      name: '调优快照列表',
      description:
        '列出调优快照（GUID/操作/条目数/时间）与"首次基线"快照（latest，只在第一次生成时写入），只读 L0。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        maxItems: z.number().int().min(1).max(100).optional().describe('最多返回条数，默认 20'),
      },
      async handler(params) {
        return { data: await call('Get-TuningSnapshots', { MaxItems: num(params.maxItems, 20) }) };
      },
    },
  ];
}