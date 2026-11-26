/** 并发分类与上限 — 对应 FR-107（移植 dddabtc taskmanager.py:CATEGORY_LIMITS） */
export type Category = 'DESKTOP' | 'SHELL' | 'FILE' | 'QUERY';

export const CATEGORY_LIMITS: Record<Category, number> = {
  DESKTOP: 1,
  SHELL: 3,
  FILE: 5,
  QUERY: 10,
};

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

function emptyCounters(): Record<Category, number> {
  return { DESKTOP: 0, SHELL: 0, FILE: 0, QUERY: 0 };
}

function emptyQueues(): Record<Category, Waiter[]> {
  return { DESKTOP: [], SHELL: [], FILE: [], QUERY: [] };
}

export interface AcquireOptions {
  timeoutMs?: number;
}

export class CategorySemaphore {
  readonly #limits: Record<Category, number>;
  readonly #running: Record<Category, number> = emptyCounters();
  readonly #queues: Record<Category, Waiter[]> = emptyQueues();

  constructor(limits: Partial<Record<Category, number>> = {}) {
    this.#limits = { ...CATEGORY_LIMITS, ...limits };
  }

  acquire(category: Category, opts: AcquireOptions = {}): Promise<() => void> {
    const limit = this.#limits[category];
    if (this.#running[category] < limit) {
      this.#running[category] += 1;
      return Promise.resolve(this.#makeRelease(category));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        const timeoutMs = opts.timeoutMs;
        waiter.timer = setTimeout(() => {
          const queue = this.#queues[category];
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          const error = new Error(`TIMEOUT: ${category} 并发等待超时（${timeoutMs}ms）`);
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
        waiter.timer.unref();
      }
      this.#queues[category].push(waiter);
    });
  }

  stats(): Record<Category, { running: number; queued: number; limit: number }> {
    return {
      DESKTOP: this.#stat('DESKTOP'),
      SHELL: this.#stat('SHELL'),
      FILE: this.#stat('FILE'),
      QUERY: this.#stat('QUERY'),
    };
  }

  #stat(category: Category): { running: number; queued: number; limit: number } {
    return {
      running: this.#running[category],
      queued: this.#queues[category].length,
      limit: this.#limits[category],
    };
  }

  /** release 幂等：连续调用不会多减配额 */
  #makeRelease(category: Category): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queues[category].shift();
      if (next !== undefined) {
        if (next.timer !== undefined) clearTimeout(next.timer);
        // 名额直接转交，running 计数保持不变
        next.resolve(this.#makeRelease(category));
        return;
      }
      this.#running[category] = Math.max(0, this.#running[category] - 1);
    };
  }
}