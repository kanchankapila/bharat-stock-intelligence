import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const dbModule = await import('../db');
const db = dbModule.default;
const { computeSignalOutcomes, getWinRateStats } = await import('../signalOutcomesService');

beforeEach(() => {
  ['signal_outcomes', 'technical_signals', 'stock_ohlcv']
    .forEach(table => db.exec(`DELETE FROM ${table}`));
});

// signalOutcomesService.ts is a genuinely independent, separately-scheduled writer of
// signal_outcomes ('signal-outcomes-daily', 9 AM IST weekdays) grading technical_signals rows
// -- the same source bucket as outcome_resolver.py's Python resolver, which runs on its own
// schedule against the same (symbol, signal_date, horizon_days). Neither writer's dedup guard
// used to check signal_source, so they collided silently with each other AND with
// confluence_outcome_tracker.py (2026-08 fix).
describe('signalOutcomesService.computeSignalOutcomes stamps signal_source', () => {
  const seedTechnicalSignal = (symbol: string, date: string) => {
    db.prepare(`INSERT INTO technical_signals (symbol, date, cmp, signal_score, signals_json, stop_loss)
      VALUES (?, ?, 100.0, 6, '[]', NULL)`).run(symbol, date);
  };
  const seedOhlcv = (symbol: string, date: string, close: number) => {
    db.prepare(`INSERT OR IGNORE INTO stock_ohlcv (symbol, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, 100000)`).run(symbol, date, close, close, close, close);
  };

  it('writes signal_source=technical on a fresh resolution', async () => {
    const signalDate = '2020-01-01';
    seedTechnicalSignal('AAA', signalDate);
    // Exit bar 5 trading days later, +5% -> WIN under the fixed >2.0% threshold
    seedOhlcv('AAA', '2020-01-06', 105.0);

    await computeSignalOutcomes(5);

    const row = db.prepare(
      `SELECT outcome, signal_source FROM signal_outcomes WHERE symbol='AAA' AND horizon_days=5`
    ).get() as any;
    expect(row).toBeDefined();
    expect(row.signal_source).toBe('technical');
    expect(row.outcome).toBe('WIN');
  });

  it('does not create a second orphaned row when a technical-sourced PENDING row already exists at the same key', async () => {
    const signalDate = '2020-01-01';
    // Simulate technicalSignalsService.ts's seed: a PENDING row stamped signal_source='technical'
    // at signal-creation time, matching what computeSignalOutcomes will later resolve.
    db.prepare(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, signal_source)
      VALUES ('BBB', ?, 5, 100.0, 'PENDING', 'technical')`).run(signalDate);
    seedTechnicalSignal('BBB', signalDate);
    seedOhlcv('BBB', '2020-01-06', 105.0);

    await computeSignalOutcomes(5);

    const rows = db.prepare(
      `SELECT outcome, signal_source FROM signal_outcomes WHERE symbol='BBB' AND horizon_days=5`
    ).all() as any[];
    // Must UPDATE the existing 'technical' row in place, not INSERT a second row alongside it.
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('WIN');
  });

  it('coexists with a confluence-sourced row at the identical key instead of colliding', async () => {
    const signalDate = '2020-01-01';
    db.prepare(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, signal_source)
      VALUES ('CCC', ?, 5, 100.0, 'LOSS', 'confluence')`).run(signalDate);
    seedTechnicalSignal('CCC', signalDate);
    seedOhlcv('CCC', '2020-01-06', 105.0);

    await computeSignalOutcomes(5);

    const rows = db.prepare(
      `SELECT signal_source, outcome FROM signal_outcomes WHERE symbol='CCC' AND horizon_days=5 ORDER BY signal_source`
    ).all() as any[];
    expect(rows.map(r => r.signal_source)).toEqual(['confluence', 'technical']);
    expect(rows.find(r => r.signal_source === 'confluence')?.outcome).toBe('LOSS');
    expect(rows.find(r => r.signal_source === 'technical')?.outcome).toBe('WIN');
  });
});

describe('getWinRateStats scopes to one signal_source AND one label_definition', () => {
  it('excludes confluence-sourced outcomes from the win-rate report', async () => {
    db.prepare(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('DDD', '2020-01-01', 5, 100, 'WIN', 5.0, 'technical', 'path_barrier')`).run();
    db.prepare(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('EEE', '2020-01-01', 5, 100, 'LOSS', -5.0, 'confluence', 'terminal_pct2')`).run();

    const stats = await getWinRateStats();

    expect(stats.overall.total).toBe(1);
    expect(stats.overall.wins).toBe(1);
  });

  // Regression for the contamination found live 2026-08-15: signal_source='technical' was NOT
  // label-uniform. 1,722 unlabeled rows (written by this service, which never stamped the
  // column) sat at a 99.4% win rate inside the same date range as 198,723 labeled path_barrier
  // rows at 68.7%. Filtering on signal_source alone let them blend into the headline number.
  it('excludes technical rows with a NULL label_definition', async () => {
    db.prepare(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source, label_definition)
      VALUES ('FFF', '2020-01-02', 5, 100, 'WIN', 5.0, 'technical', 'path_barrier')`).run();
    // Same source, no label — the shape that was silently inflating the win rate.
    db.prepare(`INSERT INTO signal_outcomes
      (symbol, signal_date, horizon_days, entry_price, outcome, return_pct, signal_source)
      VALUES ('GGG', '2020-01-02', 5, 100, 'WIN', 99.0, 'technical')`).run();

    const stats = await getWinRateStats();

    expect(stats.overall.total).toBe(1);
    expect(stats.labelDefinition).toBe('path_barrier');
  });

  // The writer must stamp the label, or the filter above silently drops every row it produces
  // -- which is exactly the state this service was in before 2026-08-15. Calls the real
  // function rather than grepping the source, per .claude/rules/recurring-bugs.md's "a test
  // that reimplements the logic under test passes against the unfixed source".
  it('computeSignalOutcomes stamps label_definition on the rows it writes', async () => {
    db.prepare(`INSERT INTO technical_signals (symbol, date, cmp, signal_score, signals_json, stop_loss)
      VALUES ('HHH', '2020-01-01', 100.0, 6, '[]', NULL)`).run();
    db.prepare(`INSERT OR IGNORE INTO stock_ohlcv (symbol, date, open, high, low, close, volume)
      VALUES ('HHH', '2020-01-06', 105.0, 105.0, 105.0, 105.0, 100000)`).run();

    await computeSignalOutcomes(5);

    const row = db.prepare(
      `SELECT label_definition FROM signal_outcomes WHERE symbol='HHH' AND horizon_days=5`
    ).get() as any;
    expect(row?.label_definition).toBe('path_barrier');
  });

  // And the row it writes must actually survive the report's own filter -- the two halves of
  // this fix are only correct together.
  it('a row written by computeSignalOutcomes is counted by getWinRateStats', async () => {
    db.prepare(`INSERT INTO technical_signals (symbol, date, cmp, signal_score, signals_json, stop_loss)
      VALUES ('III', '2020-01-01', 100.0, 6, '[]', NULL)`).run();
    db.prepare(`INSERT OR IGNORE INTO stock_ohlcv (symbol, date, open, high, low, close, volume)
      VALUES ('III', '2020-01-06', 105.0, 105.0, 105.0, 105.0, 100000)`).run();

    await computeSignalOutcomes(5);
    const stats = await getWinRateStats();

    expect(stats.overall.total).toBe(1);
  });
});
