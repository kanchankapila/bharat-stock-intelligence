import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20261001-38: both recommendation_log readers filtered `outcome IS NOT NULL`, and 'PENDING'
// is not NULL -- live 2026-10-01, 11,268 of 64,914 such rows (17%) were ungraded, plus 868
// expiry-fabricated flat NEUTRALs with no exit price, all counted as closed trades. The report
// card additionally hardcoded `15 AS horizon_days` over a signal_outcomes population pooling
// h1+h5+h15, labelling a mostly-h1 number as h15.
describe('ml.router resolved populations exclude PENDING and fabricated labels', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM recommendation_log WHERE symbol LIKE 'MLRT%'`);
    await dbRun(`DELETE FROM signal_outcomes WHERE symbol LIKE 'MLRT%'`);
  });

  const rec = (symbol: string, outcome: string, ret: number | null, exit: number | null) =>
    dbRun(`INSERT INTO recommendation_log
      (symbol, rec_type, signal_date, generated_at, entry_price, outcome, actual_return_pct,
       actual_exit_price, status, source, horizon_days)
      VALUES (?, 'BUY', '2020-01-01', CURRENT_TIMESTAMP, 100, ?, ?, ?, 'RESOLVED', 'scoring_engine', 15)`,
      [symbol, outcome, ret, exit]);

  it('getSignalQualityReport counts only graded recommendations', async () => {
    await rec('MLRT1', 'WIN', 4, 104);
    await rec('MLRT2', 'PENDING', null, null);
    await rec('MLRT3', 'NEUTRAL', 0, null);      // expiry-fabricated flat label
    const res = await caller.getSignalQualityReport({ horizonDays: 15 }) as any;
    expect(Number(res.recommendationStats.total)).toBe(1);
    expect(Number(res.recommendationStats.wins)).toBe(1);
  });

  it('getSignalReportCard reports each horizon under its own label', async () => {
    await rec('MLRT4', 'WIN', 4, 104);
    await rec('MLRT5', 'PENDING', null, null);
    // Horizons no sibling test writes (they use 1/5/15): this file shares one throwaway schema
    // with every other unit test, so a count scoped to a horizon someone else populates is a
    // flake, not an assertion.
    for (const [h, outcome] of [[21, 'LOSS'], [63, 'WIN']] as const) {
      await dbRun(`INSERT INTO signal_outcomes
        (symbol, signal_date, horizon_days, entry_price, exit_price, outcome, return_pct,
         signal_source, label_definition)
        VALUES (?, '2020-01-01', ?, 100, 104, ?, 4, 'technical', 'path_barrier')`,
        [`MLRT${h}H`, h, outcome]);
    }
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('MLRTP', '2020-01-01', 126, 100, 'PENDING', NULL, 'technical', 'path_barrier')`);

    const res = await caller.getSignalReportCard({ horizonDays: 15 }) as any;
    const rows: any[] = res.outcomeSummary ?? [];
    const tech = rows.filter(r => r.signal_source === 'TECHNICAL');
    const horizons = tech.map(r => Number(r.horizon_days));
    // one row per horizon (the bug stamped a single hardcoded 15 on the pooled population)
    expect(new Set(horizons).size).toBe(horizons.length);
    expect(horizons).toContain(21);
    expect(horizons).toContain(63);
    expect(horizons).not.toContain(126);          // PENDING is not a closed trade
    for (const r of tech.filter(x => [21, 63].includes(Number(x.horizon_days)))) {
      expect(Number(r.total_outcomes)).toBe(1);
    }
    const recRow = rows.find(r => r.signal_source === 'RECOMMENDATION');
    expect(Number(recRow.total_outcomes)).toBe(1);
  });
});
