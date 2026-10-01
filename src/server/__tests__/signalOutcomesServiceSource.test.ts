import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
const { getWinRateStats } = await import('../signalOutcomesService');

beforeEach(async () => {
  for (const table of ['signal_outcomes', 'technical_signals', 'stock_ohlcv']) {

    await dbExec(`DELETE FROM ${table}`);

  }
});

// AF-20260930-31: this module used to hold a SECOND grader (computeSignalOutcomes, scheduled as
// 'signal-outcomes-daily') for the same (symbol, signal_date, horizon_days, 'technical') key as
// outcome_resolver.py, under a peak-excursion rule with no costs: 55.5% h5 win rate vs the
// resolver's 6.2%, and whichever job reached a row first owned its label. One key, one grader.
describe('signal_outcomes technical has a single grader', () => {
  it('signalOutcomesService no longer grades, and nothing schedules it', async () => {
    const mod = await import('../signalOutcomesService') as Record<string, unknown>;
    expect(mod.computeSignalOutcomes).toBeUndefined();
    const { JOB_REGISTRY } = await import('../jobRegistry') as any;
    expect((JOB_REGISTRY ?? []).map((j: any) => j.jobName)).not.toContain('signal-outcomes');
  });
});

describe('getWinRateStats scopes to one signal_source AND one label_definition', () => {
  it('excludes confluence-sourced outcomes from the win-rate report', async () => {
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, exit_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('DDD', '2020-01-01', 5, 100, 101, 'WIN', 5.0, 'technical', 'path_barrier')`);
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, exit_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('EEE', '2020-01-01', 5, 100, 101, 'LOSS', -5.0, 'confluence', 'terminal_pct2')`);

    const stats = await getWinRateStats();

    expect(stats.overall.total).toBe(1);
    expect(stats.overall.wins).toBe(1);
  });

  // Regression for the contamination found live 2026-08-15: signal_source='technical' was NOT
  // label-uniform. 1,722 unlabeled rows (written by this service, which never stamped the
  // column) sat at a 99.4% win rate inside the same date range as 198,723 labeled path_barrier
  // rows at 68.7%. Filtering on signal_source alone let them blend into the headline number.
  it('excludes technical rows with a NULL label_definition', async () => {
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, exit_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('FFF', '2020-01-02', 5, 100, 101, 'WIN', 5.0, 'technical', 'path_barrier')`);
    // Same source, no label — the shape that was silently inflating the win rate.
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, exit_price, outcome, return_pct, signal_source)
      VALUES ('GGG', '2020-01-02', 5, 100, 101, 'WIN', 99.0, 'technical')`);

    const stats = await getWinRateStats();

    expect(stats.overall.total).toBe(1);
    expect(stats.labelDefinition).toBe('path_barrier');
  });
});

// AF-20261001-35: the report was "latest 2000 rows, all horizons pooled". At ~2,170 technical
// signals/day the newest 2000 rows were ONE day of h1 labels (live 2026-10-01: 1,999 h1 rows,
// all 2026-09-29, 9.5% "win rate"), so the headline was a single overlapping h1 cross-section
// while byHorizon[5]/[15] read empty -- and expiry-fabricated NEUTRAL 0.0% rows (no exit price)
// were counted as trades.
describe('getWinRateStats is horizon-explicit and counts only real exits', () => {
  const ins = (sym: string, d: string, h: number, outcome: string, ret: number | null, exit: number | null) =>
    dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, exit_price, outcome, return_pct, signal_source, label_definition)
      VALUES (?, ?, ?, 100, ?, ?, ?, 'technical', 'path_barrier')`, [sym, d, h, exit, outcome, ret]);

  it('headline is one stated horizon, not whichever horizon filled the newest rows', async () => {
    await ins('A', '2020-01-01', 5, 'WIN', 4, 104);
    for (let i = 0; i < 5; i++) await ins(`H${i}`, '2020-01-10', 1, 'LOSS', -2, 98);
    const s = await getWinRateStats() as any;
    expect(s.overallHorizonDays).toBe(5);
    expect(s.overall.total).toBe(1);
    expect(s.overall.wins).toBe(1);
    expect(s.byHorizon[1].total).toBe(5);
    expect(s.byHorizon[5].total).toBe(1);
  });

  it('excludes rows with no exit price (fabricated flat labels)', async () => {
    await ins('B', '2020-01-01', 5, 'WIN', 4, 104);
    await ins('C', '2020-01-01', 5, 'NEUTRAL', 0, null);
    const s = await getWinRateStats();
    expect(s.overall.total).toBe(1);
  });
});
