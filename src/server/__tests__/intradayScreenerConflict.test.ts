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
