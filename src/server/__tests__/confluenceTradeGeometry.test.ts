import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AF-20261001-20/-21: confluence trade geometry.
 *
 * (1) The "atr" fed to buildTradeSetup was `price * bb_width / 100`. technical_signals.bb_width
 *     is a FRACTION (median 0.126 live, 2026-10-01), and Bollinger width is not ATR anyway, so
 *     the value was ~0.13% of price against a true 14-day ATR median of 3.7% -- every stop fell
 *     to the 2% floor (1,344 of 1,361 setups in the 2026-10-01 run).
 * (2) risk_reward was reported to target_2 while target_1 sat at half that distance.
 * (3) Stop distance ignored the holding horizon (same daily-ATR stop for INTRADAY and POSITIONAL).
 */

let upserted: unknown[][] = [];
let ohlcvBars: Array<{ symbol: string; date: string; high: number; low: number; close: number }> = [];
let techRow: Record<string, unknown> = {};

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => ({ regime: 'BULL' })),
  dbTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  dbAll: vi.fn(async (sql: string) => {
    if (sql.includes('trendlyne_screener_stocks')) {
      return [{ symbol: 'ABC', screener_id: '1', screener_name: 'Range breakout' }];
    }
    if (sql.includes('FROM technical_signals')) return [techRow];
    if (sql.includes('high, low, close')) return ohlcvBars;
    return [];
  }),
}));
vi.mock('../dbBulk', () => ({
  rowGroups: () => '',
  bulkUpsert: vi.fn(async (_tx: unknown, rows: unknown[][]) => { upserted = rows; }),
}));
vi.mock('../pythonRunner', () => ({ runPython: vi.fn() }));

import { buildTradeSetup, computeConfluenceSignals, HOLDING_SESSIONS } from '../confluenceEngine';
import { wilderATR } from '../atrBarriers';

// col indexes in confluence_signals INSERT order
const COL = { timeframe: 14, stop: 18, t1: 19, t2: 20, rr: 22, price: 25, atr: 28 };

describe('buildTradeSetup', () => {
  it('reports risk_reward to target_1, not target_2', () => {
    for (const tf of ['INTRADAY', 'SWING', 'POSITIONAL']) {
      for (const score of [50, 70, 90]) {
        const s = buildTradeSetup(100, 4, score, tf);
        const rrT1 = (s.target1 - 100) / (100 - s.stopLoss);
        expect(s.riskReward).toBeCloseTo(rrT1, 1);
      }
    }
  });

  it('scales the stop with sqrt(holding sessions): 1.5 ATR at SWING (5 sessions)', () => {
    const atr = 4;
    const stopDist = (tf: string) => 100 - buildTradeSetup(100, atr, 70, tf).stopLoss;
    expect(stopDist('SWING')).toBeCloseTo(1.5 * atr, 1);
    expect(stopDist('INTRADAY')).toBeCloseTo(1.5 * atr * Math.sqrt(HOLDING_SESSIONS.INTRADAY / 5), 1);
    expect(stopDist('POSITIONAL')).toBeCloseTo(1.5 * atr * Math.sqrt(HOLDING_SESSIONS.POSITIONAL / 5), 1);
    expect(stopDist('INTRADAY')).toBeLessThan(stopDist('SWING'));
    expect(stopDist('SWING')).toBeLessThan(stopDist('POSITIONAL'));
  });
});

describe('computeConfluenceSignals geometry inputs', () => {
  beforeEach(() => {
    upserted = [];
    // 30 sessions, constant 4-point true range around a 100 close
    ohlcvBars = Array.from({ length: 30 }, (_, i) => ({
      symbol: 'ABC', date: `2026-09-${String(i + 1).padStart(2, '0')}`, high: 102, low: 98, close: 100,
    }));
    techRow = { symbol: 'ABC', cmp: 100, bb_width: 0.126, volume_ratio: 1, rsi: 55, rn: 1 };
  });

  it('uses the true Wilder ATR from stock_ohlcv, not bb_width', async () => {
    await computeConfluenceSignals();
    expect(upserted).toHaveLength(1);
    const row = upserted[0];
    const expectedAtr = wilderATR(ohlcvBars);
    expect(expectedAtr).toBeCloseTo(4, 6);
    expect(row[COL.atr]).toBeCloseTo(expectedAtr, 4);
    // stop is ATR-derived, not the 2%-of-price floor the bogus 0.126%-of-price "atr" collapsed to
    const tf = row[COL.timeframe] as string;
    const expectedStopDist = 1.5 * expectedAtr * Math.sqrt(HOLDING_SESSIONS[tf] / 5);
    expect(100 - (row[COL.stop] as number)).toBeCloseTo(expectedStopDist, 1);
  });

  it('writes no geometry (and no fabricated atr) when there is no OHLCV history', async () => {
    ohlcvBars = [];
    await computeConfluenceSignals();
    const row = upserted[0];
    expect(row[COL.atr]).toBeNull();
    expect(row[COL.stop]).toBeNull();
    expect(row[COL.rr]).toBeNull();
  });
});
