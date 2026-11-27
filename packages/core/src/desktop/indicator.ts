import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 桌面控制视觉指示器（照 CursorTouch 的琥珀边缘指示器）
 *
 * 与同意对话框同构：独立进程 + 不共享 stdio，杀进程即消失。
 * 指示器是**纯装饰**：任何失败都只记一笔日志，绝不影响门控判定本身。
 */
export interface IndicatorHandle {
  pid: number;
}

export interface IndicatorController {
  show(seconds: number): IndicatorHandle | null;
  hide(): void;
  readonly active: boolean;
}

export interface IndicatorProcessLike {
  pid?: number;
  kill(signal?: string): boolean;
  unref?: () => void;
  on(event: 'error' | 'exit', listener: (...args: never[]) => void): void;
}

export type IndicatorSpawn = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => IndicatorProcessLike;

export interface SpawnIndicatorOptions {
  scriptPath?: string;
  command?: string;
  spawnImpl?: IndicatorSpawn;
  enabled?: boolean;
  onError?: (message: string) => void;
}

function defaultScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'ps', 'control-indicator.ps1');
}

export function createSpawnIndicator(options: SpawnIndicatorOptions = {}): IndicatorController {
  const scriptPath = options.scriptPath ?? defaultScriptPath();
  const command = options.command ?? 'pwsh';
  const spawnImpl = options.spawnImpl ?? (nodeSpawn as unknown as IndicatorSpawn);
  const enabled = options.enabled ?? process.env['WIN_MCP_DESKTOP_INDICATOR'] !== '0';
  const onError = options.onError ?? (() => undefined);

  let child: IndicatorProcessLike | undefined;

  const hide = (): void => {
    if (child === undefined) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出
    }
    child = undefined;
  };

  return {
    show(seconds: number): IndicatorHandle | null {
      if (!enabled) return null;
      hide();
      try {
        child = spawnImpl(
          command,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-Seconds',
            String(Math.max(1, Math.floor(seconds))),
          ],
          { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true },
        );
        const pid = child.pid ?? 0;
        child.on('error', (error: never) => {
          onError(`指示器启动失败：${String(error)}`);
          child = undefined;
        });
        if (typeof child.unref === 'function') child.unref();
        return pid > 0 ? { pid } : null;
      } catch (error) {
        onError(`指示器启动异常：${error instanceof Error ? error.message : String(error)}`);
        child = undefined;
        return null;
      }
    },

    hide,

    get active(): boolean {
      return child !== undefined;
    },
  };
}

/** 测试 / 无 UI 环境用 */
export function createNoopIndicator(): IndicatorController {
  return {
    show: () => null,
    hide: () => undefined,
    get active() {
      return false;
    },
  };
}