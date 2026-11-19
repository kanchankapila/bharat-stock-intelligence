/**
 * AF-20261117: the /sectors page's RS-Ratio subtracted Nifty's 1-DAY change x4 from a 1-month
 * figure that never matched (MC sector names vs dbSector), so it was always 1-day x constants;
 * 5d/3m/6m/1y "returns" were 1-day x 2.1 and RS-Ratio x constants; the buildup label read PCR,
 * not open interest. Returns and RS-Ratio must come from stored index closes and the buildup
 * from futures OI.
 */
import { vi, describe, test, expect } from 'vitest';

// 300 sessions newest-first; sector compounds +0.1%/session, Nifty is flat.
const closes = (step: number) => Array.from({ length: 300 }, (_, i) => 1000 * Math.pow(1 + step, 300 - i));

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => null),
  dbAll: vi.fn(async (sql: string) => {
    if (sql.includes('marketsmojo_index_history')) {
      return [
        ...closes(0.001).map(price => ({ name: 'NIFTYIT', price })),
        ...closes(0).map(price => ({ name: 'NIFTY', price })),
      ];
    }
    if (sql.includes('stock_futures_oi_history')) {
      return [
        { sector: 'Information Technology', oi_buildup: 'Short Covering', oi_change: -900 },
        { sector: 'Information Technology', oi_buildup: 'Long Buildup', oi_change: 100 },
        { sector: 'Information Technology', oi_buildup: 'Long Buildup', oi_change: 200 },
      ];
    }
    if (sql.includes('sector_fo_sentiment')) {
      return [{ sector: 'Information Technology', sector_pcr: 1.2, total_call_oi: 1, total_put_oi: 1, symbol_count: 3 }];
    }
    return [];
  }),
}));
vi.mock('../cacheService', () => ({ fetchWithCache: (_k: string, fn: () => unknown) => fn() }));
vi.mock('../strategySignalsService', () => ({ getLatestNiftyRegime: vi.fn(async () => 'SIDEWAYS') }));
vi.mock('../marketData', () => ({
  fetchAllIndianIndices: vi.fn(async () => ({
    success: 1,
    data: { indiceList: [{ list: [
      { name: 'NIFTY 50', value: '24000', change: '0', changePer: '-1.00' },
      { name: 'NIFTY IT', value: '40000', change: '400', changePer: '3.00' },
    ] }] },
  })),
  fetchSectorAdvanceDecline: vi.fn(async () => null),
  fetchSectorStocks: vi.fn(),
  fetchIndexStocksList: vi.fn(),
}));
vi.mock('../indexApiService', () => ({ fetchIndexFullDetails: vi.fn(), fetchIndexFundamentals: vi.fn(), fetchIndexTechnicals: vi.fn() }));
vi.mock('../sectorApiService', () => ({ fetchSectorTechnicalTrends: vi.fn() }));
vi.mock('../liveStockData', () => ({ getOrRefreshAllStocks: vi.fn() }));
vi.mock('../../services/aiService', () => ({ generateStockAnalysis: vi.fn() }));

const { sectorsRouter } = await import('../routers/sectors.router');

describe('getSectorsOverview', () => {
  test('returns, RS-Ratio and buildup come from stored closes and futures OI', async () => {
    const caller = sectorsRouter.createCaller({} as any);
    const res: any = await caller.getSectorsOverview();
    const it = res.sectors.find((s: any) => s.id === 'nifty-it');
    const m1 = (Math.pow(1.001, 21) - 1) * 100;

    // 1m relative return vs a flat Nifty, not (1d * 5) - (Nifty 1d * 4) = 19
    expect(it.rrg.rsRatio).toBeCloseTo(100 + m1 * 1.5, 1);
    // OI-weighted: |-900| short covering outweighs 300 of long buildup; PCR 1.2 is irrelevant
    expect(it.derivatives.buildup).toBe('SHORT_COVERING');
    // PCR 1.2 is a level, not a call: it used to read BULLISH.
    expect(it.derivatives.sentiment).toBe('PCR_HIGH');
    expect(it.returns['1m']).toBeCloseTo(m1, 1);
    expect(it.returns['1y']).toBeCloseTo((Math.pow(1.001, 252) - 1) * 100, 1);

    const bank = res.sectors.find((s: any) => s.id === 'nifty-bank');
    expect(bank.rrg.rsRatio).toBeNull();
    expect(bank.rrg.quadrant).toBeNull();
    expect(bank.derivatives.buildup).toBeNull();
    expect(bank.derivatives.sentiment).toBeNull();
  });
});
