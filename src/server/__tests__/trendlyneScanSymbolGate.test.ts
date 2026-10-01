import { describe, it, expect } from 'vitest';
import { resolveTradeableSymbol } from '../trendlyneScreener';

// AF-20260930-16 (signal side): the intraday scan trusted Trendlyne's own ticker, which lags NSE
// renames/delistings (ZOMATO -> ETERNAL 2025-04, GET&D -> GVT&D 2024-11). 31 of 792 scan symbols
// in 30 days had no price at all, so their signals could never be traded or graded.
describe('resolveTradeableSymbol', () => {
  const priced = new Set(['ETERNAL', 'AUBANK']);

  it('keeps a Trendlyne symbol that is currently priced', () => {
    expect(resolveTradeableSymbol({ symbol: 'ETERNAL' }, priced)).toBe('ETERNAL');
  });

  it('drops a retired code with no priced mapping', () => {
    expect(resolveTradeableSymbol({ symbol: 'ZOMATO', stockId: 'no-such-tlid' }, priced)).toBeUndefined();
  });

  it('re-maps a stale code through the Trendlyne id to the current symbol', () => {
    // tlid 54902 is AU Small Finance Bank in scripts/stocklist.json
    expect(resolveTradeableSymbol({ symbol: 'OLDCODE', stockId: '54902' }, priced)).toBe('AUBANK');
  });
});
