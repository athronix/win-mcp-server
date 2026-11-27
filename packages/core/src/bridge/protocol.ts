/**
 * 桥协议编解码（NDJSON）— CL-002
 * 契约见 docs/02-design/TECHNICAL-SOLUTION-bridge.md §3
 */
export interface BridgeRequest {
  id: string;
  op: string;
  params: Record<string, unknown>;
}

export interface BridgeOkResponse {
  id: string;
  ok: true;
  data: unknown;
  durationMs?: number;
}

export interface BridgeFailResponse {
  id: string | null;
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type BridgeResponse = BridgeOkResponse | BridgeFailResponse;

export function encodeRequest(request: BridgeRequest): string {
  return `${JSON.stringify(request)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析一行响应。任何非协议内容（启动横幅、空行、半行 JSON）都返回 undefined，
 * 由调用方忽略——绝不让脏输入打断请求队列。
 */
export function parseResponseLine(line: string): BridgeResponse | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const rawId = parsed.id;
  if (typeof rawId !== 'string' && rawId !== null) return undefined;

  if (parsed.ok === true) {
    if (typeof rawId !== 'string') return undefined;
    const response: BridgeOkResponse = {
      id: rawId,
      ok: true,
      data: parsed.data,
    };
    if (typeof parsed.durationMs === 'number') response.durationMs = parsed.durationMs;
    return response;
  }

  if (parsed.ok === false) {
    const error = parsed.error;
    if (!isRecord(error)) return undefined;
    if (typeof error.code !== 'string' || typeof error.message !== 'string') return undefined;
    const fail: BridgeFailResponse = {
      id: rawId,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    };
    return fail;
  }

  return undefined;
}