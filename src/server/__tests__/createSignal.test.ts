import { describe, it, expect, beforeEach } from 'vitest';

// Isolates this test from the host environment's USE_POSTGRES -- dbAsync.ts's usePostgres()
// reads it fresh on every call, not just at import time, so a real dev/CI environment with
// USE_POSTGRES=true would route every dbRun/dbGet call below to a live Postgres pool instead
// of the (default file-based) SQLite db this file actually exercises, failing on ECONNREFUSED
// regardless of what's being tested. A plain top-level `process.env.USE_POSTGRES = 'false'`
// before a STATIC `import { dbRun } from '../dbAsync'` would not reliably run first (static
// imports are hoisted ahead of a module's own top-level statements) -- use a dynamic import
// instead, matching the pattern already established in backtestRunner.test.ts and siblings.
process.env.USE_POSTGRES = 'false';
const { dbRun, dbGet } = await import('../dbAsync');
const { createSignal } = await import('../signals');

describe('createSignal', () => {
  beforeEach(async () => {
    await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTCS']);
  });

  it('persists to unified_signals with signal_source=platform', async () => {
    await createSignal({
      symbol: 'TESTCS', type: 'BUY', entry: 100, target: 115, stopLoss: 92,
      confidence: 0.8, reasoning: 'unit test',
    } as any);
    const row = await dbGet<{ signal_source: string; entry_price: number; signal_type: string }>(
      'SELECT signal_source, entry_price, signal_type FROM unified_signals WHERE symbol = ?', ['TESTCS']);
    expect(row?.signal_source).toBe('platform');
    expect(row?.signal_type).toBe('BUY');
    expect(row?.entry_price).toBe(100);
  });
});
