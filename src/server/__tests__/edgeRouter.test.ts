import { beforeEach, describe, expect, it } from 'vitest';

const { dbTransaction } = await import('../dbAsync');
if (!process.env.VITEST_PG_SCHEMA?.startsWith('vitest_')) {
  throw new Error('Edge-router fixtures require a private Vitest schema');
}
import { createCallerFactory } from '../trpc';
const { appRouter } = await import('../router');
const caller = createCallerFactory(appRouter)({} as any);
const { diffSnapshots, planFirstTouch, objectiveRegime } = await import('../routers/edge.router');

// --- 1. getEdgeStatus --------------------------------------------------------------------------
describe('getEdgeStatus', () => {
  beforeEach(async () => {
    await dbTransaction(async tx => {
      await tx.run(`DELETE FROM app_settings WHERE key IN ('forward_test_report','accuracy_scorecard','forward_test_protocol')`);
    });
  });

  it('returns nulls (not a fabricated verdict) when nothing has been persisted', async () => {
    const r = await caller.getEdgeStatus();
    expect(r.forwardTest).toBeNull();
    expect(r.scorecard).toBeNull();
    expect(r.forwardTestAsOf).toBeNull();
  });

  it('parses the Python report even though it carries bare NaN, and returns as-of + calendar block', async () => {
    const value = '{"protocol_hash": "13210b4e2c3ae688", "generated_at": "2026-10-08T21:27:09", "blocks": {"forward": '
      + '{"since": "2026-10-06", "calls": 4650, "sessions": 2, "tiers": {"5": [{"tier": "published", "coverage_pct": null, '
      + '"dates": 0, "eff_dates": 0.0, "hit_rate": NaN, "verdict": "LOW-DATA"}]}}}}';
    await dbTransaction(async tx => {
      await tx.run(`INSERT INTO app_settings (key, value, "updatedAt")
        VALUES ('forward_test_report', ?, '2026-10-08T15:57:04Z'),
               ('accuracy_scorecard', '{"verdict":"LOW-DATA","n":12}', DEFAULT)`, [value]);
    });
    const r = await caller.getEdgeStatus();
    expect(r.forwardTest?.protocol_hash).toBe('13210b4e2c3ae688');
    expect(r.forwardTest?.blocks?.forward?.tiers?.['5']?.[0]?.hit_rate).toBeNull();
    expect(r.forwardTestAsOf).toMatch(/^2026-10-08/);
    expect(r.scorecard).toEqual({ verdict: 'LOW-DATA', n: 12 });
    expect(r.calendarBlockedUntil['5']).toBe('2027-02-23');
    expect(r.minIndependentWindows).toBe(20);
  });
});

// --- 2. getWhatChanged -------------------------------------------------------------------------
describe('diffSnapshots / getWhatChanged', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  it('finds new buys, drops, flips and expired plans', () => {
    const prev = [
      { symbol: 'A', classification: 'Buy', unified_score: 80, valid_until: '2026-10-08T10:00:00Z' },
      { symbol: 'B', classification: 'Strong Buy', unified_score: 90, valid_until: '2026-10-20T10:00:00Z' },
      { symbol: 'C', classification: 'Hold', unified_score: 50, valid_until: null },
    ];
    const latest = [
      { symbol: 'A', classification: 'Buy', unified_score: 81, valid_until: null },
      { symbol: 'B', classification: 'Hold', unified_score: 60, valid_until: null },
      { symbol: 'C', classification: 'Buy', unified_score: 70, valid_until: null },
      { symbol: 'D', classification: 'Strong Buy', unified_score: 95, valid_until: null },
    ];
    const d = diffSnapshots(prev, latest, now);
    expect(d.newBuys.map(r => r.symbol).sort()).toEqual(['C', 'D']);
    expect(d.dropped.map(r => r.symbol)).toEqual(['B']);
    expect(d.flips.map(r => `${r.symbol}:${r.from}->${r.to}`).sort()).toEqual(['B:Strong Buy->Hold', 'C:Hold->Buy']);
    expect(d.expiredPlans.map(r => r.symbol)).toEqual(['A']);
  });

  it('compares the latest two computed_at snapshots in the table', async () => {
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM unified_recommendations');
      await tx.run(`INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level, classification)
        VALUES ('OLDONLY', '2026-10-06', 'BEAR', 70, 'A_HIGH', 'Buy'),
               ('X', '2026-10-07', 'BEAR', 70, 'A_HIGH', 'Buy'),
               ('X', '2026-10-08', 'BEAR', 70, 'A_HIGH', 'Hold'),
               ('Y', '2026-10-08', 'BEAR', 70, 'A_HIGH', 'Strong Buy')`);
    });
    const r = await caller.getWhatChanged();
    expect(r.latest).toBe('2026-10-08');
    expect(r.previous).toBe('2026-10-07');
    expect(r.newBuys.map(x => x.symbol)).toEqual(['Y']);
    expect(r.dropped.map(x => x.symbol)).toEqual(['X']);
    expect(r.counts.latestBuys).toBe(1);
  });
});

