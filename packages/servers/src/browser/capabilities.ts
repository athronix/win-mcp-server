import { z } from 'zod';
import { ToolFailure, type CapabilitySpec, type PowerShellBridge } from '@win-mcp/core';
import { guard } from '../shared/errors.js';
import { CdpRuntime } from './runtime.js';

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * win-browser：书签读写（直接操作 Bookmarks JSON）+ 打开 URL + CDP 通道
 *
 * CDP 通道是 Chromium/Electron 的正解：UIA 拿不到的语义树，DOM 一定有。
 * 默认启动**独立 profile**（%LOCALAPPDATA%\win-mcp\browser-profile），不碰用户日常登录态。
 */
export function browserCapabilities(bridge: PowerShellBridge): CapabilitySpec[] {
  const call = <T>(fn: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    bridge.call<T>('module', { module: 'browser', function: fn, args }, timeoutMs !== undefined ? { timeoutMs } : {});

  const cdp = new CdpRuntime();

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
    // ---------------- CL-012: CDP 通道 ----------------
    {
      id: 'browser.cdp.status',
      name: 'CDP 连接状态',
      description:
        '查询调试实例是否在线、浏览器版本、可操作 target 列表与当前是否已附着页面（只读 L0）。' +
        '返回 hint 说明下一步该做什么。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 20_000,
      inputSchema: {},
      async handler() {
        return { data: await guard(cdp.status()) };
      },
    },
    {
      id: 'browser.cdp.launch',
      name: '启动调试浏览器',
      description:
        '用独立 profile 启动 Edge/Chrome 并开放 CDP（L2 需审批）。端口由系统分配后从 DevToolsActivePort 读回，避免端口冲突。' +
        '独立 profile 意味着没有你的登录态与扩展；要用日常 profile 需先彻底退出浏览器，再用 attach 方式（本版本未提供，属已知边界）。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 60_000,
      inputSchema: {
        startUrl: z.string().optional().describe('启动后打开的地址，默认 about:blank'),
        headless: z.boolean().optional().describe('是否无头启动，默认 false（有头便于用户观察）'),
        userDataDir: z.string().optional().describe('自定义 profile 目录，默认 %LOCALAPPDATA%\\win-mcp\\browser-profile'),
      },
      async handler(params) {
        return {
          data: await guard(
            cdp.launch({
              ...(typeof params.startUrl === 'string' ? { startUrl: params.startUrl } : {}),
              headless: params.headless === true,
              ...(typeof params.userDataDir === 'string' ? { userDataDir: params.userDataDir } : {}),
            }),
          ),
        };
      },
    },
    {
      id: 'browser.cdp.attach',
      name: '附着到已有调试端口',
      description:
        '连接到用户自己启动的调试实例（--remote-debugging-port），从而复用真实登录态与本机 profile（L1）。' +
        '前提：日常浏览器必须**先彻底退出**——已有实例在跑时新进程会忽略调试参数。' +
        '失败返回 PROVIDER_UNAVAILABLE 并给出排查提示。',
      risk: 'L1',
      timeoutMs: 20_000,
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe('浏览器已开放的 DevTools 端口，如 9222'),
      },
      async handler(params) {
        return { data: await guard(cdp.attach(Number(params.port ?? 0))) };
      },
    },
    {
      id: 'browser.cdp.navigate',
      name: '导航',
      description:
        '让当前页面导航到指定 URL 并等待 load（L2 需审批）。load 超时不等于失败：SPA 可能仍在加载，' +
        '应接着 snapshot 观察实际状态，不要盲目重试导航。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 60_000,
      inputSchema: {
        url: z.string().describe('目标地址（http/https 或 about:blank）'),
      },
      async handler(params) {
        const url = str(params.url);
        const page = await guard(cdp.ensure());
        return { data: await guard(page.navigate(url)) };
      },
    },
    {
      id: 'browser.cdp.snapshot',
      name: 'DOM 语义快照',
      description:
        '把当前页面折叠成带 ref 的语义节点列表（role/name/value/states/actions/bounds）。ref 形如 @b3:e12，' +
        '只在本次快照内有效；导航或 DOM 重建后必须重新快照。只读 L1。',
      risk: 'L1',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {
        maxNodes: z.number().int().min(20).max(3000).optional().describe('最多节点数，默认 600'),
        maxDepth: z.number().int().min(1).max(40).optional().describe('最大语义深度，默认 12'),
      },
      async handler(params) {
        const page = await guard(cdp.ensure());
        return {
          data: await guard(
            page.snapshot({
              ...(typeof params.maxNodes === 'number' ? { maxNodes: params.maxNodes } : {}),
              ...(typeof params.maxDepth === 'number' ? { maxDepth: params.maxDepth } : {}),
            }),
          ),
        };
      },
    },
    {
      id: 'browser.cdp.act',
      name: '按 ref 操作页面元素',
      description:
        '对快照 ref 执行 click/setValue/focus/scrollIntoView/getText/selectOption/submit（L2 需审批）。' +
        'expect 是动作前的字面断言（≤16 条）：页面已变就 fail 而不是照着旧 ref 乱点。' +
        '结果带 via 说明用了哪条路径（element.click / value-setter ...）。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 40_000,
      inputSchema: {
        ref: z.string().describe('元素 ref（@b<snapshot>:e<N>）'),
        action: z.enum(['click', 'setValue', 'focus', 'scrollIntoView', 'getText', 'selectOption', 'submit']).describe('动作'),
        text: z.string().optional().describe('setValue/selectOption 的值'),
        expect: z
          .array(
            z.object({
              ref: z.string().describe('断言的元素 ref'),
              exists: z.boolean().optional(),
              text: z.string().optional(),
              value: z.string().optional(),
              checked: z.boolean().optional(),
              attribute: z.object({ name: z.string(), value: z.string() }).optional(),
            }),
          )
          .max(16)
          .optional()
          .describe('动作前的字面断言，任何一条不满足即失败'),
      },
      async handler(params) {
        const page = await guard(cdp.ensure());
        const expect = Array.isArray(params.expect) ? (params.expect as never[]) : undefined;
        return {
          data: await guard(
            page.act(str(params.ref), str(params.action) as never, {
              text: str(params.text),
              ...(expect !== undefined ? { expect } : {}),
            }),
          ),
        };
      },
    },
    {
      id: 'browser.cdp.wait',
      name: '等待页面条件',
      description:
        '在页面内等待条件成立（selector / 文本 / URL 片段），服务端阻塞到超时（L1）。' +
        '比调用方反复快照便宜得多：一次调用完成等待，并在命中后附带一份新快照（ref 可直接用）。' +
        '超时抛 TIMEOUT，不代表页面坏了，先快照看实际状态再决定是否重试。',
      risk: 'L1',
      timeoutMs: 70_000,
      inputSchema: {
        selector: z.string().optional().describe('CSS 选择器，如 #result 或 button[type=submit]'),
        text: z.string().optional().describe('页面 body 文本包含该字符串'),
        urlContains: z.string().optional().describe('location.href 包含该片段'),
        timeoutMs: z.number().int().min(200).max(60000).optional().describe('最长等待，默认 10000'),
        pollMs: z.number().int().min(100).max(2000).optional().describe('轮询间隔，默认 250'),
        withSnapshot: z.boolean().optional().describe('命中后是否附带新快照，默认 true'),
      },
      async handler(params) {
        const page = await guard(cdp.ensure());
        const result = await guard(
          page.wait({
            ...(typeof params.selector === 'string' ? { selector: params.selector } : {}),
            ...(typeof params.text === 'string' ? { text: params.text } : {}),
            ...(typeof params.urlContains === 'string' ? { urlContains: params.urlContains } : {}),
            ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
            ...(typeof params.pollMs === 'number' ? { pollMs: params.pollMs } : {}),
          }),
        );
        if (!result.matched) {
          throw new ToolFailure('TIMEOUT', `等待 ${result.waitedMs}ms 未满足条件；先 browser.cdp.snapshot 看实际状态`);
        }
        const withSnapshot = params.withSnapshot !== false;
        const data: Record<string, unknown> = { ...result };
        if (withSnapshot) {
          data['snapshot'] = await guard(page.snapshot({ maxNodes: 400 }));
        }
        return { data };
      },
    },
    {
      id: 'browser.cdp.screenshot',
      name: '页面截图',
      description: '截取当前视口为 PNG 存到 %TEMP%，返回路径与字节数（只读 L0）。',
      risk: 'L0',
      idempotent: true,
      timeoutMs: 30_000,
      inputSchema: {},
      async handler() {
        const page = await guard(cdp.ensure());
        return { data: await guard(page.screenshot()) };
      },
    },
    {
      id: 'browser.cdp.tabs',
      name: '标签页管理',
      description:
        '列出/切换/新建标签页（L1）。close 需要单独用 browser.cdp.tab.close（L2）。' +
        '切换后当前操作页随之改变，之前的 ref 全部失效。',
      risk: 'L1',
      timeoutMs: 30_000,
      inputSchema: {
        action: z.enum(['list', 'activate', 'open', 'attach']).describe('操作'),
        targetId: z.string().optional().describe('activate/attach 的目标 id'),
        url: z.string().optional().describe('open 的地址，默认 about:blank'),
      },
      async handler(params) {
        const action = str(params.action, 'list');
        if (action === 'list') {
          return { data: { action, targets: await guard(cdp.targets()) } };
        }
        if (action === 'activate') {
          await guard(cdp.activateTab(str(params.targetId)));
          return { data: { action, targetId: str(params.targetId), activated: true } };
        }
        if (action === 'open') {
          const opened = await guard(cdp.openTab(str(params.url, 'about:blank')));
          return { data: { action, ...opened } };
        }
        const page = await guard(cdp.attachTab(str(params.targetId)));
        return { data: { action: 'attach', targetId: page.targetId, url: page.url } };
      },
    },
    {
      id: 'browser.tab.close',
      name: '关闭标签页',
      description: '关闭指定标签页（L2 需审批）。关闭当前操作页后需要重新 attach 才能继续。',
      risk: 'L2',
      destructive: true,
      timeoutMs: 20_000,
      inputSchema: {
        targetId: z.string().describe('要关闭的 target id'),
      },
      async handler(params) {
        await guard(cdp.closeTab(str(params.targetId)));
        return { data: { closed: true, targetId: str(params.targetId) } };
      },
    },
    {
      id: 'browser.cdp.eval',
      name: '执行页面脚本',
      description:
        '在页面上下文执行任意 JS 并取回返回值（L3 强制人工审批）。这是最高危的浏览器能力：' +
        '脚本能读 cookie、发请求、改页面。仅供确有需要的场景，优先用 action 类能力。',
      risk: 'L3',
      destructive: true,
      timeoutMs: 40_000,
      inputSchema: {
        expression: z.string().min(1).describe('要执行的 JS 表达式（返回值需可序列化）'),
      },
      async handler(params) {
        const page = await guard(cdp.ensure());
        return { data: await guard(page.evaluate<unknown>(str(params.expression))) };
      },
    },
  ];
}