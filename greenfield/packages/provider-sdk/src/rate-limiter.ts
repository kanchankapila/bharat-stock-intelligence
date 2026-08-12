// Per-provider request-per-second + max-concurrency limiter. Config is read
// from the `provider` table by the caller and passed in here -- this package
// never queries Postgres itself (import-boundary matrix).
export interface RateLimitOptions {
  rps: number;
  concurrency: number;
}

export class RateLimiter {
  private running = 0;
  private lastRequestAt = 0;
  private readonly queue: Array<() => void> = [];
  private readonly minIntervalMs: number;

  constructor(private readonly options: RateLimitOptions) {
    this.minIntervalMs = 1000 / Math.max(options.rps, 0.001);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const waitMs = Math.max(0, this.lastRequestAt + this.minIntervalMs - Date.now());
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.lastRequestAt = Date.now();
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.options.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
