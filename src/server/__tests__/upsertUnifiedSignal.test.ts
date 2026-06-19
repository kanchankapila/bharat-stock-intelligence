import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun, dbGet } from '../dbAsync';
import { upsertUnifiedSignal } from '../signals';

describe('upsertUnifiedSignal', () => {
  beforeEach(async () => { await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTUP']); });

  it('inserts a signal with the given source and upserts on the 4-col key', async () => {
    const base = { symbol: 'TESTUP', signalDate: '2026-06-19', signalType: 'BUY',
                   entryPrice: 100, targetPrice: 110, stopLoss: 95, confidenceScore: 0.7,
                   generatedAt: '2026-06-19T10:00:00.000Z' };
    await upsertUnifiedSignal('AI', base);
    await upsertUnifiedSignal('AI', { ...base, entryPrice: 101 }); // same key → update, not duplicate
    const rows = await dbGet<{ n: number; entry_price: number; signal_source: string }>(
      'SELECT COUNT(*) AS n, MAX(entry_price) AS entry_price, MAX(signal_source) AS signal_source FROM unified_signals WHERE symbol = ?',
      ['TESTUP']);
    expect(rows?.n).toBe(1);
    expect(rows?.entry_price).toBe(101);
    expect(rows?.signal_source).toBe('AI');
  });
});
