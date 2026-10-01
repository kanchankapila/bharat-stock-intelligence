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
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('DDD', '2020-01-01', 5, 100, 'WIN', 5.0, 'technical', 'path_barrier')`);
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('EEE', '2020-01-01', 5, 100, 'LOSS', -5.0, 'confluence', 'terminal_pct2')`);

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
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('FFF', '2020-01-02', 5, 100, 'WIN', 5.0, 'technical', 'path_barrier')`);
    // Same source, no label — the shape that was silently inflating the win rate.
    await dbRun(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source)
      VALUES ('GGG', '2020-01-02', 5, 100, 'WIN', 99.0, 'technical')`);

    const stats = await getWinRateStats();

    expect(stats.overall.total).toBe(1);
    expect(stats.labelDefinition).toBe('path_barrier');
  });
});
