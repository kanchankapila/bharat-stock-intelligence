import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20260930-40: the dashboard "Win Rate" tile printed `${totalSignals} signals resolved`, but
// totalSignals was COUNT(*) -- PENDING rows included (live: 440,335 shown vs 438,940 resolved).
// V-09 (2026-10-08): it also counted NEUTRAL in the denominator, pooled the 1/5/15d horizons, and
// mixed in short-geometry rows (target < stop) -- 111,665 of which were graded by a LONG-only
// simulation (AF-20261008-10). The tile is now LONG-only, 15d, decisive outcomes only.
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
    for (const [id, target, stop] of signals) {
      await dbRun(
        `INSERT INTO unified_signals (id, symbol, signal_source, signal_type, target_price, stop_loss, signal_generated_at)
         VALUES (?, ?, 'technical', 'X', ?, ?, '2026-09-01T10:00:00Z')`,
        [id, `ACCM${id}`, target, stop],
      );
    }
    const outcomes: Array<[number, number, string, number | null]> = [
      [-1, 15, 'WIN', 4], [-2, 15, 'LOSS', -2], [-3, 15, 'STOP_LOSS', -5], [-4, 15, 'NEUTRAL', 0],
      [-5, 15, 'PENDING', null],
      [-6, 15, 'WIN', 6], [-7, 15, 'STOP_LOSS', 4],   // short side: excluded
      [-8, 15, 'WIN', 3],                              // unknown side: excluded
      [-1, 5, 'WIN', 2], [-2, 5, 'WIN', 2],            // other horizon: excluded
    ];
    for (const [id, h, outcome, ret] of outcomes) {
      await dbRun(
        `INSERT INTO unified_signal_outcomes
           (unified_signal_id, symbol, signal_date, signal_source, horizon_days, entry_price, entry_time,
            outcome, return_pct, check_date)
         VALUES (?, ?, '2026-09-01', 'technical', ?, 100, '2026-09-01T10:00:00Z', ?, ?, '2026-09-22')`,
        [id, `ACCM${id}`, h, outcome, ret],
      );
    }
  });

  it('reports a LONG-only 15d win rate over decisive outcomes, NEUTRAL shown separately', async () => {
    const m = await caller.getAccuracyMetrics();
    expect(m.side).toBe('LONG');
    expect(m.horizonDays).toBe(15);
    expect(m.wins).toBe(1);
    expect(m.decisiveSignals).toBe(3);
    expect(m.neutralSignals).toBe(1);
    expect(m.profitHitRate).toBeCloseTo(100 / 3, 5);
    expect(m.resolvedSignals).toBe(4);
    expect(m.totalSignals).toBe(5);
    expect(m.avgGrossReturnPct).toBeCloseTo(-0.75, 5);
    expect(String(m.asOf)).toContain('2026-09-22');
  });
});
