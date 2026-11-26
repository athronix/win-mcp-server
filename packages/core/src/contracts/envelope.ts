import type { Artifact, EffectState } from './capability.js';
import type { ToolError } from './errors.js';
import type { RiskLevel } from './risk.js';

/** 审批分支：本地两阶段 / planId / 协议 elicitation（凭证互不可冒用） */
export type ApprovalBranch = 'local' | 'plan' | 'elicitation';

export interface ApprovalPayload {
  approvalId: string;
  risk: RiskLevel;
  capabilityId: string;
  preview: Record<string, unknown>;
  impact: string[];
  resumeHint: string;
  branch: ApprovalBranch;
}

/** 统一返回 envelope（FR-109） */
export interface ToolEnvelope<T = unknown> {
  traceId: string;
  ok: boolean;
  risk: RiskLevel;
  data?: T;
  artifacts?: Artifact[];
  auditRef?: string;
  durationMs?: number;
  approval?: ApprovalPayload;
  autoApproved?: boolean;
  effectState?: EffectState;
  backupStatus?: 'confirmed' | 'unconfirmed';
  error?: ToolError;
  analysis?: unknown;
  warnings?: string[];
}

export const RESUME_HINT =
  '确认后以 __approvalId 重发完全相同的请求（参数任何变化都会使审批作废）';

export interface SuccessInput<T> {
  traceId: string;
  risk: RiskLevel;
  data: T;
  auditRef?: string;
  durationMs?: number;
  artifacts?: Artifact[];
  autoApproved?: boolean;
  effectState?: EffectState;
  backupStatus?: 'confirmed' | 'unconfirmed';
  warnings?: string[];
}

export function successEnvelope<T>(input: SuccessInput<T>): ToolEnvelope<T> {
  const envelope: ToolEnvelope<T> = {
    traceId: input.traceId,
    ok: true,
    risk: input.risk,
    data: input.data,
  };
  if (input.auditRef !== undefined) envelope.auditRef = input.auditRef;
  if (input.durationMs !== undefined) envelope.durationMs = input.durationMs;
  if (input.artifacts !== undefined && input.artifacts.length > 0) envelope.artifacts = input.artifacts;
  if (input.autoApproved !== undefined) envelope.autoApproved = input.autoApproved;
  if (input.effectState !== undefined) envelope.effectState = input.effectState;
  if (input.backupStatus !== undefined) envelope.backupStatus = input.backupStatus;
  if (input.warnings !== undefined && input.warnings.length > 0) envelope.warnings = input.warnings;
  return envelope;
}

export interface FailureInput {
  traceId: string;
  risk: RiskLevel;
  error: ToolError;
  analysis?: unknown;
}

export function failureEnvelope(input: FailureInput): ToolEnvelope<never> {
  const envelope: ToolEnvelope<never> = {
    traceId: input.traceId,
    ok: false,
    risk: input.risk,
    error: input.error,
  };
  if (input.analysis !== undefined) envelope.analysis = input.analysis;
  return envelope;
}

export interface ApprovalInput {
  traceId: string;
  risk: RiskLevel;
  approval: ApprovalPayload;
  analysis?: unknown;
}

/** 审批请求：ok=false 但**不是**传输错误（isError:false） */
export function approvalEnvelope(input: ApprovalInput): ToolEnvelope<never> {
  const envelope: ToolEnvelope<never> = {
    traceId: input.traceId,
    ok: false,
    risk: input.risk,
    approval: input.approval,
    error: {
      code: 'APPROVAL_REQUIRED',
      message: `风险等级 ${input.risk} 需人工审批后执行`,
    },
  };
  if (input.analysis !== undefined) envelope.analysis = input.analysis;
  return envelope;
}