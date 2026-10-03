import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20260930-40: the dashboard "Win Rate" tile printed `${totalSignals} signals resolved`, but
// totalSignals was COUNT(*) -- PENDING rows included (live: 440,335 shown vs 438,940 resolved).
describe('getAccuracyMetrics', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM unified_signal_outcomes`);
    const rows: Array<[string, string | null]> = [
      ['ACCM1', 'WIN'], ['ACCM2', 'LOSS'], ['ACCM3', 'STOP_LOSS'], ['ACCM4', 'NEUTRAL'],
      ['ACCM5', 'PENDING'], ['ACCM6', 'PENDING'],
    ];
    for (const [i, [symbol, outcome]] of rows.entries()) {
      await dbRun(
        `INSERT INTO unified_signal_outcomes
           (unified_signal_id, symbol, signal_date, signal_source, horizon_days, entry_price, entry_time, outcome)
         VALUES (?, ?, '2026-09-01', 'technical', 5, 100, '2026-09-01T10:00:00Z', ?)`,
        [i + 1, symbol, outcome],
      );
    }
  });

  it('reports resolved signals separately from pending ones', async () => {
    const m = await caller.getAccuracyMetrics();
    expect(m.resolvedSignals).toBe(4);
    expect(m.totalSignals).toBe(6);
    expect(m.profitHitRate).toBeCloseTo(25, 5);
  });
});
