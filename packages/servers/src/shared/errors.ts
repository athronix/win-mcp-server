import { ToolFailure, remoteErrorToToolError } from '@win-mcp/core';

/**
 * 把桥 / CDP 抛出的领域错误还原成带错误码的 ToolFailure。
 *
 * 不加这层的话，审批闸只能看到 message，错误码信息在 handler 边界就丢了
 * （统一折叠成 INTERNAL）。
 */
export function guard<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    throw ToolFailure.from(remoteErrorToToolError(error));
  });
}

/** 同步版本，用于 CDP 这类同步抛错的路径 */
export function guardSync<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw ToolFailure.from(remoteErrorToToolError(error));
  }
}