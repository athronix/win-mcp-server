import { ERROR_CODES, makeError, type ErrorCode, type ToolError } from '../contracts/errors.js';
import { BridgeError } from './bridge.js';

/**
 * 把桥的远端错误（BRIDGE_REMOTE + detail.code）还原为 ToolError。
 *
 * 背景：PowerShell 模块函数用 "CODE: message" 约定抛领域错误（STALE_REF / CONTROL_DENIED ...）。
 * 桥把它透传成 `{ code, message }`，这里负责映射回统一错误码；未知码降级为 fallback，
 * 保证"宁可报通用错误，也不把未知码塞进契约"。
 */
export function remoteErrorToToolError(error: unknown, fallback: ErrorCode = 'INTERNAL'): ToolError {
  if (error instanceof BridgeError) {
    if (error.code === 'TIMEOUT') {
      return makeError('TIMEOUT', error.message);
    }
    if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_EXITED' || error.code === 'BRIDGE_PROTOCOL') {
      return makeError('PROVIDER_UNAVAILABLE', error.message);
    }
    const detail = error.detail as { code?: unknown; message?: unknown } | undefined;
    if (detail !== undefined && typeof detail.code === 'string') {
      const code = detail.code;
      if ((ERROR_CODES as readonly string[]).includes(code)) {
        const message = typeof detail.message === 'string' ? detail.message : error.message;
        return makeError(code as ErrorCode, stripCodePrefix(message));
      }
      return makeError(fallback, stripCodePrefix(error.message), { remoteCode: code });
    }
    return makeError(fallback, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return makeError(fallback, message);
}

/** "STALE_REF: 元素已消失" → "元素已消失"（错误码已单独携带，不再重复前缀） */
export function stripCodePrefix(message: string): string {
  return message.replace(/^[A-Z][A-Z0-9_]{3,40}:\s*/, '');
}

/** 把任意 handler 异常转成 CapabilityResult 需要的 ToolError（供 server 侧统一 catch） */
export function toToolError(error: unknown): ToolError {
  return remoteErrorToToolError(error);
}