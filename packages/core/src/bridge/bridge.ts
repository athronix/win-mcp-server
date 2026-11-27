import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { encodeRequest, parseResponseLine } from './protocol.js';

export interface BridgeInfo {
  version: string;
  edition: string;
  elevated: boolean;
  pid: number;
  executable: string;
  platform: string;
}

export type BridgeErrorCode =
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_EXITED'
  | 'TIMEOUT'
  | 'BRIDGE_PROTOCOL'
  | 'BRIDGE_REMOTE';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly detail?: unknown;

  constructor(code: BridgeErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 只依赖 ChildProcess 的最小子集，便于测试注入假进程 */
export interface ChildProcessLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  pid?: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): boolean;
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessLike;

export interface BridgeOptions {
  executable?: string;
  scriptPath?: string;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  maxRestarts?: number;
  cwd?: string;
  env?: Record<string, string>;
  onDiagnostic?: (line: string) => void;
  spawnImpl?: SpawnImpl;
}

export interface BridgeStatus {
  running: boolean;
  info?: BridgeInfo;
  pending: number;
  restarts: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL('../../ps/ps-bridge.ps1', import.meta.url));
const DEFAULT_CANDIDATES = ['pwsh', 'powershell'] as const;

function asSpawnImpl(spawnImpl: SpawnImpl | undefined): SpawnImpl {
  if (spawnImpl !== undefined) return spawnImpl;
  return (command, args, options) =>
    spawn(command, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as ChildProcessLike;
}

/**
 * PowerShell 常驻桥（CL-002）
 * - NDJSON over stdio，按 id 匹配请求/响应
 * - 单请求超时；桥退出时所有 pending 立即失败
 * - 非主动 stop 的退出按退避自动重启（默认最多 2 次）
 * - 可执行文件回退：pwsh → powershell
 */
export class PowerShellBridge {
  readonly #spawnImpl: SpawnImpl;
  readonly #scriptPath: string;
  readonly #executable: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #maxRestarts: number;
  readonly #cwd: string | undefined;
  readonly #env: Record<string, string>;
  readonly #onDiagnostic: ((line: string) => void) | undefined;

  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessLike | undefined;
  #running = false;
  #stopping = false;
  #restarts = 0;
  #counter = 0;
  #info: BridgeInfo | undefined;
  #restartTimer: NodeJS.Timeout | undefined;

  constructor(opts: BridgeOptions = {}) {
    this.#spawnImpl = asSpawnImpl(opts.spawnImpl);
    this.#scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.#executable = opts.executable;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.#startTimeoutMs = opts.startTimeoutMs ?? 15_000;
    this.#maxRestarts = opts.maxRestarts ?? 2;
    this.#cwd = opts.cwd;
    this.#env = opts.env ?? {};
    this.#onDiagnostic = opts.onDiagnostic;
  }

  get status(): BridgeStatus {
    return {
      running: this.#running,
      ...(this.#info !== undefined ? { info: this.#info } : {}),
      pending: this.#pending.size,
      restarts: this.#restarts,
    };
  }

  get info(): BridgeInfo | undefined {
    return this.#info;
  }

  async start(): Promise<BridgeInfo> {
    if (this.#child !== undefined && this.#running && this.#info !== undefined) {
      return this.#info;
    }
    this.#stopping = false;
    const candidates = this.#executable !== undefined ? [this.#executable] : [...DEFAULT_CANDIDATES];
    const failures: string[] = [];

    for (const executable of candidates) {
      try {
        const child = this.#spawnImpl(executable, this.#buildArgs(), {
          ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
          env: { ...process.env, ...this.#env },
        });
        if (child.stdout === null || child.stdin === null) {
          throw new BridgeError('BRIDGE_PROTOCOL', '子进程缺少 stdio 管道');
        }
        this.#child = child;
        this.#running = true;
        this.#attach(child);
        await this.call('ping', {}, { timeoutMs: this.#startTimeoutMs });
        const info = await this.call<BridgeInfo>('info', {}, { timeoutMs: this.#startTimeoutMs });
        this.#info = {
          ...info,
          executable: info.executable.length > 0 ? info.executable : executable,
        };
        return this.#info;
      } catch (error) {
        failures.push(`${executable}: ${error instanceof Error ? error.message : String(error)}`);
        this.#detachChild();
      }
    }

    this.#stopping = true;
    throw new BridgeError(
      'BRIDGE_UNAVAILABLE',
      `无法启动 PowerShell 桥（${failures.join(' | ')}）`,
      { failures },
    );
  }

  async call<T = unknown>(
    op: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const child = this.#child;
    if (child === undefined || !this.#running) {
      throw new BridgeError('BRIDGE_UNAVAILABLE', 'PowerShell 桥未启动');
    }
    const timeoutMs = opts.timeoutMs ?? this.#requestTimeoutMs;
    const id = `req_${(this.#counter += 1)}`;
    const line = encodeRequest({ id, op, params });

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError('TIMEOUT', `桥请求超时（op=${op}, ${timeoutMs}ms）`, { op, id }));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });

      try {
        child.stdin?.write(line);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          new BridgeError(
            'BRIDGE_PROTOCOL',
            `写入桥失败：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const child = this.#child;
    this.#child = undefined;
    this.#running = false;
    this.#info = undefined;
    this.#failPending(new BridgeError('BRIDGE_EXITED', '桥已关闭'));
    if (child === undefined) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略：进程可能已退出
        }
        finish();
      }, 2000);
      timer.unref?.();
      child.on('exit', () => {
        clearTimeout(timer);
        finish();
      });
      try {
        child.stdin?.end();
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }

  #buildArgs(): string[] {
    return [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.#scriptPath,
    ];
  }

  #attach(child: ChildProcessLike): void {
    if (child.stdout !== null) {
      const stdout = createInterface({ input: child.stdout });
      stdout.on('line', (line: string) => this.#handleLine(line));
    }
    if (child.stderr !== null) {
      const stderr = createInterface({ input: child.stderr });
      stderr.on('line', (line: string) => this.#diagnose(line));
    }
    child.on('exit', (...args: unknown[]) => {
      // 只处理当前子进程的退出；主动 detach 的旧进程忽略
      if (this.#child !== child) return;
      const code = typeof args[0] === 'number' ? args[0] : null;
      this.#handleExit(code);
    });
    child.on('error', (error: unknown) => {
      this.#diagnose(`[bridge:error] ${String(error)}`);
    });
  }

  #handleLine(line: string): void {
    const response = parseResponseLine(line);
    if (response === undefined) {
      if (line.trim().length > 0) this.#diagnose(`[bridge:non-protocol] ${line}`);
      return;
    }

    if (!response.ok) {
      // id 为 null 表示服务端无法定位请求（如请求 JSON 非法），只能记诊断
      if (response.id === null) {
        this.#diagnose(`[bridge:error] ${response.error.code}: ${response.error.message}`);
        return;
      }
      const failed = this.#takePending(response.id);
      if (failed === undefined) return;
      failed.reject(
        new BridgeError(
          'BRIDGE_REMOTE',
          `${response.error.code}: ${response.error.message}`,
          response.error,
        ),
      );
      return;
    }

    const pending = this.#takePending(response.id);
    if (pending === undefined) return; // 迟到/重复响应，丢弃
    pending.resolve(response.data);
  }

  #takePending(id: string): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  #handleExit(code: number | null): void {
    this.#child = undefined;
    this.#running = false;
    this.#info = undefined;
    this.#failPending(
      new BridgeError('BRIDGE_EXITED', `PowerShell 桥已退出（code=${code ?? 'null'}）`, { code }),
    );
    if (this.#stopping) return;
    if (this.#restarts >= this.#maxRestarts) {
      this.#diagnose(`[bridge] 已达重启上限（${this.#maxRestarts}），不再重启`);
      return;
    }
    this.#restarts += 1;
    const delayMs = 200 * this.#restarts;
    this.#diagnose(`[bridge] ${delayMs}ms 后第 ${this.#restarts} 次重启`);
    this.#restartTimer = setTimeout(() => {
      void this.start().catch((error: unknown) => {
        this.#diagnose(`[bridge] 重启失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs);
    this.#restartTimer.unref?.();
  }

  #detachChild(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#running = false;
    this.#info = undefined;
    this.#failPending(new BridgeError('BRIDGE_EXITED', '桥已断开'));
    if (child !== undefined) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 忽略
      }
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #diagnose(line: string): void {
    this.#onDiagnostic?.(line);
  }
}