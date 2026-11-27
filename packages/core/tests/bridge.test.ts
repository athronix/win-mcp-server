import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import {
  PowerShellBridge,
  type ChildProcessLike,
  type SpawnImpl,
} from '../src/bridge/bridge.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeRequest {
  id: string;
  op: string;
  params: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinStream = new PassThrough();
  readonly stdin: NodeJS.WritableStream;
  readonly executable: string;
  readonly requests: FakeRequest[] = [];
  pid = 4242;

  constructor(executable: string, onRequest: (req: FakeRequest) => void) {
    super();
    this.executable = executable;
    this.stdin = this.stdinStream as unknown as NodeJS.WritableStream;
    const reader = createInterface({ input: this.stdinStream });
    reader.on('line', (line: string) => {
      if (line.trim().length === 0) return;
      const parsed = JSON.parse(line) as FakeRequest;
      this.requests.push(parsed);
      onRequest(parsed);
    });
  }

  requestOps(): string[] {
    return this.requests.map((req) => req.op);
  }

  writeProtocol(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(): boolean {
    this.emit('exit', 0, null);
    return true;
  }
}

function respond(child: FakeChild, req: FakeRequest): void {
  if (req.op === 'ping') {
    child.writeProtocol({ id: req.id, ok: true, data: { pong: true }, durationMs: 1 });
    return;
  }
  if (req.op === 'info') {
    child.writeProtocol({
      id: req.id,
      ok: true,
      data: {
        version: '7.6.10',
        edition: 'Core',
        elevated: false,
        pid: 4242,
        executable: child.executable,
        platform: 'Windows',
      },
    });
    return;
  }
  if (req.op === 'echo') {
    child.writeProtocol({ id: req.id, ok: true, data: req.params });
    return;
  }
  if (req.op === 'fail') {
    child.writeProtocol({
      id: req.id,
      ok: false,
      error: { code: 'BOOM', message: 'remote failed' },
    });
    return;
  }
  // 'slow' 故意不响应
}

function makeFakeSpawn(options: { failCount?: number } = {}) {
  const children: FakeChild[] = [];
  let spawned = 0;
  const failCount = options.failCount ?? 0;

  const spawnImpl: SpawnImpl = (command) => {
    spawned += 1;
    if (spawned <= failCount) throw new Error('ENOENT: not found');
    const child = new FakeChild(command, (req) => respond(child, req));
    children.push(child);
    return child as unknown as ChildProcessLike;
  };

  return { spawnImpl, children };
}

describe('CL-002 PowerShellBridge（假进程）', () => {
  it('B-01 start 返回 info 并完成 ping/info 握手', async () => {
    const { spawnImpl, children } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl, scriptPath: 'fake.ps1' });
    const info = await bridge.start();
    expect(info).toMatchObject({ version: '7.6.10', elevated: false });
    expect(bridge.status.running).toBe(true);
    expect(bridge.status.pending).toBe(0);
    expect(children[0]!.requestOps()).toEqual(['ping', 'info']);
    await bridge.stop();
  });

  it('B-02 call 通过 id 匹配响应', async () => {
    const { spawnImpl } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl });
    await bridge.start();
    const result = await bridge.call<{ command: string }>('echo', { command: 'Get-Process' });
    expect(result).toEqual({ command: 'Get-Process' });
    await bridge.stop();
  });

  it('B-03 请求超时抛 TIMEOUT 且清理 pending', async () => {
    const { spawnImpl } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl });
    await bridge.start();
    await expect(bridge.call('slow', {}, { timeoutMs: 40 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(bridge.status.pending).toBe(0);
    await bridge.stop();
  });

  it('B-04 桥退出时 pending 全部失败', async () => {
    const { spawnImpl, children } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl, maxRestarts: 0 });
    await bridge.start();
    const pendingCall = bridge.call('slow', {}, { timeoutMs: 5000 });
    await delay(10);
    children[0]!.emit('exit', 1, null);
    await expect(pendingCall).rejects.toMatchObject({ code: 'BRIDGE_EXITED' });
    expect(bridge.status.running).toBe(false);
    await bridge.stop();
  });

  it('B-05 非协议行被忽略，不影响正常请求', async () => {
    const { spawnImpl, children } = makeFakeSpawn();
    const diagnostics: string[] = [];
    const bridge = new PowerShellBridge({
      spawnImpl,
      onDiagnostic: (line) => diagnostics.push(line),
    });
    await bridge.start();
    children[0]!.stdout.write('PowerShell 7.6.10 banner\n');
    children[0]!.stdout.write('{"id":"unknown","ok":true,"data":1}\n');
    const result = await bridge.call<{ command: string }>('echo', { command: 'x' });
    expect(result).toEqual({ command: 'x' });
    expect(diagnostics.some((line) => line.includes('non-protocol'))).toBe(true);
    await bridge.stop();
  });

  it('B-06 远端 ok:false 转 BRIDGE_REMOTE', async () => {
    const { spawnImpl } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl });
    await bridge.start();
    await expect(bridge.call('fail', {})).rejects.toMatchObject({ code: 'BRIDGE_REMOTE' });
    await bridge.stop();
  });

  it('B-07 pwsh 缺失时回退 powershell', async () => {
    const { spawnImpl, children } = makeFakeSpawn({ failCount: 1 });
    const bridge = new PowerShellBridge({ spawnImpl });
    const info = await bridge.start();
    expect(children).toHaveLength(1);
    expect(children[0]!.executable).toBe('powershell');
    expect(info.executable).toBe('powershell');
    await bridge.stop();
  });

  it('B-08 两种可执行文件都不可用 → BRIDGE_UNAVAILABLE', async () => {
    const { spawnImpl } = makeFakeSpawn({ failCount: 2 });
    const bridge = new PowerShellBridge({ spawnImpl });
    await expect(bridge.start()).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
  });

  it('B-09 stop 之后 call 抛 BRIDGE_UNAVAILABLE', async () => {
    const { spawnImpl } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl });
    await bridge.start();
    await bridge.stop();
    await expect(bridge.call('echo', {})).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
  });

  it('B-10 迟到响应被丢弃，不产生未处理异常', async () => {
    const { spawnImpl, children } = makeFakeSpawn();
    const bridge = new PowerShellBridge({ spawnImpl });
    await bridge.start();
    await expect(bridge.call('slow', {}, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    const slowRequest = children[0]!.requests.find((req) => req.op === 'slow');
    expect(slowRequest).toBeDefined();
    children[0]!.writeProtocol({ id: slowRequest!.id, ok: true, data: 'late' });
    await delay(10);
    expect(bridge.status.pending).toBe(0);
    await bridge.stop();
  });
});