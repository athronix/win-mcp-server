/**
 * 风险等级（L0-L3）— 对应 FR-102
 *
 * L0 只读/变换，不改系统状态
 * L1 用户域内可逆写
 * L2 破坏性 / 系统态变更
 * L3 高危不可逆（即使审批也必须逐项确认 impact）
 */
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

export const RISK_LEVELS: readonly RiskLevel[] = Object.freeze(['L0', 'L1', 'L2', 'L3'] as const);

const RANK: Readonly<Record<RiskLevel, number>> = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3 });

/** 风险等级数值权重：L0=0 … L3=3 */
export function riskRank(risk: RiskLevel): number {
  return RANK[risk];
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

/** 取两者中较高的风险等级 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/** risk 是否不低于 min（risk >= min） */
export function riskAtLeast(risk: RiskLevel, min: RiskLevel): boolean {
  return riskRank(risk) >= riskRank(min);
}