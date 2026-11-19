/**
 * AF-20261117: the updater overwrote recommendation_log.stop_loss in place, so the resolver
 * graded with the final ratcheted stop as `initial_stop` from bar 1 (look-ahead) and booked
 * trailed winners as STOP_LOSS -> LOSS (6,239 BUY rows). The published stop must stay
 * immutable; the trail lives in trailing_stop and is anchored on bars AFTER the signal date.
 * AF-20261119-14: one bounded bar read for all positions (was two queries per position), and
 * STRONG_BUY plans are trailed too.
 */
import { vi, describe, test, expect, beforeEach } from 'vitest';

const runs: Array<{ sql: string; params: unknown[] }> = [];
const reads: Array<{ sql: string; params: unknown[] }> = [];
let positions: any[] = [];

// Signal day 2026-10-01 has a 200 high that must NOT become the anchor; then 35 sessions of
// (121, 119, 120) and a final 125 high. ATR uses the last 30 bars, which excludes the signal day.
const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);
const bars = (sym: string) => [
  { symbol: sym, date: day(0), high: 200, low: 99, close: 100 },
  ...Array.from({ length: 35 }, (_, i) => ({ symbol: sym, date: day(1 + i), high: 121, low: 119, close: 120 })),
  { symbol: sym, date: day(36), high: 125, low: 119, close: 120 },
];

vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async (sql: string, params: unknown[] = []) => {
    reads.push({ sql, params });
    if (sql.includes('FROM recommendation_log')) return positions;
    const syms = (params as string[]).slice(0, -1);
    return syms.flatMap(bars);
  }),
  dbRun: vi.fn(async (sql: string, params: unknown[]) => { runs.push({ sql, params }); }),
}));

import { updateTrailingStops } from '../trailingStopUpdater';
import { wilderATR } from '../atrBarriers';

const pos = (o: object = {}) => ({ id: 7, symbol: 'ABC', signal_date: '2026-10-01', entry_price: 100, stop_loss: 95, trailing_stop: null, ...o });

describe('updateTrailingStops', () => {
  beforeEach(() => { runs.length = 0; reads.length = 0; positions = [pos()]; });

  test('ratchets trailing_stop and never rewrites the published stop_loss', async () => {
    const res = await updateTrailingStops();
    expect(res.updated).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/SET trailing_stop = \?/);
    expect(runs[0].sql).not.toMatch(/stop_loss\s*=/);
    const atr = wilderATR(bars('ABC').slice(-30));
    // Anchor is 125, not the 200 signal-day high (pre-entry).
    expect(runs[0].params).toEqual([Math.round((125 - 3 * atr) * 100) / 100, 7]);
  });

  test('reads bars once for all positions, bounded by date', async () => {
    positions = [pos(), pos({ id: 8, symbol: 'XYZ' }), pos({ id: 9, symbol: 'ABC', signal_date: '2026-10-03' })];
    await updateTrailingStops();
    const barReads = reads.filter(r => r.sql.includes('FROM stock_ohlcv'));
    expect(barReads).toHaveLength(1);
    expect(barReads[0].sql).toMatch(/date >= \?/);
    expect(barReads[0].params.slice(0, -1)).toEqual(['ABC', 'XYZ']);
  });

  test('trails STRONG_BUY plans too', async () => {
    await updateTrailingStops();
    expect(reads[0].sql).toMatch(/rec_type IN \('BUY', 'STRONG_BUY'\)/);
  });

  test('ratchets from the existing trail, not from the published stop', async () => {
    positions = [pos({ trailing_stop: 119.5 })];
    const res = await updateTrailingStops();
    expect(res.updated).toBe(0);
  });
});
