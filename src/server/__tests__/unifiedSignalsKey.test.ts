import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun, dbAll } = await import('../dbAsync');

describe('unified_signals 4-col uniqueness key', () => {
  beforeEach(async () => {
    await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTKEY']);
  });

  it('keeps two different signal_types for the same symbol/source/date', async () => {
    const date = '2026-06-19';
    const ts = '2026-06-19T10:00:00.000Z';
    for (const type of ['EMA_BULL_STACK', 'BREAKOUT']) {
      await dbRun(`
        INSERT INTO unified_signals
          (symbol, signal_date, signal_source, signal_type, status, signal_generated_at)
        VALUES (?, ?, 'technical', ?, 'ACTIVE', ?)
        ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
          signal_generated_at = excluded.signal_generated_at
      `, ['TESTKEY', date, type, ts]);
    }
    const rows = await dbAll<{ signal_type: string }>(
      'SELECT signal_type FROM unified_signals WHERE symbol = ? ORDER BY signal_type', ['TESTKEY']);
    expect(rows.map(r => r.signal_type)).toEqual(['BREAKOUT', 'EMA_BULL_STACK']);
  });
});
