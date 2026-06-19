import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun, dbGet } from '../dbAsync';
import { createSignal } from '../signals';

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