// --- 4. getReliabilityCurve --------------------------------------------------------------------
describe('getReliabilityCurve', () => {
  beforeEach(async () => {
    await dbTransaction(async tx => {
      await tx.run(`DELETE FROM signal_outcomes`);
      await tx.run(`DELETE FROM technical_signals`);
    });
  });

  it('bins calibrated probability vs decisive realised hit rate, with n, base rate and Brier', async () => {
    const rows: [string, number, string, number, number][] = [
      ['P1', 0.35, 'LOSS', -2, 5], ['P2', 0.32, 'WIN', 3, 5],
      ['P3', 0.75, 'WIN', 4, 5], ['P4', 0.78, 'STOP_LOSS', -5, 5],
      ['P5', 0.71, 'NEUTRAL', 0.1, 5],  // not decisive: excluded from hit-rate bins
      ['P6', 0.71, 'PENDING', 0, 5],    // unresolved: excluded everywhere
      ['P7', 0.9, 'WIN', 1, 15],        // other horizon: excluded
    ];
    await dbTransaction(async tx => {
      await tx.run(`INSERT INTO technical_signals (symbol, date, calibrated_win_probability)
        VALUES ${rows.map(() => '(?, CURRENT_DATE - 10, ?)').join(',')}
        ON CONFLICT (symbol, date) DO NOTHING`, rows.flatMap(([sym, p]) => [sym, p]));
      await tx.run(`INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source)
        VALUES ${rows.map(() => "(?, CURRENT_DATE - 10, ?, 100, ?, ?, 'technical')").join(',')}`,
        rows.flatMap(([sym, , outcome, ret, h]) => [sym, h, outcome, ret]));
    });
    const r = await caller.getReliabilityCurve();
    expect(r.n).toBe(4);
    expect(r.baseRate).toBeCloseTo(0.5, 6);
    const b4 = r.bins.find(b => b.bin === 4)!;     // [0.3, 0.4)
    const b8 = r.bins.find(b => b.bin === 8)!;     // [0.7, 0.8)
    expect(b4.n).toBe(2); expect(b4.realised).toBeCloseTo(0.5, 6); expect(b4.predicted).toBeCloseTo(0.335, 6);
    expect(b8.n).toBe(2); expect(b8.realised).toBeCloseTo(0.5, 6);
    // Brier = mean((p - y)^2) over the 4 decisive rows
    const brier = ((0.35 - 0) ** 2 + (0.32 - 1) ** 2 + (0.75 - 1) ** 2 + (0.78 - 0) ** 2) / 4;
    expect(r.brier).toBeCloseTo(brier, 6);
    // Deciles use every resolved row (NEUTRAL included), not PENDING
    expect(r.deciles.reduce((s, d) => s + d.n, 0)).toBe(5);
  });
});

