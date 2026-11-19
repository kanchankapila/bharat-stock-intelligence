import { test, expect } from 'vitest';
import { getStockMapping } from '../stockMapping';
import { nseStocksData } from '../../data/nseStocks';

// AF-20261119-11: getStockMapping fell through from symbol to MoneyControl code, so NSE symbols
// absent from stocklist.ts (LTM = LTIMindtree, BI, UEL) resolved to the company owning that MC
// code (Loyal Textile, Britannia, Unicommerce), and syncAllStockMappings copied all seven of that
// company's provider ids into nse_stocks.
test('an NSE symbol never resolves to a different company', () => {
  const wrong = nseStocksData
    .map(s => [s.symbol, getStockMapping(s.symbol)?.symbol] as const)
    .filter(([sym, got]) => got !== undefined && got.toUpperCase() !== sym.toUpperCase());
  expect(nseStocksData.length).toBeGreaterThan(2000);
  expect(wrong).toEqual([]);
});

test('lookup by MoneyControl code, name and tlid still works for non-NSE-symbol queries', () => {
  expect(getStockMapping('BRITANNIA')?.tlid).toBe('220');
  expect(getStockMapping('220')?.symbol).toBe('BRITANNIA');
  expect(getStockMapping('INE216A01030')?.symbol).toBe('BRITANNIA');
});
