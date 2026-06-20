import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun } from '../dbAsync';
import { createCallerFactory } from '../trpc';
import { appRouter } from '../router';

const caller = createCallerFactory(appRouter)({} as any);

describe('signal readers on unified_signals', () => {
  beforeEach(async () => { await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTRD']); });

  it('getSignalHistory returns unified_signals rows for a symbol', async () => {
    const now = new Date().toISOString();
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, entry_price, status, signal_generated_at)
      VALUES (?, ?, 'platform', 'BUY', 101, 'ACTIVE', ?)
      ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO NOTHING`,
      ['TESTRD', now.split('T')[0], now]);
    const rows = await caller.getSignalHistory({ symbol: 'TESTRD' });
    expect(Array.isArray(rows)).toBe(true);
    const row = (rows as any[]).find(r => r.symbol === 'TESTRD');
    expect(row).toBeTruthy();
    // back-compat contract the signal UI reads (aliased from unified_signals snake_case)
    expect(row.type).toBe('BUY');
    expect(row.entry).toBe(101);
    expect(row.createdAt).toBeTruthy();
    expect('stopLoss' in row).toBe(true);
    expect('confidence' in row).toBe(true);
  });
});
