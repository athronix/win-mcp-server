/**
 * 最小 CDP 客户端（Node 22 内置 WebSocket，无第三方依赖）
 *
 * 为什么自研而不是内嵌 chrome-devtools-mcp：我们要的是"6 个 server 共享同一底座"的
 * 能力面，外部 MCP 无法接入我们的分级/审批/审计链。CDP 协议本身很小，
 * 只需要 Runtime/Page/Target/Input 四个域。
 *
 * 连接拓扑：browser 级 ws（/json/version）→ Target.attachToTarget(flatten) → sessionId。
 * flatten 模式下所有请求/事件都带 sessionId，一个 socket 管所有 tab。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * /json/list 里字段是 id，Target.getTargets 里是 targetId —— 两种来源都要能用，
 * 统一走 targetIdOf()，别在调用点各自猜。
 */
export interface CdpTarget {
  id?: string;
  targetId?: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export function targetIdOf(target: CdpTarget): string {
  return target.targetId ?? target.id ?? '';
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  sessionId?: string;
}

/** WebSocket 最小子集（便于测试注入假实现） */
export interface WebSocketLike {
  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (payload: never) => void): void;
  send(data: string): void;
  close(): void;
  readyState?: number;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export class CdpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

export class CdpClient {
  readonly #socket: WebSocketLike;
  readonly #pending = new Map<number, PendingCall>();
  readonly #listeners = new Map<string, ((params: Record<string, unknown>, sessionId?: string) => void)[]>();
  #nextId = 1;
  #closed = false;
  readonly #defaultTimeoutMs: number;

  constructor(socket: WebSocketLike, defaultTimeoutMs = 20_000) {
    this.#socket = socket;
    this.#defaultTimeoutMs = defaultTimeoutMs;
    socket.addEventListener('message', (payload: never) => {
      const event = payload as unknown as { data: string };
      this.#handle(event.data);
    });
    socket.addEventListener('close', () => {
      this.#closed = true;
      for (const [, call] of this.#pending) {
        clearTimeout(call.timer);
        call.reject(new CdpError('CDP_CLOSED', `连接已关闭，未完成调用：${call.method}`));
      }
      this.#pending.clear();
    });
    socket.addEventListener('error', () => {
      this.#closed = true;
    });
  }

