import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 倒计时同意对话框（照 CursorTouch control_consent 的"独立进程 + 退出码协议"）
 *
 * 为什么必须是独立进程：
 * 1. GUI 消息循环需要自己的线程，不能被 MCP server 的 stdio 主循环拖住；
 * 2. 对话框崩溃/挂起不得影响 server；
 * 3. 答案走退出码，绝不污染 stdout 的协议流。
 *
 * 与上游的差异（明确记录）：上游"倒计时无应答 → 自动开始控制"，本项目"无应答 → 自动允许"，
 * 但**对话框本身挂起/崩溃 → 拒绝**（fail closed）。上游把挂起也当超时允许，那等于给了
 * 一个"弄挂对话框即可获得控制权"的旁路。
 */
export type ConsentAnswer = 'allow' | 'deny' | 'timeout' | 'unavailable';

export interface ConsentRequest {
  seconds: number;
  title: string;
  message: string;
  agentName?: string;
}

export interface ConsentRunner {
  ask(request: ConsentRequest): Promise<ConsentAnswer>;
}

export interface ConsentProcessLike {
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: string): boolean;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  unref?: () => void;
}

export type ConsentSpawn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ConsentProcessLike;

export interface SpawnConsentOptions {
  /** 覆盖脚本路径（测试用） */
  scriptPath?: string;
  /** 覆盖解释器（默认 pwsh，回退 powershell） */
  command?: string;
  spawnImpl?: ConsentSpawn;
  /** 对话框最长存活时间（秒数 + 该余量），超时按 unavailable 处理 */
  graceSeconds?: number;
}

const EXIT_ALLOW = 10;
const EXIT_DENY = 11;
const EXIT_TIMEOUT = 12;
const EXIT_UNAVAILABLE = 13;

function defaultScriptPath(): string {
  // dist/desktop/consent.js -> ../../ps/consent-dialog.ps1
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'ps', 'consent-dialog.ps1');
}

export function mapExitCode(code: number | null): ConsentAnswer {
  switch (code) {
    case EXIT_ALLOW:
      return 'allow';
    case EXIT_DENY:
      return 'deny';
    case EXIT_TIMEOUT:
      return 'timeout';
    case EXIT_UNAVAILABLE:
      return 'unavailable';
    default:
      return 'unavailable';
  }
}

export function createSpawnConsentRunner(options: SpawnConsentOptions = {}): ConsentRunner {
  const scriptPath = options.scriptPath ?? defaultScriptPath();
  const command = options.command ?? 'pwsh';
  const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as ConsentSpawn);
  const graceSeconds = options.graceSeconds ?? 15;

  return {
    ask(request: ConsentRequest): Promise<ConsentAnswer> {
      // 0 秒 = 不打断用户，直接放行（无人值守场景）
      if (request.seconds <= 0) return Promise.resolve('allow');

      const args = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Seconds',
        String(Math.floor(request.seconds)),
        '-Title',
        request.title,
        '-Message',
        request.message,
        '-AgentName',
        request.agentName ?? 'win-mcp',
      ];

      return new Promise<ConsentAnswer>((resolve) => {
        let settled = false;
        // Declared before `finish` because the spawn-failure path settles the promise
        // before the watchdog timer exists.
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (answer: ConsentAnswer): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(answer);
        };

        let child: ConsentProcessLike;
        try {
          child = spawnImpl(command, args, {
            // 三个标准流都不共享：绝不能碰到 server 的 stdio 管道
            stdio: ['ignore', 'ignore', 'ignore'],
            windowsHide: false,
            detached: false,
          });
        } catch {
          finish('unavailable');
          return;
        }

        timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // 进程可能已退出
          }
          finish('unavailable');
        }, (request.seconds + graceSeconds) * 1000);
        if (typeof timer.unref === 'function') timer.unref();

        child.on('error', () => finish('unavailable'));
        child.on('exit', (code: number | null) => finish(mapExitCode(code)));
      });
    },
  };
}

/** 测试/无人值守用：不做任何交互，固定返回 allow */
export function createFixedConsentRunner(answer: ConsentAnswer): ConsentRunner {
  return { ask: () => Promise.resolve(answer) };
}