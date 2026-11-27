import { describe, expect, it, vi } from 'vitest';
import {
  createFixedConsentRunner,
  createSpawnConsentRunner,
  mapExitCode,
  type ConsentProcessLike,
  type ConsentSpawn,
} from '../src/desktop/consent.js';
import { DesktopControlGate, type ControlIo, type DesktopControlState } from '../src/desktop/gate.js';
import { formatRef, isRef, parseRef, refHint } from '../src/desktop/ref.js';

function fakeProcess(exitCode: number | null, options: { failWith?: Error; neverExit?: boolean } = {}): ConsentProcessLike {
  const listeners: { exit: ((code: number | null, signal: string | null) => void)[]; error: ((error: Error) => void)[] } = {
    exit: [],
    error: [],
  };
  const child: ConsentProcessLike = {
    on(event: 'exit' | 'error', listener: (...args: never[]) => void) {
      if (event === 'exit') listeners.exit.push(listener as (code: number | null, signal: string | null) => void);
      else listeners.error.push(listener as (error: Error) => void);
      // 微任务里触发，模拟子进程生命周期
      queueMicrotask(() => {
        if (options.failWith !== undefined) {
          for (const l of listeners.error) l(options.failWith);
          return;
        }
        if (options.neverExit === true) return;
        for (const l of listeners.exit) l(exitCode, null);
      });
      return child;
    },
    kill: () => true,
  };
  return child;
}

