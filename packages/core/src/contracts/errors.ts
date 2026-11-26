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