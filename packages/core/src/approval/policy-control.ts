import type { RiskLevel } from '../contracts/risk.js';

export interface AutoApproveState {
  enabled: boolean;
  maxRisk: 'L2' | 'L3';
}

export interface PolicyControlVerdict {
  direction: 'loosen' | 'tighten' | 'unchanged';
  effectiveRisk: RiskLevel;
  forceApproval: boolean;
  from: AutoApproveState;
  to: AutoApproveState;
}

/** 有效权限等级：disabled=0 / L2=2 / L3=3 */
function rank(state: AutoApproveState): number {
  if (!state.enabled) return 0;
  return state.maxRisk === 'L3' ? 3 : 2;
}

/**
 * 防自我放权判定（FR-104，移植 server.js:278-304）
 * 放权 → L3 + forceApproval（绕过 autoApprove）
 * 收紧/不变 → L1 直接执行
 */
export function evaluatePolicyControl(
  current: AutoApproveState,
  target: AutoApproveState,
): PolicyControlVerdict {
  const currentRank = rank(current);
  const targetRank = rank(target);
  const direction: PolicyControlVerdict['direction'] =
    targetRank > currentRank ? 'loosen' : targetRank < currentRank ? 'tighten' : 'unchanged';
  const loosen = direction === 'loosen';
  return {
    direction,
    effectiveRisk: loosen ? 'L3' : 'L1',
    forceApproval: loosen,
    from: { ...current },
    to: { ...target },
  };
}