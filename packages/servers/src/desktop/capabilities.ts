import { z } from 'zod';
import type { CapabilitySpec, PowerShellBridge } from '@win-mcp/core';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** win-desktop：截图、窗口枚举与控制、剪贴板（无 UIA/输入注入，留后续 CL） */
export function desktopCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    bridge.call<T>('module', { module: 'desktop', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {});

  return [
    {
      id: 'desktop.screen.capture',
      name: '截屏',
      description:
        '截取所有显示器（虚拟屏幕）并保存为 PNG 到 %TEMP%，返回文件路径与尺寸；maxWidth 可按宽度等比缩小（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        maxWidth: z.number().int().min(320).max(7680).optional().describe('按宽度等比缩放，省略则原尺寸'),
      },
      async handler(params) {
        return {
          data: await call('Get-ScreenCapture', { MaxWidth: num(params.maxWidth, 0) }),
        };
      },
    },
    {
      id: 'desktop.window.list',
      name: '窗口列表',
      description: '列出可见且有标题的顶层窗口（句柄/标题/进程名），支持标题模糊过滤（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {
        filter: z.string().optional().describe('按窗口标题模糊过滤'),
        maxItems: z.number().int().min(1).max(500).optional().describe('最多返回条数，默认 100'),
      },
      async handler(params) {
        return {
          data: await call('Get-WindowList', {
            Filter: str(params.filter),
            MaxItems: num(params.maxItems, 100),
          }),
        };
      },
    },
    {
      id: 'desktop.window.control',
      name: '窗口控制',
      description:
        '对指定窗口执行 minimize/maximize/restore/activate/close（L2，需审批）。handle 来自 desktop.window.list。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 20_000,
      inputSchema: {
        handle: z.number().int().describe('窗口句柄（来自 desktop.window.list）'),
        action: z
          .enum(['minimize', 'maximize', 'restore', 'activate', 'close'])
          .describe('窗口操作'),
      },
      async handler(params) {
        return {
          data: await call('Set-WindowState', {
            Handle: num(params.handle, 0),
            Action: str(params.action),
          }),
        };
      },
    },
    {
      id: 'desktop.clipboard.get',
      name: '读剪贴板',
      description: '读取剪贴板文本（只读 L0）。非文本内容返回空字符串。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-ClipboardContent') };
      },
    },
    {
      id: 'desktop.clipboard.set',
      name: '写剪贴板',
      description: '写入剪贴板文本（L1，用户域可逆写）。会覆盖用户当前剪贴板内容。',
      risk: 'L1',
      inputSchema: {
        text: z.string().describe('要写入的文本（可为空字符串以清空）'),
      },
      async handler(params) {
        return { data: await call('Set-ClipboardContent', { Text: str(params.text) }) };
      },
    },
  ];
}
