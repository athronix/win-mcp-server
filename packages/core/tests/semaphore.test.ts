import { describe, expect, it } from 'vitest';
import { CategorySemaphore } from '../src/taskmgr/semaphore.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FR-107 并发控制', () => {
  it('S-01 DESKTOP 互斥', async () => {
    const sem = new CategorySemaphore();
    const release1 = await sem.acquire('DESKTOP');
    let secondAcquired = false;
    const pending = sem.acquire('DESKTOP').then((release) => {
      secondAcquired = true;
      return release;
    });
    await tick();
    expect(secondAcquired).toBe(false);
    expect(sem.stats().DESKTOP).toEqual({ running: 1, queued: 1, limit: 1 });
    release1();
    const release2 = await pending;
    expect(secondAcquired).toBe(true);
    release2();
    expect(sem.stats().DESKTOP.running).toBe(0);
  });

  it('S-02 SHELL 上限 3', async () => {
    const sem = new CategorySemaphore();
    const releases = await Promise.all([
      sem.acquire('SHELL'),
      sem.acquire('SHELL'),
      sem.acquire('SHELL'),
    ]);
    expect(sem.stats().SHELL.running).toBe(3);
    let fourth = false;
    const pending = sem.acquire('SHELL').then((release) => {
      fourth = true;
      return release;
    });
    await tick();
    expect(fourth).toBe(false);
    releases[0]!();
    const release4 = await pending;
    expect(fourth).toBe(true);
    release4();
    releases[1]!();
    releases[2]!();
  });

  it('S-03 等待超时抛 TIMEOUT', async () => {
    const sem = new CategorySemaphore({ DESKTOP: 1 });
    const release = await sem.acquire('DESKTOP');
    await expect(sem.acquire('DESKTOP', { timeoutMs: 10 })).rejects.toThrow(/TIMEOUT/);
    expect(sem.stats().DESKTOP.queued).toBe(0);
    release();
  });

  it('S-04 release 幂等', async () => {
    const sem = new CategorySemaphore();
    const release = await sem.acquire('FILE');
    release();
    release();
    expect(sem.stats().FILE.running).toBe(0);
  });

  it('S-05 stats 反映排队与上限', async () => {
    const sem = new CategorySemaphore({ QUERY: 2 });
    const r1 = await sem.acquire('QUERY');
    const r2 = await sem.acquire('QUERY');
    const pending = sem.acquire('QUERY');
    await tick();
    expect(sem.stats().QUERY).toEqual({ running: 2, queued: 1, limit: 2 });
    r1();
    const r3 = await pending;
    r2();
    r3();
    expect(sem.stats().QUERY.running).toBe(0);
  });
});