describe('同意对话框退出码协议', () => {
  it('C-01 退出码映射：10/11/12/13', () => {
    expect(mapExitCode(10)).toBe('allow');
    expect(mapExitCode(11)).toBe('deny');
    expect(mapExitCode(12)).toBe('timeout');
    expect(mapExitCode(13)).toBe('unavailable');
  });

  it('C-02 崩溃/异常退出码一律 unavailable（fail closed）', () => {
    expect(mapExitCode(0)).toBe('unavailable');
    expect(mapExitCode(1)).toBe('unavailable');
    expect(mapExitCode(null)).toBe('unavailable');
  });

  it('C-03 seconds=0 不弹窗直接放行', async () => {
    const spawnImpl = vi.fn();
    const runner = createSpawnConsentRunner({ spawnImpl: spawnImpl as unknown as ConsentSpawn });
    await expect(runner.ask({ seconds: 0, title: 't', message: 'm' })).resolves.toBe('allow');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('C-04 对话框以独立进程启动且不共享 stdio', async () => {
    let captured: Record<string, unknown> | undefined;
    const spawnImpl = ((_cmd: string, _args: readonly string[], options: Record<string, unknown>) => {
      captured = options;
      return fakeProcess(10);
    }) as unknown as ConsentSpawn;
    const runner = createSpawnConsentRunner({ spawnImpl });
    await expect(runner.ask({ seconds: 5, title: 't', message: 'm' })).resolves.toBe('allow');
    expect(captured?.['stdio']).toEqual(['ignore', 'ignore', 'ignore']);
  });

  it('C-05 用户拒绝 → deny', async () => {
    const runner = createSpawnConsentRunner({ spawnImpl: (() => fakeProcess(11)) as unknown as ConsentSpawn });
    await expect(runner.ask({ seconds: 5, title: 't', message: 'm' })).resolves.toBe('deny');
  });

  it('C-06 倒计时无应答 → timeout（自动放行）', async () => {
    const runner = createSpawnConsentRunner({ spawnImpl: (() => fakeProcess(12)) as unknown as ConsentSpawn });
    await expect(runner.ask({ seconds: 5, title: 't', message: 'm' })).resolves.toBe('timeout');
  });

  it('C-07 启动失败 → unavailable', async () => {
    const runner = createSpawnConsentRunner({
      spawnImpl: (() => {
        throw new Error('spawn ENOENT');
      }) as unknown as ConsentSpawn,
    });
    await expect(runner.ask({ seconds: 5, title: 't', message: 'm' })).resolves.toBe('unavailable');
  });

  it('C-08 对话框挂起（超过 seconds+grace）→ unavailable，不是 timeout', async () => {
    vi.useFakeTimers();
    try {
      const runner = createSpawnConsentRunner({
        spawnImpl: (() => fakeProcess(10, { neverExit: true })) as unknown as ConsentSpawn,
        graceSeconds: 1,
      });
      const pending = runner.ask({ seconds: 2, title: 't', message: 'm' });
      await vi.advanceTimersByTimeAsync(4000);
      await expect(pending).resolves.toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('C-09 固定 runner 便于测试与无人值守', async () => {
    await expect(createFixedConsentRunner('allow').ask({} as never)).resolves.toBe('allow');
  });
});

function makeIo(state: Partial<DesktopControlState> = {}): { io: ControlIo; writes: string[] } {
  const writes: string[] = [];
  let policy = state.policy ?? 'balanced';
  const io: ControlIo = {
    async readState() {
      return {
        policy,
        idleMs: state.idleMs ?? 60_000,
        interactive: state.interactive ?? true,
        foreground: null,
      };
    },
    async writePolicy(next) {
      const previous = policy;
      policy = next;
      writes.push(next);
      return { previous, policy: next };
    },
  };
  return { io, writes };
}

describe('桌面控制门控运行时', () => {
  it('G-01 other 类不受门控，不触发同意', async () => {
    const { io } = makeIo();
    const ask = vi.fn();
    const gate = new DesktopControlGate({ io, consent: { ask } });
    const probe = await gate.ensure('desktop.ui.snapshot');
    expect(probe.gated).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('G-02 balanced 下 direct 需要同意并建立租约', async () => {
    const { io } = makeIo();
    const ask = vi.fn(async () => 'allow' as const);
    const gate = new DesktopControlGate({ io, consent: { ask } });
    const probe = await gate.ensure('desktop.ui.act', { action: 'click' });
    expect(probe.gated).toBe(true);
    expect(probe.leaseAcquired).toBe(true);
    expect(gate.leased).toBe(true);
  });

  it('G-03 租约有效期内不再重复弹窗', async () => {
    const { io } = makeIo();
    const ask = vi.fn(async () => 'allow' as const);
    const gate = new DesktopControlGate({ io, consent: { ask } });
    await gate.ensure('desktop.ui.act', {});
    await gate.ensure('desktop.ui.act', {});
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('G-04 用户拒绝 → CONTROL_DENIED 且不建立租约', async () => {
    const { io } = makeIo();
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('deny') });
    await expect(gate.ensure('desktop.ui.act', {})).rejects.toMatchObject({ toolError: { code: 'CONTROL_DENIED' } });
    expect(gate.leased).toBe(false);
  });

  it('G-05 对话框不可用 → CONTROL_DENIED（fail closed）', async () => {
    const { io } = makeIo();
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('unavailable') });
    await expect(gate.ensure('desktop.ui.act', {})).rejects.toMatchObject({ toolError: { code: 'CONTROL_DENIED' } });
  });

  it('G-06 无交互会话时提示可关闭弹窗', async () => {
    const { io } = makeIo({ interactive: false });
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('unavailable') });
    await expect(gate.ensure('desktop.ui.act', {})).rejects.toMatchObject({
      toolError: { code: 'CONTROL_DENIED', message: expect.stringContaining('无交互桌面') },
    });
  });

  it('G-07 倒计时无应答建立租约但标记 consent=timeout', async () => {
    const { io } = makeIo();
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('timeout') });
    const probe = await gate.ensure('desktop.ui.act', {});
    expect(probe.consent).toBe('timeout');
    expect(gate.leased).toBe(true);
  });

  it('G-08 用户夺回控制 → USER_CONTROL 且租约撤销', async () => {
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
    const gate = new DesktopControlGate({
      io,
      consent: createFixedConsentRunner('allow'),
      now: () => now,
    });
    await gate.ensure('desktop.ui.act', {});

    // 我方刚发过输入：宽限期内即使 idle 很小也不算夺回
    now += 200;
    idle = 100;
    await expect(gate.ensure('desktop.ui.act', {})).resolves.toBeTruthy();

    // 超出宽限期，且空闲时间很短 → 判定为用户夺回
    now += 5_000;
    idle = 100;
    await expect(gate.ensure('desktop.ui.act', {})).rejects.toMatchObject({ toolError: { code: 'USER_CONTROL' } });
    expect(gate.leased).toBe(false);
  });

  it('G-09 租约空闲超时后重新征求同意', async () => {
    let now = 0;
    const io = makeIo().io;
    const ask = vi.fn(async () => 'allow' as const);
    const gate = new DesktopControlGate({ io, consent: { ask }, now: () => now, leaseTtlMs: 1_000 });
    await gate.ensure('desktop.ui.act', {});
    now += 5_000;
    await gate.ensure('desktop.ui.act', {});
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('G-10 release 后重新需要同意', async () => {
    const { io } = makeIo();
    const ask = vi.fn(async () => 'allow' as const);
    const gate = new DesktopControlGate({ io, consent: { ask } });
    await gate.ensure('desktop.ui.act', {});
    gate.release();
    await gate.ensure('desktop.ui.act', {});
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('G-11 setPolicy 写入并返回前后值；非法值被拒', async () => {
    const { io, writes } = makeIo();
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('allow') });
    await expect(gate.setPolicy('strict')).resolves.toEqual({ previous: 'balanced', policy: 'strict' });
    expect(writes).toEqual(['strict']);
    await expect(gate.setPolicy('yolo' as never)).rejects.toMatchObject({
      toolError: { code: 'INVALID_PARAMS' },
    });
  });

  it('G-12 status 披露策略、租约剩余与解释性说明', async () => {
    const { io } = makeIo();
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('allow'), consentSeconds: 0 });
    await gate.ensure('desktop.ui.act', {});
    const status = await gate.status();
    expect(status['policy']).toBe('balanced');
    expect(status['leased']).toBe(true);
    expect(String(status['note'])).toContain('协调而非独占');
  });

  it('G-13 run 在成功后刷新租约活动时间，避免把自己输入误判为夺回', async () => {
    let now = 0;
    const io = makeIo({ idleMs: 50 }).io;
    const gate = new DesktopControlGate({ io, consent: createFixedConsentRunner('allow'), now: () => now });
    await gate.run('desktop.ui.act', {}, async () => {
      now += 5_000; // 动作耗时
      return 'ok';
    });
    await expect(gate.ensure('desktop.ui.act', {})).resolves.toBeTruthy();
  });
});

describe('元素 ref 语义', () => {
  it('R-01 合法 ref 解析出快照与序号', () => {
    expect(parseRef('@s3:e12')).toEqual({ raw: '@s3:e12', snapshotId: 3, index: 12 });
  });

  it('R-02 裸 ref / 空值 / 非字符串被拒', () => {
    expect(parseRef('@e8')).toBeNull();
    expect(parseRef('e8')).toBeNull();
    expect(parseRef('')).toBeNull();
    expect(parseRef(undefined)).toBeNull();
    expect(parseRef(8)).toBeNull();
  });

  it('R-03 formatRef 与 parseRef 互逆', () => {
    expect(parseRef(formatRef(7, 2))).toEqual({ raw: '@s7:e2', snapshotId: 7, index: 2 });
  });

  it('R-04 isRef 只认完整形式', () => {
    expect(isRef('@s1:e0')).toBe(true);
    expect(isRef('@1:e0')).toBe(false);
  });

  it('R-05 refHint 点出裸 ref 的缺快照 id 问题', () => {
    expect(refHint('@e8')).toContain('缺少快照 id');
    expect(refHint('')).toContain('ref 缺失');
    expect(refHint('abc')).toContain('格式非法');
  });
});