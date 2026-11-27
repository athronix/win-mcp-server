import { z } from 'zod';
import type { CapabilitySpec, PowerShellBridge } from '@win-mcp/core';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** win-browser：书签读写（直接操作 Bookmarks JSON，不经 CDP）+ 打开 URL */
export function browserCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    bridge.call<T>('module', { module: 'browser', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {});

  return [
    {
      id: 'browser.profile.list',
      name: '浏览器配置文件',
      description:
        '列出本机 Chrome / Edge 的用户配置文件及其 Bookmarks 文件路径（只读 L0）。其它浏览器（Firefox 等）不支持。',
      risk: 'L0',
      idempotent: true,
      inputSchema: {},
      async handler() {
        return { data: await call('Get-BrowserProfiles') };
      },
    },
    {
      id: 'browser.bookmark.list',
      name: '书签列表',
      description:
        '读取指定配置的书签（书签栏/其它/移动端同步），返回扁平列表（id/名称/URL/所在文件夹），支持模糊过滤（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        profilePath: z.string().min(3).describe('配置目录绝对路径（来自 browser.profile.list）'),
        filter: z.string().optional().describe('按名称或 URL 模糊过滤'),
        maxItems: z.number().int().min(1).max(2000).optional().describe('最多返回条数，默认 500'),
      },
      async handler(params) {
        return {
          data: await call('Get-Bookmarks', {
            ProfilePath: str(params.profilePath),
            Filter: str(params.filter),
            MaxItems: num(params.maxItems, 500),
          }),
        };
      },
    },
    {
      id: 'browser.bookmark.add',
      name: '添加书签',
      description:
        '向书签栏添加一个书签（L2，需审批；写入前自动备份到 %LOCALAPPDATA%\\win-mcp\\backups）。必须先关闭浏览器，否则浏览器退出时会覆盖该文件。',
      risk: 'L2',
      destructive: true,
      snapshot: 'before',
      timeoutMs: 30_000,
      inputSchema: {
        profilePath: z.string().min(3).describe('配置目录绝对路径'),
        name: z.string().min(1).describe('书签名称'),
        url: z.string().url().describe('书签 URL（需含协议）'),
      },
      async handler(params) {
        const result = await call<{ backupPath?: string }>('Add-Bookmark', {
          ProfilePath: str(params.profilePath),
          Name: str(params.name),
          Url: str(params.url),
        });
        return {
          data: result,
          ...(result.backupPath !== undefined ? { warnings: [`原文件已备份：${result.backupPath}`] } : {}),
        };
      },
    },
    {
      id: 'browser.bookmark.delete',
      name: '删除书签',
      description:
        '按 id 或 url 删除书签（L2，需审批；写入前自动备份）。两者都传时任一命中即删除，返回删除数量。',
      risk: 'L2',
      destructive: true,
      snapshot: 'before',
      timeoutMs: 30_000,
      inputSchema: {
        profilePath: z.string().min(3).describe('配置目录绝对路径'),
        id: z.string().optional().describe('书签 id'),
        url: z.string().optional().describe('书签 URL'),
      },
      async handler(params) {
        return {
          data: await call('Remove-Bookmark', {
            ProfilePath: str(params.profilePath),
            Id: str(params.id),
            Url: str(params.url),
          }),
        };
      },
    },
    {
      id: 'browser.url.open',
      name: '打开网页',
      description: '用默认浏览器打开 http/https URL（L1）。会新开标签页，不改变现有书签。',
      risk: 'L1',
      inputSchema: {
        url: z.string().url().describe('http/https URL'),
      },
      async handler(params) {
        return { data: await call('Open-Url', { Url: str(params.url) }) };
      },
    },
  ];
}