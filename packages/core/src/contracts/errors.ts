/**
 * 统一错误码与错误工厂 — 对应 FR-109
 *
 * 语义约定：
 * - APPROVAL_REQUIRED 不是传输错误（isError:false），它表示"待用户确认，系统状态未改变"
 * - 其余错误码一律 isError:true
 */
export const ERROR_CODES = [
  'APPROVAL_REQUIRED',
  'APPROVAL_MISMATCH',
  'POLICY_DENIED',
  'ADMIN_REQUIRED',
  'PREFLIGHT_UNAVAILABLE',
  'PREFLIGHT_FAILED',
  'INVALID_SYNTAX',
  'COMMAND_BLOCKED',
  'STALE_REF',
  'AMBIGUOUS_TARGET',
  'CONTROL_DENIED',
  'USER_CONTROL',
  'PLAN_NOT_FOUND',
  'PLAN_EXPIRED',
  'PLAN_MISMATCH',
  'PLAN_BLOCKED',
  'BACKUP_NOT_FOUND',
  'NO_CHANGES',
  'TIMEOUT',
  'UNKNOWN_CAPABILITY',
  'INVALID_PARAMS',
  'PROVIDER_UNAVAILABLE',
  'EFFECT_UNKNOWN',
  'GUARD_ASSERTION_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function makeError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ToolError {
  return details === undefined ? { code, message } : { code, message, details };
}

export function isToolError(value: unknown): value is ToolError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === 'string'
  );
}

/**
 * 领域失败载体：handler 抛出它时，ToolGate 保留错误码而不是折叠成 INTERNAL。
 *
 * 为什么需要：桥会把 PowerShell 的 `STALE_REF: ...` 还原成结构化错误，如果 handler
 * 只 throw 普通 Error，审批闸只能看到 message，错误码信息就丢了。
 */
export class ToolFailure extends Error {
  readonly toolError: ToolError;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolFailure';
    this.toolError = makeError(code, message, details);
  }

  static from(error: ToolError): ToolFailure {
    return new ToolFailure(error.code, error.message, error.details);
  }
}

export function isToolFailure(value: unknown): value is ToolFailure {
  return (
    value instanceof ToolFailure ||
    (typeof value === 'object' && value !== null && isToolError((value as { toolError?: unknown }).toolError))
  );
}