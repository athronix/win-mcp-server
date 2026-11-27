/**
 * 桌面控制门控表（照 CursorTouch/Windows-MCP 的 control_policy 单表分类）
 *
 * 分类的是"对用户桌面的干扰程度"，不是破坏性：
 * - direct   ：直接注入鼠标/键盘，用户会立刻感知
 * - possible ：可能打断用户（启动应用、写剪贴板、关闭窗口）
 * - other    ：后台/只读，对桌面无干扰
 *
 * 关键约束（与上游一致）：
 * 1. 本表是唯一分类处，新增 desktop 能力必须在此登记，否则被覆盖测试抓住；
 * 2. 未登记能力按 direct 处理（fail closed），防止新能力悄悄绕过门控；
 * 3. ControlStatus 类查询永不需要门控，否则用户连"谁在控制"都查不到。
 */
export type ControlPolicy = 'relaxed' | 'balanced' | 'strict';
export type ControlClass = 'direct' | 'possible' | 'other';

interface ModeEntry {
  mode: Record<string, ControlClass>;
  fallback?: ControlClass;
}

type TableEntry = ControlClass | ModeEntry;

/** 永远不需要门控的能力（否则看状态本身会要求授权，形成死锁） */
export const CONTROL_FREE = ['desktop.control.state'] as const;

const CONTROL_TABLE: Record<string, TableEntry> = {
  'desktop.screen.capture': 'other',
  'desktop.window.list': 'other',
  'desktop.clipboard.get': 'other',
  'desktop.ui.snapshot': 'other',
  // 等待只是读，不动鼠标键盘；归 other 才不会被门控逼着弹窗
  'desktop.ui.wait': 'other',
  'desktop.control.state': 'other',
  'desktop.control.policy': 'other',
  'desktop.window.control': {
    mode: { activate: 'direct', minimize: 'direct', maximize: 'direct', restore: 'direct', close: 'possible' },
    fallback: 'possible',
  },
  'desktop.clipboard.set': 'possible',
  'desktop.ui.act': 'direct',
  'desktop.input.send': {
    mode: { move: 'other', scroll: 'direct', click: 'direct', drag: 'direct', press: 'direct', type: 'direct' },
    fallback: 'direct',
  },
};

export const CONTROL_POLICY_VALUES: readonly ControlPolicy[] = ['relaxed', 'balanced', 'strict'];

export function isControlPolicy(value: unknown): value is ControlPolicy {
  return typeof value === 'string' && (CONTROL_POLICY_VALUES as readonly string[]).includes(value);
}

/** 解析能力的控制分类；未登记能力按 direct（fail closed） */
export function controlClassOf(capabilityId: string, args: Record<string, unknown> = {}): ControlClass {
  const entry = CONTROL_TABLE[capabilityId];
  if (entry === undefined) return 'direct';
  if (typeof entry === 'string') return entry;

  const mode = args['action'] ?? args['mode'] ?? args['operation'];
  if (typeof mode === 'string') {
    const classified = entry.mode[mode.toLowerCase()];
    if (classified !== undefined) return classified;
  }
  return entry.fallback ?? 'direct';
}

/** 该策略下是否必须持有桌面控制权 */
export function requiresControl(
  policy: ControlPolicy,
  capabilityId: string,
  args: Record<string, unknown> = {},
): boolean {
  if ((CONTROL_FREE as readonly string[]).includes(capabilityId)) return false;

  const controlClass = controlClassOf(capabilityId, args);
  if (policy === 'strict') return true;
  if (policy === 'relaxed') return controlClass === 'direct';
  return controlClass === 'direct' || controlClass === 'possible';
}

/** 覆盖检查：返回未在门控表中登记的能力 ID（供测试与启动自检使用） */
export function unclassifiedCapabilities(capabilityIds: readonly string[]): string[] {
  return capabilityIds.filter((id) => CONTROL_TABLE[id] === undefined && !(CONTROL_FREE as readonly string[]).includes(id));
}