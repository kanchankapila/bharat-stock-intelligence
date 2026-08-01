import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
const { default: db } = await import('../db');

import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

beforeEach(() => {
  db.exec('DELETE FROM unified_recommendations');
  db.exec('DELETE FROM technical_signals');
});

describe('getUnifiedScoreForSymbol', () => {
  it('returns the latest unified_recommendations row merged with technical_signals features', async () => {
    db.prepare(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level, timeframe, sector, classification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('TEST', '2026-08-01T07:30:00Z', 'BULL', 78.5, 'A_HIGH', 'swing', 'IT', 'Buy');

    db.prepare(`
      INSERT INTO technical_signals (symbol, date, win_probability, rsi, is_nifty50, asm_flag)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('TEST', '2026-08-01', 0.62, 71, 1, 0);

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
    db.prepare(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `).run('TEST', '2026-07-30T07:30:00Z', 'BULL', 50, 'C_LOW');
    db.prepare(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `).run('TEST', '2026-08-01T07:30:00Z', 'BULL', 90, 'S_ELITE');

    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'TEST' });
    expect(result.unified_score).toBe(90);
    expect(result.conviction_level).toBe('S_ELITE');
  });
});
