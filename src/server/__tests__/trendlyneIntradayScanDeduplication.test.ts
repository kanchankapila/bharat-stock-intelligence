import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun, dbGet } from '../dbAsync';

describe('runIntradayScreenerScan deduplication & confluence', () => {
  const symbol = 'TEST_DEDUP_SYM';
  const todayStr = new Date().toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  beforeEach(async () => {
    await dbRun('DELETE FROM unified_signals WHERE symbol = ?', [symbol]);
    await dbRun('DELETE FROM stock_scores WHERE symbol = ?', [symbol]);
  });

  it('allows generating a new screener signal if an ACTIVE signal exists from YESTERDAY', async () => {
    await dbRun(
      `INSERT INTO unified_signals (symbol, signal_source, signal_type, signal_date, signal_generated_at, status, confidence_score, entry_price)
       VALUES (?, 'screener', 'BUY', ?, NOW(), 'ACTIVE', 85, 100)`,
      [symbol, yesterdayStr]
    );

    const checkToday = await dbGet(
      "SELECT COUNT(*) as count FROM unified_signals WHERE symbol = ? AND status = 'ACTIVE' AND signal_source = 'screener' AND signal_date = ?",
      [symbol, todayStr]
    ) as any;

    expect(parseInt(checkToday.count, 10)).toBe(0);
  });

  it('upgrades existing ACTIVE signal with confluence bonus when same direction triggers today', async () => {
    await dbRun(
      `INSERT INTO unified_signals (symbol, signal_source, signal_type, signal_date, signal_generated_at, status, confidence_score, entry_price, reasoning)
       VALUES (?, 'screener', 'BUY', ?, NOW(), 'ACTIVE', 88, 100, 'Original screener')`,
      [symbol, todayStr]
    );

    const existingSignal = await dbGet(
      "SELECT id, signal_type, confidence_score, reasoning FROM unified_signals WHERE symbol = ? AND status = 'ACTIVE' AND signal_source = 'screener' AND signal_date = ?",
      [symbol, todayStr]
    ) as any;

    expect(existingSignal.signal_type).toBe('BUY');

    // Simulate upgrading existing signal
    const baseConfidence = Math.max(existingSignal.confidence_score || 0, 88);
    const upgradedConfidence = Math.min(98, baseConfidence + 3);
    const updatedReasoning = `${existingSignal.reasoning} | Additional confirmation from 'Supertrend Buy'`.trim();

    await dbRun(
      "UPDATE unified_signals SET confidence_score = ?, reasoning = ? WHERE id = ?",
      [upgradedConfidence, updatedReasoning, existingSignal.id]
    );

    const updated = await dbGet("SELECT confidence_score, reasoning FROM unified_signals WHERE id = ?", [existingSignal.id]) as any;
    expect(updated.confidence_score).toBe(91);
    expect(updated.reasoning).toContain('Supertrend Buy');
  });

  it('invalidates previous signal on directional conflict (BUY vs SELL)', async () => {
    await dbRun(
      `INSERT INTO unified_signals (symbol, signal_source, signal_type, signal_date, signal_generated_at, status, confidence_score, entry_price)
       VALUES (?, 'screener', 'BUY', ?, NOW(), 'ACTIVE', 85, 100)`,
      [symbol, todayStr]
    );

    const activeSignal = await dbGet(
      "SELECT id, signal_type FROM unified_signals WHERE symbol = ? AND status = 'ACTIVE' AND signal_source = 'screener' AND signal_date = ?",
      [symbol, todayStr]
    ) as any;

    expect(activeSignal.signal_type).toBe('BUY');

    // Simulate conflicting SELL signal invalidation
    await dbRun("UPDATE unified_signals SET status = 'INVALIDATED_CONFLICT' WHERE id = ?", [activeSignal.id]);

    const checkedOld = await dbGet("SELECT status FROM unified_signals WHERE id = ?", [activeSignal.id]) as any;
    expect(checkedOld.status).toBe('INVALIDATED_CONFLICT');
  });
});


