import { describe, expect, it, vi } from 'vitest';
import {
  CdpClient,
  CdpError,
  targetIdOf,
  swapLoopbackHost,
  type CdpTarget,
  type WebSocketLike,
} from '../src/browser/cdp.js';
import { PageController, formatBrowserRef, parseBrowserRef, pickPageTarget } from '../src/browser/page.js';

/** 假 WebSocket：记录发出的帧，可主动推消息 */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  #handlers = new Map<string, ((payload: never) => void)[]>();

  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (payload: never) => void): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(listener);
    this.#handlers.set(event, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.#handlers.get('close') ?? []) listener(undefined as never);
  }

  emit(event: 'open' | 'message' | 'close' | 'error', payload?: unknown): void {
    for (const listener of this.#handlers.get(event) ?? []) listener(payload as never);
  }

  reply(payload: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  lastFrame(): Record<string, unknown> {
    const frame = this.sent[this.sent.length - 1];
    return JSON.parse(frame ?? '{}') as Record<string, unknown>;
  }
}

describe('CDP 协议客户端', () => {
  it('K-01 请求带自增 id，响应按 id 匹配', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const pending = client.send('Runtime.evaluate', { expression: '1+1' });
    const frame = socket.lastFrame();
    expect(frame['method']).toBe('Runtime.evaluate');
    expect(typeof frame['id']).toBe('number');
    socket.reply({ id: frame['id'], result: { result: { value: 2 } } });
    await expect(pending).resolves.toEqual({ result: { value: 2 } });
  });

  it('K-02 sessionId 透传到帧里（flatten 模式）', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const pending = client.send('Page.navigate', { url: 'about:blank' }, { sessionId: 'S1' });
    expect(socket.lastFrame()['sessionId']).toBe('S1');
    socket.reply({ id: socket.lastFrame()['id'], result: {} });
    await pending;
  });

  it('K-03 CDP 错误码映射到 CdpError 并保留方法名', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const pending = client.send('Target.attachToTarget', {});
    socket.reply({ id: socket.lastFrame()['id'], error: { code: -32602, message: 'Invalid parameters' } });
    await expect(pending).rejects.toMatchObject({
      code: 'CDP_-32602',
      message: expect.stringContaining('Target.attachToTarget'),
    });
  });

  it('K-04 事件按 method 分发，sessionId 一并给到监听器', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const seen: unknown[] = [];
    client.on('Page.loadEventFired', (params, sessionId) => seen.push({ params, sessionId }));
    socket.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' }) });
    expect(seen).toEqual([{ params: { timestamp: 1 }, sessionId: 'S1' }]);
  });

  it('K-05 连接关闭时未完成调用全部 reject', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    const pending = client.send('Page.enable', {});
    socket.close();
    await expect(pending).rejects.toMatchObject({ code: 'CDP_CLOSED' });
    expect(client.closed).toBe(true);
  });

  it('K-06 关闭后再发送直接拒绝', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    client.close();
    await expect(client.send('Page.enable')).rejects.toMatchObject({ code: 'CDP_CLOSED' });
  });

  it('K-07 超时抛 CDP_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const client = new CdpClient(socket, 100);
      const pending = client.send('Page.enable');
      const assertion = expect(pending).rejects.toMatchObject({ code: 'CDP_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('K-08 非法 JSON 帧被静默丢弃，不影响后续响应', async () => {
    const socket = new FakeSocket();
    const client = new CdpClient(socket);
    socket.emit('message', { data: 'not json' });
    const pending = client.send('Page.enable');
    socket.reply({ id: socket.lastFrame()['id'], result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });
});

describe('CDP target 与回环主机', () => {
  it('K-09 targetIdOf 兼容 /json/list 的 id 与 Target.getTargets 的 targetId', () => {
    expect(targetIdOf({ id: 'A', type: 'page', title: '', url: '' })).toBe('A');
    expect(targetIdOf({ targetId: 'B', type: 'page', title: '', url: '' })).toBe('B');
    expect(targetIdOf({ type: 'page', title: '', url: '' })).toBe('');
  });

  it('K-10 pickPageTarget 跳过非 page 类型', () => {
    const targets: CdpTarget[] = [
      { targetId: '1', type: 'service_worker', title: '', url: '' },
      { targetId: '2', type: 'page', title: 't', url: 'u' },
    ];
    expect(targetIdOf(pickPageTarget(targets)!)).toBe('2');
    expect(pickPageTarget([{ targetId: '1', type: 'browser', title: '', url: '' }])).toBeNull();
  });

  it('K-11 回环主机名可互换（TUN 与 ::1 差异的兜底）', () => {
    expect(swapLoopbackHost('ws://127.0.0.1:9/x')).toBe('ws://localhost:9/x');
    expect(swapLoopbackHost('ws://localhost:9/x')).toBe('ws://127.0.0.1:9/x');
    expect(swapLoopbackHost('ws://example.com:9/x')).toBe('ws://example.com:9/x');
  });
});

describe('页面控制器（假客户端）', () => {
  function makeClient(responses: Record<string, unknown>): CdpClient {
    const stub = {
      send: vi.fn(async (method: string) => responses[method]),
      on: vi.fn(),
      closed: false,
    };
    return stub as unknown as CdpClient;
  }

  it('K-12 attach 后开启 Page/Runtime 域', async () => {
    const send = vi.fn(async (method: string) => (method === 'Target.attachToTarget' ? { sessionId: 'S1' } : {}));
    const client = { send, on: vi.fn(), closed: false } as unknown as CdpClient;
    const page = await PageController.attach(client, 'T1');
    expect(page.sessionId).toBe('S1');
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      'Target.attachToTarget',
      'Page.enable',
      'Runtime.enable',
    ]);
  });

  it('K-13 snapshot 把页内下标包装成 @b<N>:e<M>', async () => {
    const client = makeClient({
      'Target.attachToTarget': { sessionId: 'S1' },
      'Runtime.evaluate': {
        result: {
          value: {
            nodes: [
              { ref: 0, role: 'button', name: 'OK', depth: 0, states: [], actions: ['click'], value: '', bounds: null, tag: 'button', id: '' },
            ],
            truncated: false,
            url: 'https://example.com',
            title: 'Example',
          },
        },
      },
    });
    const page = await PageController.attach(client, 'T1');
    const snapshot = await page.snapshot();
    expect(snapshot.nodes[0]?.ref).toBe(formatBrowserRef(1, 0));
    expect(snapshot.url).toBe('https://example.com');
  });

  it('K-14 跨快照 ref 直接 STALE_REF（不会照着旧下标乱点）', async () => {
    const client = makeClient({
      'Target.attachToTarget': { sessionId: 'S1' },
      'Runtime.evaluate': {
        result: { value: { nodes: [], truncated: false, url: 'https://a', title: 'a' } },
      },
    });
    const page = await PageController.attach(client, 'T1');
    await page.snapshot();
    await page.snapshot();
    await expect(page.act(formatBrowserRef(1, 0), 'click')).rejects.toMatchObject({ code: 'STALE_REF' });
  });

  it('K-15 裸 ref 被拒为 INVALID_PARAMS', async () => {
    const client = makeClient({ 'Target.attachToTarget': { sessionId: 'S1' } });
    const page = await PageController.attach(client, 'T1');
    await page.snapshot();
    await expect(page.act('@e0', 'click')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('K-16 元素已从 DOM 移除 → STALE_REF', async () => {
    const send = vi.fn(async (method: string) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      if (method === 'Runtime.evaluate') return { result: { value: { ok: false, reason: 'detached' } } };
      return {};
    });
    const page = await PageController.attach({ send, on: vi.fn(), closed: false } as unknown as CdpClient, 'T1');
    await page.snapshot();
    await expect(page.act(formatBrowserRef(1, 0), 'click')).rejects.toMatchObject({ code: 'STALE_REF' });
  });

  it('K-17 动作前断言失败 → GUARD_ASSERTION_FAILED，且不执行动作', async () => {
    const calls: string[] = [];
    let evaluateCount = 0;
    const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      if (method === 'Runtime.evaluate') {
        evaluateCount += 1;
        const expression = String(params['expression'] ?? '');
        calls.push(expression.slice(0, 80));
        if (expression.includes('const conditions')) {
          return { result: { value: { ok: false, failures: ['e1: 文本不含 "x"'] } } };
        }
        return { result: { value: { ok: true, nodes: [], url: 'u', title: 't' } } };
      }
      return {};
    });
    const page = await PageController.attach({ send, on: vi.fn(), closed: false } as unknown as CdpClient, 'T1');
    await page.snapshot();
    const before = evaluateCount;
    await expect(
      page.act(formatBrowserRef(1, 0), 'click', { expect: [{ ref: formatBrowserRef(1, 1), text: 'x' }] }),
    ).rejects.toMatchObject({ code: 'GUARD_ASSERTION_FAILED' });
    // 断言脚本执行后立即失败，不应再跑解析/动作脚本
    expect(evaluateCount - before).toBe(1);
    expect(calls.some((call) => call.includes('const conditions'))).toBe(true);
  });

  it('K-18 expect 里的 ref 属于旧快照 → STALE_REF', async () => {
    const client = makeClient({ 'Target.attachToTarget': { sessionId: 'S1' } });
    const page = await PageController.attach(client, 'T1');
    await page.snapshot();
    await expect(
      page.act(formatBrowserRef(1, 0), 'click', { expect: [{ ref: formatBrowserRef(9, 0), exists: true }] }),
    ).rejects.toMatchObject({ code: 'STALE_REF' });
  });
});

describe('浏览器 ref 解析', () => {
  it('K-19 @b<N>:e<M> 解析与格式化互逆', () => {
    expect(parseBrowserRef(formatBrowserRef(4, 7))).toEqual({ snapshotId: 4, index: 7 });
  });

  it('K-20 其它形式一律 null', () => {
    for (const value of ['@e1', '@b1', 'b1:e1', '@s1:e0', '', '@b1:eX']) {
      expect(parseBrowserRef(value)).toBeNull();
    }
  });

  it('K-21 CdpError 保留可读错误码', () => {
    const error = new CdpError('STALE_REF', '旧快照');
    expect(error.code).toBe('STALE_REF');
    expect(error.name).toBe('CdpError');
  });
});