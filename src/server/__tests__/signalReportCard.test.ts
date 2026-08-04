import { describe, it, expect, beforeEach } from 'vitest';

// Isolates this test from the host environment's USE_POSTGRES -- see createSignal.test.ts
// for the full explanation of why a dynamic import is required here, not a plain top-level
// statement before a static `import { dbRun } from '../dbAsync'`.
process.env.USE_POSTGRES = 'false';
const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

describe('getSignalReportCard', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM technical_signals WHERE symbol = ?`, ['SRCRD1']);
    await dbRun(`DELETE FROM stock_ohlcv WHERE symbol = ?`, ['SRCRD1']);
  });

  it('does not crash on technical_signals.id (composite key table has no id column) and synthesizes a stable id', async () => {
    const today = new Date().toISOString().split('T')[0];
    await dbRun(`INSERT INTO technical_signals (symbol, date, cmp, signal_score) VALUES (?, ?, ?, ?)`,
      ['SRCRD1', today, 100, 8]);
    await dbRun(`INSERT INTO stock_ohlcv (symbol, date, close, open, high, low, volume) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['SRCRD1', today, 110, 105, 112, 104, 1000]);

    const result = await caller.getSignalReportCard({ activeLimit: 200 });
    expect(result).toBeTruthy();

    const row = result.activeSignalGrowth.find((r: any) => r.symbol === 'SRCRD1');
    expect(row).toBeTruthy();
    expect(row.id).toBe(`SRCRD1-${today}`);
    // 110 vs entry 100 -> +10% growth
    expect(Number(row.growth_pct)).toBeCloseTo(10, 1);
  });
});