// --- 5. getPlanTimeline ------------------------------------------------------------------------
describe('planFirstTouch / getPlanTimeline', () => {
  const plan = { computed_at: '2026-10-01', valid_until: '2026-10-06T10:00:00Z', stop_loss: 95, target_1: 110 };
  it('reports T1 when the target is touched before the stop', () => {
    const bars = [{ date: '2026-10-02', high: 105, low: 98 }, { date: '2026-10-03', high: 111, low: 99 }];
    expect(planFirstTouch(plan, bars, new Date('2026-10-09'))).toEqual({ result: 'T1', date: '2026-10-03' });
  });
  it('counts a bar touching both as a stop (conservative) and ignores the plan day itself', () => {
    const bars = [{ date: '2026-10-01', high: 200, low: 99 }, { date: '2026-10-02', high: 112, low: 94 }];
    expect(planFirstTouch(plan, bars, new Date('2026-10-09')).result).toBe('SL');
  });
  it('expires when neither level is touched inside the window, stays OPEN while the window is live', () => {
    const bars = [{ date: '2026-10-02', high: 105, low: 98 }, { date: '2026-10-07', high: 120, low: 90 }];
    expect(planFirstTouch(plan, bars, new Date('2026-10-09')).result).toBe('EXPIRED');
    expect(planFirstTouch(plan, bars.slice(0, 1), new Date('2026-10-03')).result).toBe('OPEN');
  });

  it('returns the plan history with first-touch and the same-day graded signal outcomes', async () => {
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM unified_recommendations');
      await tx.run(`DELETE FROM stock_ohlcv WHERE symbol = 'TLN'`);
      await tx.run(`DELETE FROM unified_signal_outcomes WHERE symbol = 'TLN'`);
      await tx.run(`INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level,
                   classification, stop_loss, target_1, valid_until)
                   VALUES ('TLN', '2026-10-01', 'BEAR', 80, 'A_HIGH', 'Buy', 95, 110, '2026-10-06T10:00:00Z')`);
      await tx.run(`INSERT INTO stock_ohlcv (symbol, date, high, low, close) VALUES ('TLN', '2026-10-02', 111, 99, 108)`);
      await tx.run(`INSERT INTO unified_signal_outcomes (unified_signal_id, symbol, signal_date, signal_source, horizon_days,
                   entry_price, entry_time, outcome, exit_reason, return_pct)
                   VALUES (1, 'TLN', '2026-10-01', 'technical', 5, 100, '2026-10-01T10:00:00Z', 'WIN', 'TIME_EXIT', 2.5)`);
    });
    const r = await caller.getPlanTimeline({ symbol: 'TLN' });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0].firstTouch).toEqual({ result: 'T1', date: '2026-10-02' });
    expect(r.plans[0].signalOutcomes[0]).toMatchObject({ outcome: 'WIN', signal_source: 'technical', horizon_days: 5 });
  });
});

// --- 6. getMarketPulse -------------------------------------------------------------------------
describe('objectiveRegime / getMarketPulse', () => {
  it('labels the index against its 200-session mean, and refuses with < 200 closes', () => {
    const up = Array.from({ length: 200 }, (_, i) => 100 - i * 0.1);     // newest first, rising tape
    expect(objectiveRegime(up)?.label).toBe('ABOVE 200D MEAN');
    expect(objectiveRegime(up.map(x => 200 - x))?.label).toBe('BELOW 200D MEAN');
    expect(objectiveRegime(up.slice(0, 150))).toBeNull();
  });

  it('computes A/D from stock_ohlcv, latest VIX and FII/DII with their as-of dates', async () => {
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM stock_ohlcv');
      await tx.run('DELETE FROM nse_stocks');
      await tx.run('DELETE FROM fii_dii_flow');
      await tx.run('DELETE FROM intraday_regime_history');
      await tx.run(`INSERT INTO nse_stocks (symbol, name) VALUES ('UP1','UP1'), ('UP2','UP2'), ('DN1','DN1')`);
      await tx.run(`INSERT INTO stock_ohlcv (symbol, date, close)
        VALUES ('UP1', CURRENT_DATE - 2, 10), ('UP1', CURRENT_DATE - 1, 11),
               ('UP2', CURRENT_DATE - 2, 10), ('UP2', CURRENT_DATE - 1, 12),
               ('DN1', CURRENT_DATE - 2, 10), ('DN1', CURRENT_DATE - 1, 9),
               ('NIFTY50', CURRENT_DATE - 2, 100), ('NIFTY50', CURRENT_DATE - 1, 50)`);
      await tx.run(`INSERT INTO fii_dii_flow (date, fii_net, dii_net) VALUES (CURRENT_DATE - 1, -12943.58, 10703.11)`);
      await tx.run(`INSERT INTO intraday_regime_history (computed_at, date, vix) VALUES ('2026-10-08 10:00:11+00', CURRENT_DATE - 1, 15.24)`);
    });
    const r = await caller.getMarketPulse();
    expect(r.breadth).toMatchObject({ advances: 2, declines: 1, unchanged: 0 });
    expect(r.vix?.value).toBeCloseTo(15.24, 6);
    expect(r.fiiDii?.fii_net).toBeCloseTo(-12943.58, 2);
    expect(r.regime).toBeNull();   // 2 index closes only
    expect(r.regimeSessions).toBe(2);
  });
});