  static async connect(
    wsUrl: string,
    options: { timeoutMs?: number; factory?: WebSocketFactory } = {},
  ): Promise<CdpClient> {
    const factory = options.factory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const socket = factory(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('CDP_TIMEOUT', `连接 ${wsUrl} 超时`)), options.timeoutMs ?? 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError('CDP_UNAVAILABLE', `无法连接 ${wsUrl}`));
      });
    });
    return new CdpClient(socket, options.timeoutMs ?? 20_000);
  }

  get closed(): boolean {
    return this.#closed;
  }

  on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): void {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new CdpError('CDP_CLOSED', `连接已关闭，无法发送 ${method}`));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError('CDP_TIMEOUT', `${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });

      const payload: CdpMessage = { id, method, params };
      if (options.sessionId !== undefined) payload.sessionId = options.sessionId;
      try {
        this.#socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError('CDP_SEND_FAILED', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  close(): void {
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      // 已断开
    }
  }

  #handle(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const call = this.#pending.get(message.id);
      if (call === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error !== undefined) {
        call.reject(new CdpError(`CDP_${message.error.code}`, `${call.method}: ${message.error.message}`));
        return;
      }
      call.resolve(message.result ?? {});
      return;
    }

    if (typeof message.method === 'string') {
      const listeners = this.#listeners.get(message.method);
      if (listeners === undefined) return;
      for (const listener of listeners) {
        try {
          listener(message.params ?? {}, message.sessionId);
        } catch {
          // 监听器异常不能影响协议循环
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DevTools 发现与浏览器启动
// ---------------------------------------------------------------------------
export function defaultUserDataDir(): string {
  return path.join(process.env['LOCALAPPDATA'] ?? os.tmpdir(), 'win-mcp', 'browser-profile');
}

/** 浏览器把实际端口写进 profile 目录的 DevToolsActivePort（第一行端口，第二行 ws 路径） */
export function readDevToolsActivePort(userDataDir: string): { port: number; wsPath: string } | null {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const port = Number(lines[0]);
    const wsPath = lines[1] ?? '';
    if (!Number.isInteger(port) || port <= 0) return null;
    return { port, wsPath };
  } catch {
    return null;
  }
}

export interface DevToolsVersion {
  Browser: string;
  webSocketDebuggerUrl: string;
  'Protocol-Version'?: string;
}

export async function fetchVersion(port: number, host = 'localhost'): Promise<DevToolsVersion> {
  const response = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new CdpError('CDP_UNAVAILABLE', `/json/version 返回 ${response.status}`);
  return (await response.json()) as DevToolsVersion;
}

export async function listTargets(port: number, host = 'localhost'): Promise<CdpTarget[]> {
  const response = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new CdpError('CDP_UNAVAILABLE', `/json/list 返回 ${response.status}`);
  return (await response.json()) as CdpTarget[];
}

export type BrowserKind = 'edge' | 'chrome' | 'chromium';

const BROWSER_PATHS: Record<BrowserKind, string[]> = {
  edge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  chromium: [],
};

export function detectBrowser(): { kind: BrowserKind; path: string } | null {
  for (const kind of ['edge', 'chrome'] as const) {
    for (const candidate of BROWSER_PATHS[kind]) {
      if (existsSync(candidate)) return { kind, path: candidate };
    }
  }
  return null;
}

export interface LaunchOptions {
  userDataDir?: string;
  port?: number;
  headless?: boolean;
  startUrl?: string;
  /** 额外参数（调用方可传 --proxy-server 等） */
  extraArgs?: string[];
}

export interface LaunchedBrowser {
  pid: number;
  port: number;
  wsUrl: string;
  browser: string;
  userDataDir: string;
}

/**
 * 启动一个**独立 profile** 的浏览器实例（不碰用户已登录的日常 profile）。
 * 端口用 0 让系统分配，再从 DevToolsActivePort 读回真实端口，避免固定端口冲突。
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const detected = detectBrowser();
  if (detected === null) throw new CdpError('PROVIDER_UNAVAILABLE', '未找到 Edge/Chrome 可执行文件');

  const userDataDir = options.userDataDir ?? defaultUserDataDir();
  mkdirSync(userDataDir, { recursive: true });
  const port = options.port ?? 0;

  // 上一轮残留的 DevToolsActivePort 会指向已退出的实例，先清掉再启动，
  // 否则会读到死端口（ECONNREFUSED）。
  const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
  if (existsSync(activePortFile)) {
    try {
      rmSync(activePortFile, { force: true });
    } catch {
      // 被占用就算了，后面还有 fetchVersion 校验
    }
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    // 显式开启可访问性相关能力，保证 CDP 里的 AX 信息可用
    '--force-renderer-accessibility',
  ];
  if (options.headless === true) args.push('--headless=new');
  if (options.extraArgs !== undefined) args.push(...options.extraArgs);
  args.push(options.startUrl ?? 'about:blank');

  const child = spawn(detected.path, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid ?? 0;

  // 等 DevToolsActivePort 出现**并且**端口真的可服务（最多 20s）。
  // 只等文件是不够的：文件先落盘、DevTools 端点后监听。
  const deadline = Date.now() + 20_000;
  let activePort: { port: number; wsPath: string } | null = null;
  let version: DevToolsVersion | null = null;
  let lastError = '';
  while (Date.now() < deadline) {
    const candidate = readDevToolsActivePort(userDataDir);
    if (candidate !== null) {
      activePort = candidate;
      try {
        version = await fetchVersion(candidate.port);
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (activePort === null) {
    throw new CdpError('CDP_UNAVAILABLE', `浏览器已启动（pid=${pid}）但 ${userDataDir}\\DevToolsActivePort 未出现`);
  }
  if (version === null) {
    throw new CdpError(
      'CDP_UNAVAILABLE',
      `浏览器已启动（pid=${pid}）但调试端口 ${activePort.port} 不可达：${lastError || 'fetch failed'}`,
    );
  }

  return {
    pid,
    port: activePort.port,
    wsUrl: version.webSocketDebuggerUrl,
    browser: version.Browser,
    userDataDir,
  };
}

/** 把调试端口写到 profile 旁的 json，供后续调用复用（避免每次重新启动） */
export function rememberEndpoint(endpoint: { port: number; wsUrl: string; browser: string; userDataDir: string }): string {
  const file = path.join(process.env['LOCALAPPDATA'] ?? os.tmpdir(), 'win-mcp', 'cdp-endpoint.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(endpoint, null, 2)}\n`, 'utf8');
  return file;
}

/** 回环主机名互换：DevTools 只监听 127.0.0.1，而本机 TUN 代理可能拦裸 IPv4 回环 */
export function swapLoopbackHost(wsUrl: string): string {
  if (wsUrl.includes('://127.0.0.1')) return wsUrl.replace('://127.0.0.1', '://localhost');
  if (wsUrl.includes('://localhost')) return wsUrl.replace('://localhost', '://127.0.0.1');
  return wsUrl;
}

/**
 * 连接 WebSocket 端点，两个回环主机名都试一次。
 *
 * 为什么不能只用一个：DevTools 只绑 127.0.0.1，`localhost` 在 ::1 优先解析时连不上；
 * 而本机 NekoBox TUN 又会拦裸 IPv4 回环。两个都试才不会因环境差异挂死。
 */
export async function connectEndpoint(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
  const candidates = [wsUrl, swapLoopbackHost(wsUrl)];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await CdpClient.connect(candidate, { timeoutMs });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new CdpError('CDP_UNAVAILABLE', `无法连接 ${wsUrl}`);
}

export function readRememberedEndpoint(): { port: number; wsUrl: string; browser: string } | null {
  const file = path.join(process.env['LOCALAPPDATA'] ?? os.tmpdir(), 'win-mcp', 'cdp-endpoint.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { port: number; wsUrl: string; browser: string };
  } catch {
    return null;
  }
}