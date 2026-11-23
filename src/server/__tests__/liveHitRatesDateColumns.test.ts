import { describe, it, expect, beforeEach } from 'vitest';

const { dbTransaction } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// 2026-11-21: getLiveHitRates (LiveHitRates panel) failed every call with
// `function substr(date, integer, integer) does not exist` -- unified_signal_outcomes.signal_date and
// market_regimes.date are native DATE since the 2026-09-03 TEXT->DATE migration, and the query still
// cut substr(signal_date, 1, 10) for the regime join (and, from AF-20261119-13, the window count). No test
// exercised the SQL, so the panel showed nothing while the suite stayed green.
describe('getLiveHitRates reads native DATE columns', () => {
  beforeEach(async () => {
    if (!process.env.VITEST_PG_SCHEMA?.startsWith('vitest_')) {
      throw new Error('getLiveHitRates fixtures require a private Vitest schema');
    }
    await dbTransaction(async tx => {
      await tx.run(`DELETE FROM unified_signal_outcomes WHERE symbol IN ('LHRDATE', 'LHRSHORT')`);
      await tx.run(`DELETE FROM unified_signals WHERE symbol IN ('LHRDATE', 'LHRSHORT')`);
      await tx.run(`DELETE FROM market_regimes WHERE date = '2026-11-02'`);
    });
  });

  it('counts signal dates and joins the regime on the DATE column', async () => {
    await dbTransaction(async tx => {
      await tx.run(`INSERT INTO market_regimes (date, regime) VALUES ('2026-11-02', 'LHR_TEST_REGIME')`);
      await tx.run(`INSERT INTO unified_signals (id, symbol, signal_source, signal_type, signal_generated_at, target_price, stop_loss)
                    VALUES (987654321, 'LHRDATE', 'lhr_test', 'BUY', '2026-11-02 10:00:00+05:30', 110, 95)`);
      await tx.run(`INSERT INTO unified_signal_outcomes
                    (id, unified_signal_id, symbol, signal_date, signal_source, horizon_days, entry_price, entry_time, outcome, return_pct)
                    VALUES (987654321, 987654321, 'LHRDATE', '2026-11-02', 'lhr_test', 5, 100, '2026-11-02 10:00:00+05:30', 'WIN', 3.5)`);
    });
    const res = await caller.getLiveHitRates({ days: 1825, minSignals: 1, side: 'LONG' }) as any;
    const mine = res.bySource.find((r: any) => r.signal_source === 'lhr_test');
    expect(mine, 'seeded source missing from bySource').toBeDefined();
    expect(Number(mine.total)).toBe(1);
    expect(Number(mine.dates)).toBe(1);
    expect(res.byRegime.some((r: any) => r.regime === 'LHR_TEST_REGIME')).toBe(true);
  });

  // AF-20261120-03: longs and shorts are different trades, so each call reads one side (target above stop =
  // long, below = short). A short's return_pct is direction-signed, so a falling price is a profitable trade.
  it('reads one side per call and counts a profitable short as a trade win', async () => {
    await dbTransaction(async tx => {
      await tx.run(`INSERT INTO unified_signals (id, symbol, signal_source, signal_type, signal_generated_at, target_price, stop_loss)
                    VALUES (987654322, 'LHRSHORT', 'lhr_side', 'SELL', '2026-11-02 10:00:00+05:30', 90, 105),
                           (987654323, 'LHRSHORT', 'lhr_side', 'BUY',  '2026-11-02 10:00:00+05:30', 110, 95)`);
      await tx.run(`INSERT INTO unified_signal_outcomes
                    (id, unified_signal_id, symbol, signal_date, signal_source, horizon_days, entry_price, entry_time, outcome, return_pct)
                    VALUES (987654322, 987654322, 'LHRSHORT', '2026-11-02', 'lhr_side', 5, 100, '2026-11-02 10:00:00+05:30', 'NEUTRAL', 1.2),
                           (987654323, 987654323, 'LHRSHORT', '2026-11-02', 'lhr_side', 5, 100, '2026-11-02 10:00:00+05:30', 'LOSS', -2.0)`);
    });
    const short = (await caller.getLiveHitRates({ days: 1825, minSignals: 1, side: 'SHORT' }) as any)
      .bySource.find((r: any) => r.signal_source === 'lhr_side');
    const long = (await caller.getLiveHitRates({ days: 1825, minSignals: 1, side: 'LONG' }) as any)
      .bySource.find((r: any) => r.signal_source === 'lhr_side');
    expect(Number(short.total)).toBe(1);
    expect(Number(short.profitable)).toBe(1);          // the label says NEUTRAL; the trade made 1.2% net
    expect(Number(short.profitable_rate)).toBe(100);
    expect(short.profitable_ci_lo).not.toBeNull();
    expect(Number(long.total)).toBe(1);
    expect(Number(long.profitable)).toBe(0);
  });
});
