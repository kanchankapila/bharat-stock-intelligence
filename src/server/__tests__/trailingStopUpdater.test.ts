/**
 * AF-20261117: the updater overwrote recommendation_log.stop_loss in place, so the resolver
 * graded with the final ratcheted stop as `initial_stop` from bar 1 (look-ahead) and booked
 * trailed winners as STOP_LOSS -> LOSS (6,239 BUY rows). The published stop must stay
 * immutable; the trail lives in trailing_stop and is anchored on bars AFTER the signal date.
 */
import { vi, describe, test, expect, beforeEach } from 'vitest';

const runs: Array<{ sql: string; params: unknown[] }> = [];
const reads: Array<{ sql: string; params: unknown[] }> = [];

vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async (sql: string, params: unknown[] = []) => {
    reads.push({ sql, params });
    if (sql.includes('FROM recommendation_log')) {
      return [{ id: 7, symbol: 'ABC', signal_date: '2026-11-03', entry_price: 100, stop_loss: 95, trailing_stop: null }];
    }
    if (sql.includes('ORDER BY date DESC')) {
      return Array.from({ length: 20 }, () => ({ date: 'x', high: 121, low: 119, close: 120 }));
    }
    return [{ high: 125 }];
  }),
  dbRun: vi.fn(async (sql: string, params: unknown[]) => { runs.push({ sql, params }); }),
}));

import { updateTrailingStops } from '../trailingStopUpdater';

describe('updateTrailingStops', () => {
  beforeEach(() => { runs.length = 0; reads.length = 0; });

  test('ratchets trailing_stop and never rewrites the published stop_loss', async () => {
    const res = await updateTrailingStops();
    expect(res.updated).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/SET trailing_stop = \?/);
    expect(runs[0].sql).not.toMatch(/stop_loss\s*=/);
    expect(runs[0].params).toEqual([119, 7]); // 125 - 3 * ATR(2)
  });

  test('chandelier anchor excludes the signal-day (pre-entry) bar', async () => {
    await updateTrailingStops();
    const anchor = reads.find(r => r.sql.includes('SELECT high FROM stock_ohlcv'));
    expect(anchor?.sql).toMatch(/date > \?/);
    expect(anchor?.params).toEqual(['ABC', '2026-11-03']);
  });

  test('ratchets from the existing trail, not from the published stop', async () => {
    const { dbAll } = await import('../dbAsync');
    (dbAll as any).mockImplementationOnce(async () => [
      { id: 7, symbol: 'ABC', signal_date: '2026-11-03', entry_price: 100, stop_loss: 95, trailing_stop: 119.5 },
    ]);
    const res = await updateTrailingStops();
    expect(res.updated).toBe(0);
  });
});
