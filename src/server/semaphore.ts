export class Semaphore {
  private tasks: (() => void)[] = [];
  private _count: number;

  constructor(count: number) {
    this._count = count;
  }

  get count() {
    return this._count;
  }

  get queueDepth() {
    return this.tasks.length;
  }

  async acquire() {
    return new Promise<void>((resolve) => {
      if (this._count > 0) {
        this._count--;
        resolve();
      } else {
        this.tasks.push(resolve);
      }
    });
  }

  release() {
    this._count++;
    const next = this.tasks.shift();
    if (next) {
      this._count--;
      next();
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * Run a task immediately if the semaphore has slots, 
   * otherwise run it without waiting for acquisition.
   * Useful for high-priority or cached operations.
   */
  async runPriority<T>(task: () => Promise<T>): Promise<T> {
    const hasSlot = this._count > 0;
    if (hasSlot) {
      await this.acquire();
      try {
        return await task();
      } finally {
        this.release();
      }
    } else {
      // Just run it - we don't want to block the entire pipeline if the semaphore is full
      return await task();
    }
  }
}
