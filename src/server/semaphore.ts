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

  async acquire(priority = false) {
    return new Promise<void>((resolve) => {
      if (this._count > 0) {
        this._count--;
        resolve();
      } else {
        if (priority) {
          this.tasks.unshift(resolve); // Jump the line!
        } else {
          this.tasks.push(resolve);
        }
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
    await this.acquire(false);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * Run a high-priority task. Always acquires the lock to keep concurrency strictly
   * within bounds, but jumps to the front of the queue to ensure low latency.
   */
  async runPriority<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire(true); // Enforce strict lock, but jump to the front of the waitlist!
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}
