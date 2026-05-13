export class Semaphore {
  private tasks: (() => void)[] = [];
  private count: number;

  constructor(count: number) {
    this.count = count;
  }

  async acquire() {
    return new Promise<void>((resolve) => {
      if (this.count > 0) {
        this.count--;
        resolve();
      } else {
        this.tasks.push(resolve);
      }
    });
  }

  release() {
    this.count++;
    const next = this.tasks.shift();
    if (next) {
      this.count--;
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
}
