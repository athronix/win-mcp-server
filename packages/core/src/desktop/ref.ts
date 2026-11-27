/**
 * 元素 ref 语义（照 agent-desktop 的 @<snapshot>:e<N>）
 *
 * 规则：
 * - ref 只在生成它的快照内有效；UI 变化后必须重新快照。
 * - 裸 `@e8` 一律拒绝 —— 没有快照 id 就无法判断陈旧，宁可报参数错误。
 * - ref 不携带元素身份；身份校验在 PowerShell 侧做（runtimeId → identity）。
 */
const REF_PATTERN = /^@s(\d+):e(\d+)$/;

export interface ParsedRef {
  raw: string;
  snapshotId: number;
  index: number;
}

export function parseRef(value: unknown): ParsedRef | null {
  if (typeof value !== 'string') return null;
  const matched = REF_PATTERN.exec(value);
  if (matched === null) return null;
  return { raw: value, snapshotId: Number(matched[1]), index: Number(matched[2]) };
}

export function isRef(value: unknown): boolean {
  return parseRef(value) !== null;
}

export function formatRef(snapshotId: number, index: number): string {
  return `@s${snapshotId}:e${index}`;
}

/** 参数校验提示：把用户常见的裸 ref 写法直接点出来 */
export function refHint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return 'ref 缺失：请先调用 desktop.ui.snapshot 并用返回的 @s<snapshot>:e<N> 形式';
  }
  if (/^@?e\d+$/.test(value)) {
    return `ref '${value}' 缺少快照 id：必须是 @s<snapshot>:e<N>（来自最近一次 desktop.ui.snapshot）`;
  }
  return `ref '${value}' 格式非法：必须是 @s<snapshot>:e<N>`;
}