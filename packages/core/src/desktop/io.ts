import type { PowerShellBridge } from '../bridge/bridge.js';
import { isControlPolicy, type ControlPolicy } from './control-policy.js';
import type { ControlIo, DesktopControlState, ForegroundWindowInfo } from './gate.js';

interface RawControlState {
  policy?: unknown;
  idleMs?: unknown;
  interactive?: unknown;
  foreground?: unknown;
  cursor?: unknown;
}

function toPolicy(value: unknown): ControlPolicy {
  return isControlPolicy(value) ? value : 'balanced';
}

function toForeground(value: unknown): ForegroundWindowInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { handle?: unknown; title?: unknown; processId?: unknown };
  if (typeof candidate.handle !== 'number') return null;
  return {
    handle: candidate.handle,
    title: typeof candidate.title === 'string' ? candidate.title : '',
    processId: typeof candidate.processId === 'number' ? candidate.processId : 0,
  };
}

/** 用 PowerShell 桥读/写桌面门控状态；policy 持久化到 %LOCALAPPDATA%\win-mcp\desktop-control.json */
export function createBridgeControlIo(bridge: PowerShellBridge): ControlIo {
  return {
    async readState(): Promise<DesktopControlState> {
      const raw = await bridge.call<RawControlState>('module', {
        module: 'desktop',
        function: 'Get-ControlState',
        args: {},
      });
      const cursor = raw.cursor as { x?: unknown; y?: unknown } | undefined;
      return {
        policy: toPolicy(raw.policy),
        idleMs: typeof raw.idleMs === 'number' ? raw.idleMs : -1,
        interactive: raw.interactive !== false,
        foreground: toForeground(raw.foreground),
        ...(typeof cursor?.x === 'number' && typeof cursor?.y === 'number'
          ? { cursor: { x: cursor.x, y: cursor.y } }
          : {}),
      };
    },

    async writePolicy(policy: ControlPolicy): Promise<{ previous: string; policy: string }> {
      const raw = await bridge.call<{ previous?: unknown; policy?: unknown }>('module', {
        module: 'desktop',
        function: 'Set-ControlPolicy',
        args: { Policy: policy },
      });
      return {
        previous: typeof raw.previous === 'string' ? raw.previous : 'unknown',
        policy: typeof raw.policy === 'string' ? raw.policy : policy,
      };
    },
  };
}