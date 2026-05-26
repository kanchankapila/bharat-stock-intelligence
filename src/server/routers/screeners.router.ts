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

export const screenersRouter = router({
  getTrendingScreeners: publicProcedure
    .query(async () => fetchTrendingScreeners()),

  getETPennyStocks: publicProcedure
    .query(async () => fetchETPennyStocks()),

  getETStats: publicProcedure
    .input(z.object({ type: z.enum(['gainers', 'losers']), duration: z.string().optional() }))
    .query(async ({ input }) => fetchETStats(input.type, input.duration)),

  getMarketScanners: publicProcedure
    .query(() => [
      { category: 'Breakout Intelligence', items: [
        { id: 'mc-25-OHLC_D_P_BPBULL',    provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL',    name: 'Range Breakout',    type: 'techscanner' as const },
        { id: 'mc-25-OHLC_D_P_WIBL',      provider: 'mc', catId: 25, scanId: 'OHLC_D_P_WIBL',      name: 'White Marubozu',    type: 'techscanner' as const },
        { id: 'mc-25-OHLC_D_I_RSIPOWBO',  provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO',  name: 'RSI Resistance BO', type: 'techscanner' as const },
        { id: 'mc-patterns-triangle',      provider: 'mc', catId: 'patterns', scanId: 'triangle',   name: 'Triangle Breakout', type: 'techscanner' as const },
        { id: 'mc-patterns-flag',          provider: 'mc', catId: 'patterns', scanId: 'flag',        name: 'Flag Pattern',      type: 'techscanner' as const },
      ]},
      { category: 'Multi-Timeframe Highs', items: [
        { id: 'hh-15m-1h',   provider: 'custom', name: '15m & 1h New Highs',      type: 'multi-tf' as const, timeframes: ['15m', '1h'] },
        { id: 'hh-1h-4h-d',  provider: 'custom', name: '1h, 4h & Daily Highs',    type: 'multi-tf' as const, timeframes: ['1h', '4h', 'D'] },
        { id: 'hh-d-w',      provider: 'custom', name: 'Daily & Weekly Highs',     type: 'multi-tf' as const, timeframes: ['D', 'W'] },
      ]},
      { category: 'Value & Quality (MC)', items: [
        { id: 'mc-1-146', provider: 'mc', catId: 1, scanId: '146', name: 'Bargain Buys',    type: 'proscanner' as const },
        { id: 'mc-1-181', provider: 'mc', catId: 1, scanId: '181', name: 'Reasonable Price', type: 'proscanner' as const },
        { id: 'mc-1-178', provider: 'mc', catId: 1, scanId: '178', name: 'Growth Stocks',   type: 'proscanner' as const },
      ]},
      { category: 'Technical Breakouts (MC)', items: [
        { id: 'mc-25-BPBULL',    provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL',    name: 'Bullish Breakaway', type: 'techscanner' as const },
        { id: 'mc-25-RSIPOWBO',  provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO',  name: 'RSI Power BO',      type: 'techscanner' as const },
        { id: 'mc-17-52HIGH',    provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52HIGH',     name: '52 Week High',      type: 'techscanner' as const },
        { id: 'mc-17-52LOW',     provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52LOW',      name: '52 Week Low',       type: 'techscanner' as const },
      ]},
      { category: 'Technical Trends (MC)', items: [
        { id: 'mc-tt-bullish',          provider: 'mc', catId: 'uptrend/bullish',          scanId: '7', name: 'Nifty 500 Bullish', type: 'technical-trends' as const },
        { id: 'mc-tt-turning-bullish',  provider: 'mc', catId: 'uptrend/turning-bullish',  scanId: '7', name: 'Turning Bullish',   type: 'technical-trends' as const },
        { id: 'mc-tt-bearish',          provider: 'mc', catId: 'downtrend/bearish',        scanId: '7', name: 'Nifty 500 Bearish', type: 'technical-trends' as const },
        { id: 'mc-tt-turning-bearish',  provider: 'mc', catId: 'downtrend/turning-bearish',scanId: '7', name: 'Turning Bearish',   type: 'technical-trends' as const },
      ]},
      { category: 'ETnow Elite (ET)', items: [
        { id: 'et-73',  provider: 'et', screenerId: '73',  name: 'Cash Cows',             queryCondition: ' Cash & Cash Equiv (Rs Cr) >=2500 AND  CF Operations (Rs Cr) >=1000 AND  Chg in Working Cap (Rs Cr) >=3000 AND   Quick Ratio >=1.5' },
        { id: 'et-75',  provider: 'et', screenerId: '75',  name: 'Elite Bluechips',        queryCondition: ' Market Cap (Rs Cr) > 60000  AND  Pitroski Score  >=6 AND  Return on Equity (%) >=  Avg ROE 5Y (%) AND  ROA (%) >=  Avg ROA 5Y AND  PEG Ratio <=1.5 AND CFO_By_Profit After Tax (Rs Cr) >=1' },
        { id: 'et-79',  provider: 'et', screenerId: '79',  name: 'Zero Debt Quality',      queryCondition: ' Debt to Equity <=0.1 AND  LT DE Ratio <=0.1 AND  Int Coverage Ratio >=100 AND Market Cap (Rs Cr) >=500 AND  Z Score >=3 AND  Pitroski Score >=6' },
        { id: 'et-91',  provider: 'et', screenerId: '91',  name: 'Buy on Dips',            queryCondition: ' Pitroski Score >=6 AND  YTD Returns (%) <=15 AND  PEG Ratio <=0.8 AND  Sustainable Growth (%) >=7 AND  Market Cap (Rs Cr) >=2000 AND  CFO_By_Profit After Tax (Rs Cr) >=1 AND  PEG Ratio >=0' },
        { id: 'et-195', provider: 'et', screenerId: '195', name: 'Potential Multibaggers', queryCondition: ' Return on Equity (%) >  Return on Equity 1Y (%) AND  Return on Equity (%) >=20 AND  EBITDA Margin % >  EBITDA Margin % 1Y AND  Sustainable Growth (%) >=15 AND Earnings Retention % Net Profit >=85 AND  LT DE Ratio <=1 AND CFO_By_Profit After Tax (Rs Cr) >= 1 AND  Rel Ret vs BSE 500 YTD >=1 AND  PEG Ratio <=1' },
        { id: 'et-118', provider: 'et', screenerId: '118', name: 'Straight Flush',         queryCondition: ' Qtr Net Profit (Rs Cr) >0 AND  PBT before Q1 >0 AND PAT 2 Qtr Ago (Rs Cr) >0 AND PAT 3 Qtr Ago (Rs Cr) >0 AND PAT 4 Qtr Ago (Rs Cr) >0 AND Qtr Net Profit % >10 AND  Net Profit QoQ Chg (%) >20 AND Qtr Net profit YoY Chg (%) >20 AND  Pitroski Score >=6' },
        { id: 'et-362', provider: 'et', screenerId: '362', name: 'RSI Oversold',           queryCondition: ' RSI Current<30 AND RSI Previous<30' },
      ]},
      { category: 'Sector GEMS (ET)', items: [
        { id: 'et-518',  provider: 'et', screenerId: '518',  name: 'The Tata Empire',   queryCondition: ' Tata = True' },
        { id: 'et-520',  provider: 'et', screenerId: '520',  name: 'Adani Universe',    queryCondition: ' Adani Group = True' },
        { id: 'et-514',  provider: 'et', screenerId: '514',  name: 'PSU Gems',          queryCondition: ' Handpicked PSU Gems = True' },
        { id: 'et-515',  provider: 'et', screenerId: '515',  name: 'Monopoly Biz',      queryCondition: ' Monopoly Businesses = True' },
        { id: 'et-1101', provider: 'et', screenerId: '1101', name: 'Defence Sector',    queryCondition: ' Industry=2076' },
        { id: 'et-1100', provider: 'et', screenerId: '1100', name: 'Infra Boost',       queryCondition: ' Industry =2141 AND  PB TTM >=0 AND  Market Cap (Rs Cr) >=300' },
      ]},
    ]),

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
