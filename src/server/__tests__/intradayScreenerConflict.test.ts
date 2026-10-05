import { describe, it, expect } from 'vitest';
import { formatIntradayScanSummary, screenerDirection, screenerHitAction } from '../trendlyneScreener';

// AF-20261001-14/-15. Sept 2026: 15,606 of 17,281 'screener' unified_signals ended
// INVALIDATED_CONFLICT; 8,057 of 9,224 symbol-days carried BOTH a BUY and a SELL. On every
// conflict the scan invalidated the live row and immediately published the opposite one, and a
// later re-flip upserted onto an already-INVALIDATED row (the upsert never restores status) and
// still counted it as "GENERATED". 1,250 BUY rows came from screeners whose sentiment is 'neutral'.

describe('screenerDirection', () => {
  it('maps directional sentiment', () => {
    expect(screenerDirection('bullish')).toBe('BUY');
    expect(screenerDirection('bearish')).toBe('SELL');
  });
  it('a neutral screener carries no direction', () => {
    expect(screenerDirection('neutral')).toBeNull();
    expect(screenerDirection('')).toBeNull();
  });
});

describe('screenerHitAction', () => {
  it('publishes when nothing exists today', () => {
    expect(screenerHitAction(null, 'BUY')).toBe('publish');
  });
  it('same direction confirms', () => {
    expect(screenerHitAction({ signal_type: 'BUY', status: 'ACTIVE' }, 'BUY')).toBe('confirm');
  });
  it('an opposite hit invalidates the live call but does not flip into a new one', () => {
    expect(screenerHitAction({ signal_type: 'BUY', status: 'ACTIVE' }, 'SELL')).toBe('invalidate_only');
  });
  it('a symbol already conflicted today is off the book for the day, either direction', () => {
    expect(screenerHitAction({ signal_type: 'BUY', status: 'INVALIDATED_CONFLICT' }, 'BUY')).toBe('skip');
    expect(screenerHitAction({ signal_type: 'BUY', status: 'INVALIDATED_CONFLICT' }, 'SELL')).toBe('skip');
  });
});

describe('formatIntradayScanSummary', () => {
  it('keeps screener counts, stock matches, and created rows in distinct units', () => {
    expect(formatIntradayScanSummary({
      screenersScanned: 84,
      activeScreeners: 120,
      highScoringMatches: 845,
      highScoringSymbols: 426,
      signalRowsCreated: 698,
      unpricedSkipped: 12,
    })).toBe(
      'Screeners scanned: 84/120 | High-scoring screener-stock matches: 845 across 426 distinct stocks | ' +
      'Signal rows created this pass: 698 | Unpriced/unmapped matches skipped: 12'
    );
  });
});

describe('SCREENER_CONFIRM_SQL (AF-20261001-16)', () => {
  it('a confirming hit never re-prices the published entry/target/stop', async () => {
    const { SCREENER_CONFIRM_SQL } = await import('../trendlyneScreener');
    const setList = SCREENER_CONFIRM_SQL.split(/\bSET\b/i)[1].split(/\bWHERE\b/i)[0];
    expect(setList).not.toMatch(/entry_price|target_price|stop_loss/);
  });
});

// AF-20261001-17: the screener scan hard-coded target +5% / stop -3% for every name, but the median
// daily range is ~3.8%, so the 3% stop sat inside an ordinary day for ~74% of names and 68% of h5
// outcomes were STOP_LOSS. Levels now come from the name's own ATR (same function the technical scan
// uses); the fixed percentages remain only as the fallback when there is too little history.
import { screenerGeometry } from '../trendlyneScreener';
describe('screenerGeometry', () => {
  it('uses the ATR-scaled barriers when available', () => {
    const g = screenerGeometry(100, 'BUY', { entryPrice: 100, targetPrice: 110, stopLoss: 94 });
    expect(g).toEqual({ target: 110, stopLoss: 94 });
  });
  it('a wide-range name gets a wider stop than the old fixed 3%', () => {
    const g = screenerGeometry(100, 'BUY', { entryPrice: 100, targetPrice: 107.5, stopLoss: 95.5 });
    expect(100 - g.stopLoss).toBeGreaterThan(3);
  });
  it('falls back to +5% / -3% (BUY) and the mirror (SELL) without ATR history', () => {
    expect(screenerGeometry(200, 'BUY', null)).toEqual({ target: 210, stopLoss: 194 });
    expect(screenerGeometry(200, 'SELL', null)).toEqual({ target: 190, stopLoss: 206 });
  });
});
