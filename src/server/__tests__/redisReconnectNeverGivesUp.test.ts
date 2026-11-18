import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// AF-20261114-02: Redis was down 42s during a Docker restart (2026-11-13 22:29:15..22:29:57).
// Every BullMQ connection had `if (times > 20) return null` (~42s of retries), gave up for good,
// and no job ran for 13.4h while the server stayed up (heartbeats, Telegram), so pm2 never
// restarted it. A connection that returns null from retryStrategy never reconnects.

describe('Redis reconnect delay', () => {
  it('never gives up, and stays bounded', async () => {
    const { redisReconnectDelay } = await import('../redisRetry');
    for (const t of [1, 10, 20, 21, 100, 10_000]) {
      const d = redisReconnectDelay(t);
      expect(d).not.toBeNull();
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(5_200);
    }
  });

  it('is the strategy every long-lived connection uses; only the startup probe may fail fast', () => {
    for (const file of ['queues.ts', 'cacheService.ts']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      const strategies = [...src.matchAll(/retryStrategy:\s*([^,\n]+)/g)].map((m) => m[1].trim());
      expect(strategies.length, `${file} has no retryStrategy`).toBeGreaterThan(0);
      for (const s of strategies) {
        expect(['redisReconnectDelay', '() => null'], `${file}: retryStrategy: ${s}`).toContain(s);
      }
    }
    const queues = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
    expect(queues.match(/retryStrategy:\s*\(\)\s*=>\s*null/g)?.length ?? 0).toBe(1);
    expect(queues).toMatch(/if \(isProbe\)[\s\S]{0,300}retryStrategy: \(\) => null/);
  });
});
