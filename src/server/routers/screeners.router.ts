import { z } from "zod";
import db from "../db";
import { fetchMCScreener } from "../moneycontrol";
import { fetchETnowScreener } from "../etnow";
import { fetchTrendingScreeners, fetchETPennyStocks, fetchETStats } from "../marketData";
import { getOrRefreshAllStocks } from "../liveStockData";
import {
  fetchTrendlyneScreenerData,
  fetchAllTrendlyneScreenerNames,
  getTrendlyneScreenerList,
  getTrendlyneScreenerCategories,
  updateFetchInterval,
  updateScreenerNamesInterval,
  testTrendlyneApiResponse,
  recategorizeAllScreeners,
} from "../trendlyneScreener";
import { router, publicProcedure } from "../trpc";
import { SCANNER_CATALOG } from "../config/scannerCatalog";

export const screenersRouter = router({
  getTrendingScreeners: publicProcedure
    .query(async () => fetchTrendingScreeners()),

  getETPennyStocks: publicProcedure
    .query(async () => fetchETPennyStocks()),

  getETStats: publicProcedure
    .input(z.object({ type: z.enum(['gainers', 'losers']), duration: z.string().optional() }))
    .query(async ({ input }) => fetchETStats(input.type, input.duration)),

  getMarketScanners: publicProcedure
    .query(() => SCANNER_CATALOG),

  fetchMarketData: publicProcedure
    .input(z.object({ provider: z.string(), params: z.any() }))
    .query(async ({ input }) => {
      if (input.provider === 'mc') {
        const { type, catId, scanId } = input.params;
        return fetchMCScreener(type as any, catId, scanId);
      }
      if (input.provider === 'et') {
        const { screenerId, queryCondition } = input.params;
        return fetchETnowScreener(screenerId, queryCondition);
      }
      if (input.provider === 'custom') {
        const { timeframes, minVolume = 0 } = input.params;
        const allStocks = await getOrRefreshAllStocks();
        const parseVol = (v: string): number => {
          if (!v) return 0;
          if (v.endsWith('M')) return parseFloat(v) * 1_000_000;
          if (v.endsWith('K')) return parseFloat(v) * 1_000;
          return parseFloat(v) || 0;
        };
        const selected = allStocks
          .filter((s: any) => s.changePct > 0 && parseVol(s.volume) > minVolume && s.price > 0)
          .sort((a: any, b: any) => b.changePct - a.changePct)
          .slice(0, 50)
          .map((s: any) => ({
            symbol: s.symbol, name: s.name, ltp: s.price,
            perChg: s.changePct.toFixed(2), volume: s.volume,
            mktCap: '—', sector: s.sector || '—',
            timeframesMet: timeframes?.join(', ') || 'D, W',
            momentum: s.changePct > 2 ? 'Strong Bullish' : 'Bullish',
            pattern: s.high52w && (s.price / s.high52w) > 0.95 ? 'Near 52W High' : 'Uptrend',
          }));
        return {
          success: true,
          searchResult: { searchData: { records: selected } },
          data: { list: { scannerDetails: selected.map(s => ({ ...s, columns: [
            { name: 'LTP', value: s.ltp }, { name: '% Change', value: s.perChg },
            { name: 'Volume', value: s.volume }, { name: 'Momentum', value: s.momentum },
          ] })) } },
        };
      }
      throw new Error('Unknown provider');
    }),

  getTrendlyneScreener: publicProcedure
    .input(z.object({ screenpk: z.string(), screenerName: z.string(), pageNumber: z.number().optional().default(0) }))
    .query(async ({ input }) => {
      if (input.screenpk.startsWith('MC_')) {
        const scanId = input.screenpk.replace('MC_', '');
        const stocks = db.prepare(`
          SELECT ss.symbol as stockId, ss.stock_name as name, ss.symbol
          FROM moneycontrol_screener_stocks ss WHERE ss.scan_id = ?
        `).all(scanId) as any[];
        return {
          success: true,
          data: stocks.map(s => ({
            stockId: s.stockId || s.symbol || '', name: s.name || s.symbol || '',
            symbol: s.symbol || s.stockId || '', ltp: 0, change: 0, changePercent: 0,
            screenerName: input.screenerName, screenerType: 'moneycontrol',
          })),
          screenerName: input.screenerName, totalResults: stocks.length,
        };
      }
      if (input.screenpk.startsWith('ET_')) {
        const screenerId = input.screenpk.replace('ET_', '');
        const etScreener = db.prepare('SELECT query_condition FROM etnow_screeners WHERE screener_id = ?')
          .get(screenerId) as { query_condition: string } | undefined;
        if (etScreener) {
          const result = await fetchETnowScreener(screenerId, etScreener.query_condition);
          const records = result?.searchResult?.searchData?.records || [];
          return {
            success: true,
            data: records.map((r: any) => ({
              stockId: r.symbol || '', name: r.companyName || r.name || '',
              ltp: parseFloat(r.currentPrice || 0), change: parseFloat(r.priceChange || 0),
              changePercent: parseFloat(r.percentChange || 0),
              screenerName: input.screenerName, screenerType: 'etnow',
            })),
            screenerName: input.screenerName, totalResults: records.length,
          };
        }
      }
      return fetchTrendlyneScreenerData(input.screenpk, input.screenerName, input.pageNumber);
    }),

  getTrendlyneCategories: publicProcedure
    .query(() => getTrendlyneScreenerCategories()),

  getTrendlyneScreenerNames: publicProcedure
    .query(async () => getTrendlyneScreenerList()),

  configTrendlyneFetchInterval: publicProcedure
    .input(z.object({ intervalMs: z.number().min(0), type: z.enum(['screener', 'names']).optional().default('screener') }))
    .mutation(({ input }) => {
      if (input.type === 'names') updateScreenerNamesInterval(input.intervalMs);
      else updateFetchInterval(input.intervalMs);
      return {
        success: true,
        message: `${input.type} fetch interval updated to ${input.intervalMs}ms (${(input.intervalMs / 1000 / 60).toFixed(2)} minutes)`,
      };
    }),

  testTrendlyneApi: publicProcedure
    .input(z.object({ stockId: z.string().optional() }))
    .query(async ({ input }) => testTrendlyneApiResponse(input.stockId)),

  fetchTrendlyneScreenerNames: publicProcedure
    .query(async () => fetchAllTrendlyneScreenerNames()),

  getStockScreeners: publicProcedure
    .input(z.object({ stockId: z.string() }))
    .query(async ({ input }) => {
      const { findScreenersByStock } = await import('../trendlyneScreener');
      const { findMcScreenersByStock } = await import('../moneycontrolScreener');
      return [...findScreenersByStock(input.stockId), ...findMcScreenersByStock(input.stockId)];
    }),

  refreshTrendlyneScreenersDB: publicProcedure
    .mutation(async () => {
      const screenerNames = await fetchAllTrendlyneScreenerNames(true);
      return { success: true, message: `Refreshed screener database with ${screenerNames.size} screeners`, count: screenerNames.size };
    }),

  recategorizeTrendlyneScreeners: publicProcedure
    .mutation(async () => recategorizeAllScreeners()),
});
