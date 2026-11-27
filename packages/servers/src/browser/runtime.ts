/**
 * CDP 运行时：连接复用 + 页面附着 + 多 tab 管理
 *
 * 一个 server 进程内只保一条 browser 级 WebSocket，页面用 flatten session 复用同一条连接。
 */
import {
  CdpClient,
  CdpError,
  fetchVersion,
  launchBrowser,
  listTargets,
  connectEndpoint,
  readRememberedEndpoint,
  rememberEndpoint,
  targetIdOf,
  type CdpTarget,
  type LaunchOptions,
} from './cdp.js';
import { PageController, pickPageTarget } from './page.js';

export interface CdpStatus {
  connected: boolean;
  browser: string | null;
  port: number | null;
  targets: { id: string; type: string; title: string; url: string }[];
  attached: boolean;
  hint?: string;
}

export class CdpRuntime {
  #client: CdpClient | undefined;
  #page: PageController | undefined;
  #endpoint: { port: number; wsUrl: string; browser: string } | undefined;
  readonly #connectTimeoutMs: number;

  constructor(options: { connectTimeoutMs?: number } = {}) {
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  async status(): Promise<CdpStatus> {
    const remembered = this.#endpoint ?? readRememberedEndpoint();
    if (remembered === null) {
      return {
        connected: false,
        browser: null,
        port: null,
        targets: [],
        attached: this.#page !== undefined,
        hint: '尚未启动调试实例：先用 browser.cdp.launch（独立 profile，不影响日常浏览器）',
      };
    }

    try {
      const version = await fetchVersion(remembered.port);
      const targets = await listTargets(remembered.port);
      return {
        connected: true,
        browser: version.Browser,
        port: remembered.port,
        targets: targets.map((target) => ({
          id: targetIdOf(target),
          type: target.type,
          title: target.title,
          url: target.url,
        })),
        attached: this.#page !== undefined && this.#client !== undefined && !this.#client.closed,
      };
    } catch (error) {
      return {
        connected: false,
        browser: remembered.browser,
        port: remembered.port,
        targets: [],
        attached: false,
        hint: `调试端口 ${remembered.port} 不可达（${error instanceof Error ? error.message : String(error)}）；可能浏览器已退出，请重新 browser.cdp.launch`,
      };
    }
  }

  async launch(options: LaunchOptions = {}): Promise<Record<string, unknown>> {
    const launched = await launchBrowser(options);
    const file = rememberEndpoint({
      port: launched.port,
      wsUrl: launched.wsUrl,
      browser: launched.browser,
      userDataDir: launched.userDataDir,
    });
    // 新实例：丢掉旧连接，下一次 ensure 重新附着
    this.#client?.close();
    this.#client = undefined;
    this.#page = undefined;
    this.#endpoint = { port: launched.port, wsUrl: launched.wsUrl, browser: launched.browser };
    return { ...launched, endpointFile: file };
  }

  async ensure(): Promise<PageController> {
    if (this.#page !== undefined && this.#client !== undefined && !this.#client.closed) {
      return this.#page;
    }

    const remembered = this.#endpoint ?? readRememberedEndpoint();
    if (remembered === null) {
      throw new CdpError(
        'PROVIDER_UNAVAILABLE',
        '没有可用的 CDP 端点：先调用 browser.cdp.launch 启动独立调试实例',
      );
    }

    let client: CdpClient;
    try {
      client = await connectEndpoint(remembered.wsUrl, this.#connectTimeoutMs);
    } catch (error) {
      throw new CdpError(
        'PROVIDER_UNAVAILABLE',
        `连接 CDP 失败（${error instanceof Error ? error.message : String(error)}）；端口 ${remembered.port} 可能已失效，请重新 browser.cdp.launch`,
      );
    }

    const listed = await client.send<{ targetInfos: CdpTarget[] }>('Target.getTargets');
    let target = pickPageTarget(listed.targetInfos);
    if (target === null) {
      const created = await client.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      const refreshed = await client.send<{ targetInfos: CdpTarget[] }>('Target.getTargets');
      target =
        refreshed.targetInfos.find((item) => targetIdOf(item) === created.targetId) ??
        pickPageTarget(refreshed.targetInfos);
      if (target === null) {
        client.close();
        throw new CdpError('PROVIDER_UNAVAILABLE', '无法创建或找到页面 target');
      }
    }

    const page = await PageController.attach(client, targetIdOf(target));
    this.#client = client;
    this.#page = page;
    this.#endpoint = remembered;
    return page;
  }

  /**
   * 附着到已在监听调试端口的浏览器（用户自己带 --remote-debugging-port 启动的实例）。
   *
   * 这是"复用真实登录态"的唯一正路：我们不去碰用户的 profile，
   * 只是连上他已经开放的调试端口。浏览器在已有实例运行时会忽略该参数，
   * 所以调用前必须彻底退出日常浏览器。
   */
  async attach(port: number): Promise<Record<string, unknown>> {
    let version;
    try {
      version = await fetchVersion(port);
    } catch (error) {
      throw new CdpError(
        'CDP_UNAVAILABLE',
        `端口 ${port} 没有可用的 DevTools 端点（${error instanceof Error ? error.message : String(error)}）；` +
          '请确认浏览器是以 --remote-debugging-port=' + String(port) + ' 启动的，且没有已在运行的实例',
      );
    }

    rememberEndpoint({ port, wsUrl: version.webSocketDebuggerUrl, browser: version.Browser, userDataDir: '' });
    this.#client?.close();
    this.#client = undefined;
    this.#page = undefined;
    this.#endpoint = { port, wsUrl: version.webSocketDebuggerUrl, browser: version.Browser };
    return { attached: true, port, browser: version.Browser, wsUrl: version.webSocketDebuggerUrl };
  }

  async targets(): Promise<CdpTarget[]> {
    const client = await this.#requireClient();
    const listed = await client.send<{ targetInfos: CdpTarget[] }>('Target.getTargets');
    return listed.targetInfos;
  }

  async activateTab(targetId: string): Promise<void> {
    const client = await this.#requireClient();
    await client.send('Target.activateTarget', { targetId });
  }

  async closeTab(targetId: string): Promise<void> {
    const client = await this.#requireClient();
    await client.send('Target.closeTarget', { targetId });
    if (this.#page?.targetId === targetId) this.#page = undefined;
  }

  async openTab(url: string): Promise<{ targetId: string }> {
    const client = await this.#requireClient();
    return client.send<{ targetId: string }>('Target.createTarget', { url });
  }

  /** 把新开的 tab 作为当前操作页 */
  async attachTab(targetId: string): Promise<PageController> {
    const client = await this.#requireClient();
    this.#page = await PageController.attach(client, targetId);
    return this.#page;
  }

  async #requireClient(): Promise<CdpClient> {
    await this.ensure();
    if (this.#client === undefined) {
      throw new CdpError('PROVIDER_UNAVAILABLE', 'CDP 客户端未就绪');
    }
    return this.#client;
  }
}