import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun, dbGet } = await import('../dbAsync');
const { upsertUnifiedSignal } = await import('../signals');

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

  // Regression: signal_generated_at must record the FIRST generation, not the last refresh.
  // It used to be in the DO UPDATE SET, so every re-run walked it forward -- measured
  // 2026-08-12, 100% of signal_source='technical' rows carried a signal_generated_at LATER
  // than their own created_at, drifting up to 24h. That is the only column able to prove a
  // signal predates the bar it is graded against, so refreshing it silently made 82% of the
  // platform's signals look un-gradeable and any grading that trusted it look-ahead.
  it('keeps the first signal_generated_at across re-runs', async () => {
    const base = { symbol: 'TESTUP', signalDate: '2026-06-19', signalType: 'BUY',
                   entryPrice: 100, confidenceScore: 0.7 };
    const firstGen = '2026-06-19T03:00:00.000Z';   // pre-market run
    const laterGen = '2026-06-19T10:30:00.000Z';   // last intraday re-run, same signal

    await upsertUnifiedSignal('AI', { ...base, generatedAt: firstGen });
    await upsertUnifiedSignal('AI', { ...base, entryPrice: 105, generatedAt: laterGen });

    const row = await dbGet<{ signal_generated_at: string; entry_price: number }>(
      'SELECT signal_generated_at, entry_price FROM unified_signals WHERE symbol = ?',
      ['TESTUP']);
    // the payload still refreshes...
    expect(row?.entry_price).toBe(105);
    // ...but the provenance stamp does not move off the pre-market run
    expect(new Date(row!.signal_generated_at).toISOString()).toBe(firstGen);
  });
});
