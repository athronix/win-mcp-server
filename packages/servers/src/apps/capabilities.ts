import { z } from 'zod';
import { PlanStore, ToolFailure, type CapabilitySpec, type PowerShellBridge } from '@win-mcp/core';
import { guard } from '../shared/errors.js';
import { buildWingetPlan, type WingetOperation, type WingetPlan } from './plan.js';

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

  // 计划一次性、5 分钟过期；planId 只证明"与预览一致"，不代替用户同意
  const plans = new PlanStore();

  const planOperation = (operation: WingetOperation): string => `winget.${operation}`;

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
    // ---------------- CL-013: planId 三分支 ----------------
    {
      id: 'apps.winget.plan',
      name: '生成 winget 计划',
      description:
        '预览安装/卸载计划并返回 planId（L1，不做任何变更）。三个分支：' +
        'status=blocked（有 blocker，整份拒绝）/ no-changes（目标状态已满足，执行不会有变更）/ ready（有真实变更）。' +
        '再用相同参数 + planId + confirm=true 调 apps.winget.apply 执行。planId 5 分钟过期、一次性。',
      risk: 'L1',
      idempotent: true,
      timeoutMs: 120_000,
      inputSchema: {
        operation: z.enum(['install', 'uninstall']).describe('install 或 uninstall'),
        ids: z.array(z.string().min(1)).min(1).max(20).describe('winget 包 ID（Publisher.Package，精确匹配）'),
      },
      async handler(params) {
        const operation = str(params.operation, 'install') as WingetOperation;
        const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];

        const state = await guard(
          call<{ available: boolean; version: string; packages: { id: string; installed: boolean }[] }>(
            'Get-WingetInstalledState',
            { IdsJson: JSON.stringify(ids) },
            90_000,
          ),
        );

        // 只把"已安装"的包折成 installed 列表交给纯函数，避免误判
        const installed = (state.packages ?? []).filter((item) => item.installed).map((item) => ({ id: item.id }));
        const plan = buildWingetPlan({
          operation,
          ids,
          installed,
          wingetAvailable: state.available,
          ...(state.version !== undefined ? { wingetVersion: state.version } : {}),
        });

        const added = plans.add(planOperation(operation), { operation, ids }, plan);
        return {
          data: {
            planId: added.planId,
            expiresAt: new Date(added.expiresAt).toISOString(),
            plan,
            nextStep:
              plan.status === 'ready'
                ? '向用户展示 plan.summary 与 changes，得到同意后用相同 operation/ids + planId + confirm=true 调 apps.winget.apply'
                : '该计划不会执行任何变更；把 blockers / noChanges 原样告知用户即可',
          },
          warnings:
            plan.unverified.length > 0
              ? [`以下包未能确认在源中存在（需要联网逐一核实，执行时 winget 会最终判定）：${plan.unverified.join(', ')}`]
              : [],
        };
      },
    },
    {
      id: 'apps.winget.apply',
      name: '执行 winget 计划',
      description:
        '按 planId 执行 apps.winget.plan 生成的计划（L2 需审批）。operation 与 ids 必须与预览完全一致，否则 PLAN_MISMATCH。' +
        'blocked 计划返回 PLAN_BLOCKED；no-changes 计划返回 NO_CHANGES 且不做任何动作。第三方安装器无法自动回滚。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 600_000,
      inputSchema: {
        planId: z.string().min(8).describe('apps.winget.plan 返回的 planId'),
        operation: z.enum(['install', 'uninstall']).describe('必须与预览时一致'),
        ids: z.array(z.string().min(1)).min(1).max(20).describe('必须与预览时完全一致'),
        confirm: z.literal(true).describe('必须显式传 true，表示已展示给用户并获得同意'),
      },
      async handler(params) {
        const operation = str(params.operation, 'install') as WingetOperation;
        const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
        const consumed = plans.consume<WingetPlan>(str(params.planId), planOperation(operation), { operation, ids });
        if (!consumed.ok) {
          throw new ToolFailure(consumed.code, consumed.message);
        }
        const plan = consumed.plan;

        if (plan.status === 'blocked') {
          throw new ToolFailure('PLAN_BLOCKED', `计划被拒绝：${plan.blockers.join('；')}`, { blockers: plan.blockers });
        }
        if (plan.status === 'no-changes') {
          return {
            data: { status: 'no-changes', executed: 0, plan },
            warnings: ['目标状态已满足，未执行任何操作'],
          };
        }

        const results: { id: string; ok: boolean; exitCode?: number; output?: string }[] = [];
        for (const change of plan.changes) {
          try {
            const result = await call<{ ok: boolean; exitCode: number; text: string }>(
              'Invoke-WingetAction',
              { Action: change.action, Target: change.id },
              300_000,
            );
            results.push({
              id: change.id,
              ok: result.ok === true,
              exitCode: result.exitCode,
              output: String(result.text ?? '').slice(-600),
            });
          } catch (error) {
            // 第三方安装器失败不保证可逆：逐项记录，继续下一项，最后统一报告
            results.push({
              id: change.id,
              ok: false,
              output: error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600),
            });
          }
        }

        const failedItems = results.filter((item) => !item.ok);
        return {
          data: {
            status: failedItems.length === 0 ? 'applied' : 'partially-applied',
            executed: results.length,
            failed: failedItems.length,
            results,
            plan,
            rollback: '第三方安装器不支持自动回滚；如需撤销请用 appwiz 或 winget uninstall 人工处理',
          },
          effectState: failedItems.length === 0 ? 'committed' : 'unknown',
          ...(failedItems.length > 0
            ? { warnings: [`${failedItems.length}/${results.length} 项失败，效果未知，不要盲目重试同一 planId（已一次性消费）`] }
            : {}),
        };
      },
    },
  ];
}