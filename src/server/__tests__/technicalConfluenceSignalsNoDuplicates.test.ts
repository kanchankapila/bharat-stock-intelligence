import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

// AF-20260818-46: confluence_signals recomputes every ~30min year-round (confluence-compute,
// 24/7 cadence), so a plain LEFT JOIN on a whole-day computed_at range matched every row in the
// day, not one -- 20 confluence_signals rows/symbol/day fanned technical_signals's single row
// into 20 duplicate output rows. Live-confirmed for BIL/RISHABH/RAYMOND on 2026-08-18 (4 rows
// each under the old join shape, 1 under the fixed LATERAL join). This seeds the exact shape --
// one technical_signals row, TWO confluence_signals rows for the same symbol/day -- against a
// real Postgres query, not a reimplementation of the SQL.
describe('getTechnicalConfluenceSignals', () => {
  const SYM = 'TCFDUP1';

  beforeEach(async () => {
    await dbRun(`DELETE FROM confluence_signals WHERE symbol = ?`, [SYM]);
    await dbRun(`DELETE FROM technical_signals WHERE symbol = ?`, [SYM]);
  });
  afterEach(async () => {
    await dbRun(`DELETE FROM confluence_signals WHERE symbol = ?`, [SYM]);
    await dbRun(`DELETE FROM technical_signals WHERE symbol = ?`, [SYM]);
  });

  it('returns exactly one row per symbol even when confluence_signals has multiple same-day rows', async () => {
    const today = new Date().toISOString().split('T')[0];
    await dbRun(
      `INSERT INTO technical_signals (symbol, date, signal_score, win_probability) VALUES (?, ?, ?, ?)`,
      [SYM, today, 8, 0.6],
    );
    // Two confluence_signals rows for the same symbol/day, different computed_at and score --
    // the recurring 30-min-recompute shape.
    await dbRun(
      `INSERT INTO confluence_signals (symbol, computed_at, confluence_score, conviction_level) VALUES (?, ?, ?, ?)`,
      [SYM, `${today}T02:00:00Z`, 55, 'MODERATE'],
    );
    await dbRun(
      `INSERT INTO confluence_signals (symbol, computed_at, confluence_score, conviction_level) VALUES (?, ?, ?, ?)`,
      [SYM, `${today}T10:00:00Z`, 90, 'ELITE'],
    );

    const rows = await caller.getTechnicalConfluenceSignals({
      date: today, minUnified: 0, minConfluence: 0, limit: 100,
    });
    const mine = rows.filter((r: any) => r.symbol === SYM);
    expect(mine.length).toBe(1);
    // The LATERAL join must pick the LATEST row (10:00, score 90), not an arbitrary one.
    expect(Number(mine[0].confluence_score)).toBe(90);
  });
});
