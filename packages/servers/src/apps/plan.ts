/**
 * winget 计划的纯函数部分（不碰 IO，便于单测）
 *
 * 三个分支（照 winutil-cn 的 supported/blockers 形态）：
 * 1. blocked   —— 有 blocker（winget 不可用 / 非法 ID），整份拒绝，一个都不执行
 * 2. no-changes —— 目标状态已满足（已装又要装、未装又要卸），不执行但不算失败
 * 3. ready     —— 有真实变更，可执行
 */
export type WingetOperation = 'install' | 'uninstall';

export interface InstalledAppLike {
  id?: string;
  name?: string;
  wingetId?: string;
  source?: string;
}

export interface WingetPlan {
  operation: WingetOperation;
  supported: boolean;
  status: 'ready' | 'no-changes' | 'blocked';
  summary: string;
  blockers: string[];
  changes: { id: string; action: WingetOperation; reason: string }[];
  noChanges: { id: string; reason: string }[];
  unverified: string[];
  requiresAdministrator: boolean;
  generatedAt: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function installedIds(installed: readonly InstalledAppLike[]): string[] {
  const ids: string[] = [];
  for (const app of installed) {
    for (const candidate of [app.wingetId, app.id, app.name]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) ids.push(normalize(candidate));
    }
  }
  return ids;
}

export function buildWingetPlan(input: {
  operation: WingetOperation;
  ids: readonly string[];
  installed: readonly InstalledAppLike[];
  wingetAvailable: boolean;
  wingetVersion?: string;
}): WingetPlan {
  const blockers: string[] = [];
  const changes: WingetPlan['changes'] = [];
  const noChanges: WingetPlan['noChanges'] = [];
  const unverified: string[] = [];

  if (!input.wingetAvailable) {
    blockers.push('winget 不可用：请先安装 App Installer 或确认 PATH 中可调用 winget');
  }
  if (input.ids.length === 0) {
    blockers.push('ids 为空：至少给一个 winget 包 ID');
  }

  const known = new Set(installedIds(input.installed));

  for (const rawId of input.ids) {
    const id = rawId.trim();
    if (id.length === 0) {
      blockers.push('存在空白包 ID');
      continue;
    }
    // winget 包 ID 形如 Publisher.Package，含空格说明大概率传了显示名
    if (/\s/.test(id)) {
      blockers.push(`'${id}' 含空格，像是显示名而不是包 ID（应为 Publisher.Package）`);
      continue;
    }

    const present = known.has(normalize(id));

    if (input.operation === 'install') {
      if (present) {
        noChanges.push({ id, reason: '已安装，无需再装' });
      } else {
        changes.push({ id, action: 'install', reason: '当前未检测到该包' });
        unverified.push(id);
      }
    } else {
      if (present) {
        changes.push({ id, action: 'uninstall', reason: '当前已安装' });
      } else {
        noChanges.push({ id, reason: '未检测到该包，无需卸载' });
      }
    }
  }

  const supported = blockers.length === 0;
  const status: WingetPlan['status'] = !supported ? 'blocked' : changes.length === 0 ? 'no-changes' : 'ready';

  const summary =
    status === 'blocked'
      ? `计划被拒绝：${blockers.join('；')}`
      : status === 'no-changes'
        ? '目标状态已经满足，执行不会有任何变更'
        : `将${input.operation === 'install' ? '安装' : '卸载'} ${changes.length} 个包`;

  return {
    operation: input.operation,
    supported,
    status,
    summary,
    blockers,
    changes,
    noChanges,
    unverified,
    // 装到机器级位置通常需要提权；这里按经验给保守提示，最终由 winget 自己决定
    requiresAdministrator: input.operation === 'install',
    generatedAt: new Date().toISOString(),
  };
}