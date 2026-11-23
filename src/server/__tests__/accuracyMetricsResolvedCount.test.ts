import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20260930-40: the dashboard "Win Rate" tile printed `${totalSignals} signals resolved`, but
// totalSignals was COUNT(*) -- PENDING rows included (live: 440,335 shown vs 438,940 resolved).
// V-09 (2026-10-08): it also counted NEUTRAL in the denominator, pooled the 1/5/15d horizons, and
// mixed in short-geometry rows (target < stop) -- 111,665 of which were graded by a LONG-only
// simulation (AF-20261008-10). 2026-11-20: the headline is the trade win rate (net, direction-signed
// return > 0 over every resolved outcome) per side; the decisive-label rate is kept as a diagnostic.
describe('getAccuracyMetrics', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM unified_signal_outcomes`);
    await dbRun(`DELETE FROM unified_signals`);
    // [id, target, stop] -- target > stop is a long, target < stop a short, NULLs unknown side.
    // Explicit fixture ids must not occupy the positive identity sequence. This file inserts
    // ids directly (so outcomes can reference them) but does not advance the sequence; using
    // 1..8 made the next unrelated auto-id insert collide with unified_signals_pkey in the full
    // suite. Negative ids are valid BIGINT fixture keys and cannot collide with production-like
    // generated identities.
    const signals: Array<[number, number | null, number | null]> = [
      [-1, 110, 95], [-2, 110, 95], [-3, 110, 95], [-4, 110, 95], [-5, 110, 95],
      [-6, 90, 105], [-7, 90, 105], [-8, null, null],
    ];
    // Batch fixture rows: per-row autocommit made this setup fsync-bound on the shared test
    // host. Preserve every case and the original time budgets instead of relaxing assertions.
    await dbRun(
      `INSERT INTO unified_signals (id, symbol, signal_source, signal_type, target_price, stop_loss, signal_generated_at)
       VALUES ${signals.map(() => "(?, ?, 'technical', 'X', ?, ?, '2026-09-01T10:00:00Z')").join(',')}`,
      signals.flatMap(([id, target, stop]) => [id, `ACCM${id}`, target, stop]),
    );
    const outcomes: Array<[number, number, string, number | null]> = [
      [-1, 15, 'WIN', 4], [-2, 15, 'LOSS', -2], [-3, 15, 'STOP_LOSS', -5], [-4, 15, 'NEUTRAL', 0],
      [-5, 15, 'PENDING', null],
      [-6, 15, 'WIN', 6], [-7, 15, 'STOP_LOSS', 4],   // short side: excluded
      [-8, 15, 'WIN', 3],                              // unknown side: excluded
      [-1, 5, 'WIN', 2], [-2, 5, 'WIN', 2],            // other horizon: excluded
    ];
    await dbRun(
      `INSERT INTO unified_signal_outcomes
         (unified_signal_id, symbol, signal_date, signal_source, horizon_days, entry_price, entry_time,
          outcome, return_pct, check_date)
       VALUES ${outcomes.map(() => "(?, ?, '2026-09-01', 'technical', ?, 100, '2026-09-01T10:00:00Z', ?, ?, '2026-09-22')").join(',')}`,
      outcomes.flatMap(([id, h, outcome, ret]) => [id, `ACCM${id}`, h, outcome, ret]),
    );
  });

  it('grades each side as trades: net return > 0 over every resolved outcome, label rate kept separately', async () => {
    const m = await caller.getAccuracyMetrics();
    expect(m.horizonDays).toBe(15);
    const L = m.long;
    expect(L.totalSignals).toBe(5);              // PENDING counted in the total only
    expect(L.resolvedSignals).toBe(4);           // NEUTRAL is a trade that was taken
    expect(L.profitableSignals).toBe(1);         // only the +4% trade made money
    expect(L.netProfitRate).toBeCloseTo(25, 5);
    expect(L.avgNetReturnPct).toBeCloseTo(-0.75, 5);
    expect(L.avgWinPct).toBeCloseTo(4, 5);
    expect(L.avgLossPct).toBeCloseTo(-7 / 3, 5);
    expect(L.labelWins).toBe(1);
    expect(L.decisiveSignals).toBe(3);
    expect(L.neutralSignals).toBe(1);
    expect(L.labelWinRate).toBeCloseTo(100 / 3, 5);
    expect(String(L.asOf)).toContain('2026-09-22');
    // SHORT geometry (target below stop): return_pct is direction-signed by the resolver, so both made money.
    expect(m.short.resolvedSignals).toBe(2);
    expect(m.short.profitableSignals).toBe(2);
    expect(m.short.netProfitRate).toBeCloseTo(100, 5);
    expect(m.short.labelWinRate).toBeCloseTo(50, 5);
  });
});
