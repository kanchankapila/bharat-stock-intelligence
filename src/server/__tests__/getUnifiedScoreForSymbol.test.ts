import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

beforeEach(async () => {
  await dbExec('DELETE FROM unified_recommendations');
  await dbExec('DELETE FROM technical_signals');
});

describe('getUnifiedScoreForSymbol', () => {
  it('returns the latest unified_recommendations row merged with technical_signals features', async () => {
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level, timeframe, sector, classification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01T07:30:00Z', 'BULL', 78.5, 'A_HIGH', 'swing', 'IT', 'Buy']);

    await dbRun(`
      INSERT INTO technical_signals (symbol, date, win_probability, rsi, is_nifty50, asm_flag)
      VALUES (?, ?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01', 0.62, 71, 1, 0]);

    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'TEST' });
    expect(result).toBeTruthy();
    expect(result.unified_score).toBe(78.5);
    expect(result.conviction_level).toBe('A_HIGH');
    expect(result.win_probability).toBe(0.62);
    expect(result.rsi).toBe(71);
    expect(result.is_nifty50).toBe(1);
  });

  it('returns null for a symbol with no unified_recommendations row (not ranked today)', async () => {
    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'NOTRANKED' });
    expect(result).toBeNull();
  });

  it('only returns the latest computed_at snapshot, not stale older rows', async () => {
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `, ['TEST', '2026-07-30T07:30:00Z', 'BULL', 50, 'C_LOW']);
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01T07:30:00Z', 'BULL', 90, 'S_ELITE']);

    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'TEST' });
    expect(result.unified_score).toBe(90);
    expect(result.conviction_level).toBe('S_ELITE');
  });
});
