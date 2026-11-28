import fs from 'fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// liveQuotes.ts readers (plan alerts, Best Picks, screener cards) see an empty cache
// whenever nothing refills it before it expires. Measured 2026-11-27: empty 62-68% of the session.
describe('live quote cache stays filled during market hours', () => {
  it('starts the periodic refresh whether or not BullMQ is up', () => {
    const server = read('../../../server.ts');
    const start = server.indexOf('startBackgroundRefresh();');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(server.indexOf('if (!bullmqReady) {'));
  });

  it('keeps a market-hours snapshot longer than the refresh interval', () => {
    const src = read('../liveStockData.ts');
    expect(src).toContain('const BULK_REFRESH_INTERVAL = BULK_TTL * 1000;');
    expect(src).toMatch(/const ttl = marketOpen \? BULK_TTL \+ \d+ :/);
  });
});
