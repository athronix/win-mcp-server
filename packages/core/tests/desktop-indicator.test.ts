import { describe, expect, it, vi } from 'vitest';
import { createNoopIndicator, createSpawnIndicator, type IndicatorProcessLike, type IndicatorSpawn } from '../src/desktop/indicator.js';
import { DesktopControlGate, type ControlIo } from '../src/desktop/gate.js';
import { createFixedConsentRunner } from '../src/desktop/consent.js';

function fakeProcess(pid = 4321): IndicatorProcessLike & { killed: string[] } {
  const killed: string[] = [];
  return {
    pid,
    killed,
    kill(signal?: string) {
      killed.push(signal ?? 'SIGTERM');
      return true;
    },
    unref: () => undefined,
    on: () => undefined,
  };
}

describe('桌面控制指示器', () => {
  it('I-01 show 以独立进程启动，参数含秒数与脚本路径', () => {
    let captured: { args: readonly string[]; options: Record<string, unknown> } | undefined;
    const spawnImpl = ((_cmd: string, args: readonly string[], options: Record<string, unknown>) => {
      captured = { args, options };
      return fakeProcess();
    }) as unknown as IndicatorSpawn;

    const indicator = createSpawnIndicator({ spawnImpl, scriptPath: 'C:\\ps\\control-indicator.ps1' });
    const handle = indicator.show(120);

    expect(handle).toEqual({ pid: 4321 });
    expect(captured?.args).toContain('-File');
    expect(captured?.args).toContain('C:\\ps\\control-indicator.ps1');
    expect(captured?.args[captured.args.length - 1]).toBe('120');
    expect(captured?.options['stdio']).toEqual(['ignore', 'ignore', 'ignore']);
    expect(captured?.options['detached']).toBe(true);
  });

  it('I-02 秒数至少 1（避免 0 让覆盖层立刻消失）', () => {
    let lastArgs: readonly string[] = [];
    const spawnImpl = ((_cmd: string, args: readonly string[]) => {
      lastArgs = args;
      return fakeProcess();
    }) as unknown as IndicatorSpawn;
    createSpawnIndicator({ spawnImpl }).show(0);
    expect(lastArgs[lastArgs.length - 1]).toBe('1');
  });

  it('I-03 hide 会 kill 且 active 归位', () => {
    const child = fakeProcess();
    const spawnImpl = (() => child) as unknown as IndicatorSpawn;
    const indicator = createSpawnIndicator({ spawnImpl });
    indicator.show(30);
    expect(indicator.active).toBe(true);
    indicator.hide();
    expect(child.killed).toEqual(['SIGTERM']);
    expect(indicator.active).toBe(false);
  });

  it('I-04 重复 show 会先释放上一个进程（不叠加覆盖层）', () => {
    const children = [fakeProcess(1), fakeProcess(2)];
    let index = 0;
    const spawnImpl = (() => children[index++]!) as unknown as IndicatorSpawn;
    const indicator = createSpawnIndicator({ spawnImpl });
    indicator.show(10);
    indicator.show(10);
    expect(children[0]?.killed).toEqual(['SIGTERM']);
    expect(children[1]?.killed).toEqual([]);
  });

  it('I-05 disabled 时不 spawn', () => {
    const spawnImpl = vi.fn();
    const indicator = createSpawnIndicator({ spawnImpl: spawnImpl as unknown as IndicatorSpawn, enabled: false });
    expect(indicator.show(10)).toBeNull();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('I-06 启动异常只上报，不抛出（指示器是装饰）', () => {
    const onError = vi.fn();
    const spawnImpl = (() => {
      throw new Error('spawn ENOENT');
    }) as unknown as IndicatorSpawn;
    const indicator = createSpawnIndicator({ spawnImpl, onError });
    expect(indicator.show(10)).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('指示器启动异常'));
  });

  it('I-07 noop 实现满足接口', () => {
    const indicator = createNoopIndicator();
    expect(indicator.show(10)).toBeNull();
    expect(indicator.active).toBe(false);
    indicator.hide();
  });
});

function makeIo(state: { idleMs?: number } = {}): ControlIo {
  return {
    async readState() {
      return { policy: 'balanced' as const, idleMs: state.idleMs ?? 60_000, interactive: true, foreground: null };
    },
    async writePolicy(p) {
      return { previous: p, policy: p };
    },
  };
}

describe('门控与指示器联动', () => {
  it('G-14 取得租约时点亮指示器，release 时熄灭', async () => {
    const child = fakeProcess();
    const indicator = createSpawnIndicator({ spawnImpl: (() => child) as unknown as IndicatorSpawn });
    const gate = new DesktopControlGate({ io: makeIo(), consent: createFixedConsentRunner('allow'), indicator });

    const statusBefore = await gate.status();
    expect(statusBefore['indicatorActive']).toBe(false);

    await gate.ensure('desktop.ui.act', {});
    expect(indicator.active).toBe(true);

    gate.release();
    expect(child.killed).toEqual(['SIGTERM']);
    expect(indicator.active).toBe(false);
  });

  it('G-15 用户夺回时熄灭指示器', async () => {
    let now = 1_000_000;
    let idle = 60_000;
    const io: ControlIo = {
      async readState() {
        return { policy: 'balanced' as const, idleMs: idle, interactive: true, foreground: null };
      },
      async writePolicy(p) {
        return { previous: p, policy: p };
      },
    };
    const child = fakeProcess();
    const indicator = createSpawnIndicator({ spawnImpl: (() => child) as unknown as IndicatorSpawn });
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('allow'), indicator, now: () => now });

    await gate.ensure('desktop.ui.act', {});
    now += 5_000;
    idle = 50;
    await expect(gate.ensure('desktop.ui.act', {})).rejects.toMatchObject({ toolError: { code: 'USER_CONTROL' } });
    expect(child.killed).toContain('SIGTERM');
  });

  it('G-16 租约空闲超时也熄灭', async () => {
    let now = 0;
    const child = fakeProcess();
    const indicator = createSpawnIndicator({ spawnImpl: (() => child) as unknown as IndicatorSpawn });
    const gate = new DesktopControlGate({
      io: makeIo(),
      consent: createFixedConsentRunner('allow'),
      indicator,
      now: () => now,
      leaseTtlMs: 1_000,
    });
    await gate.ensure('desktop.ui.act', {});
    now += 5_000;
    await gate.ensure('desktop.ui.act', {});
    expect(child.killed.length).toBeGreaterThanOrEqual(1);
  });
});