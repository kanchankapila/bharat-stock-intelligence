import { describe, expect, it } from 'vitest';

import { nseStocksData } from '../../data/nseStocks';

describe('NSE static bootstrap universe policy', () => {
  it('does not reseed known aliases, inactive listings, or ETFs as active equities', () => {
    const symbols = new Set(nseStocksData.map((stock) => stock.symbol));
    for (const excluded of [
      'BAJAJINSUR', 'CENTRALBANK', 'CHOLAFINSV', 'INDUSIND', 'JIOFINANCIAL',
      'KOTAK', 'LARSEN', 'LTFH', 'LTIM', 'MAHINDRA', 'NESTLE', 'NIFTYBEES',
      'OBEROI', 'POLICYBAZAAR', 'TATAMOTORS', 'VODAFONE',
    ]) {
      expect(symbols.has(excluded), excluded).toBe(false);
    }
  });

  it('retains the current official symbols for renamed companies', () => {
    const symbols = new Set(nseStocksData.map((stock) => stock.symbol));
    expect(symbols.has('INDUSINDBK')).toBe(true);
    expect(symbols.has('LT')).toBe(true);
    expect(symbols.has('LTM')).toBe(true);
    expect(symbols.has('M&M')).toBe(true);
    expect(symbols.has('TMPV')).toBe(true);
  });
});
