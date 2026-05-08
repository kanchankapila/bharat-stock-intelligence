import { initTRPC } from "@trpc/server";
import { z } from "zod";
import superjson from "superjson";
import db from "./db";
import { generateStockAnalysis } from "../services/aiService";
import { fetchMCScreener } from "./moneycontrol";
import { fetchETnowScreener } from "./etnow";
import { 
  fetchTechIndicators, 
  fetchMarketMap, 
  fetchAllIndianIndices, 
  fetchTrendlyneFundamentals,
  fetchMCRatios,
  fetchETShareholding,
  fetchETCorporateActions,
  fetchHistoricalOHLC,
  fetchSectorPerformance,
  fetchGlobalIndices,
  fetchMFInvestments,
  fetchTrendingScreeners,
  fetchETPennyStocks,
  fetchTechnicalTrends,
  fetchETStats
} from "./marketData";
import { getMoneycontrolInsights } from "./moneycontrolService";
import { getStockInsights, getIndexData } from "./insightService";
import { getAllStocks, getStockMapping } from "./stockMapping";
import { getCachedScan, runTechnicalScan } from "./technicalScanner";
import { getFnOSignals } from "./fnoService";
import { fetchStockDataWithCache, getOrRefreshAllStocks } from "./liveStockData";

const t = initTRPC.create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Mock data for static stock list
const stocks = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', price: 2954.20, change: 14.45, changePct: 0.49, volume: '2.4M', sector: 'Energy', high: 3000, low: 2900 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', price: 3982.15, change: -12.40, changePct: -0.31, volume: '1.2M', sector: 'IT', high: 4050, low: 3950 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', price: 1542.80, change: 8.20, changePct: 0.53, volume: '8.4M', sector: 'Banking', high: 1560, low: 1530 },
  { symbol: 'INFY', name: 'Infosys Limited', price: 1420.30, change: -4.30, changePct: -0.30, volume: '3.1M', sector: 'IT', high: 1450, low: 1400 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank Ltd', price: 1084.50, change: 15.60, changePct: 1.46, volume: '5.2M', sector: 'Banking', high: 1100, low: 1060 },
  { symbol: 'ADANIENT', name: 'Adani Enterprises Ltd', price: 3214.50, change: 128.30, changePct: 4.15, volume: '4.8M', sector: 'Diversified', high: 3300, low: 3150 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd', price: 1210.40, change: 12.10, changePct: 1.01, volume: '2.9M', sector: 'Telecom', high: 1230, low: 1190 },
  { symbol: 'ITC', name: 'ITC Limited', price: 428.15, change: -2.35, changePct: -0.55, volume: '12.4M', sector: 'Consumer Goods', high: 435, low: 425 },
  { symbol: 'AXISBANK', name: 'Axis Bank Ltd', price: 1120.45, change: 14.20, changePct: 1.28, volume: '4.1M', sector: 'Banking', high: 1140, low: 1100 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', price: 1785.30, change: -5.40, changePct: -0.30, volume: '2.2M', sector: 'Banking', high: 1810, low: 1770 },
  { symbol: 'LT', name: 'Larsen & Toubro Ltd', price: 3450.20, change: 45.30, changePct: 1.33, volume: '1.5M', sector: 'Infrastructure', high: 3480, low: 3400 },
  { symbol: 'SBIN', name: 'State Bank of India', price: 780.45, change: 12.15, changePct: 1.58, volume: '15.4M', sector: 'Banking', high: 790, low: 765 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance Ltd', price: 6850.30, change: -50.20, changePct: -0.73, volume: '0.8M', sector: 'Finance', high: 6950, low: 6800 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki India', price: 12450.00, change: 210.50, changePct: 1.72, volume: '0.5M', sector: 'Auto', high: 12600, low: 12300 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints Ltd', price: 2840.15, change: -15.45, changePct: -0.54, volume: '1.1M', sector: 'Consumer Goods', high: 2880, low: 2820 },
  { symbol: 'M&M', name: 'Mahindra & Mahindra', price: 2150.80, change: 85.40, changePct: 4.13, volume: '2.3M', sector: 'Auto', high: 2180, low: 2060 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', price: 1540.25, change: -8.10, changePct: -0.52, volume: '1.9M', sector: 'Healthcare', high: 1560, low: 1530 },
  { symbol: 'WIPRO', name: 'Wipro Limited', price: 460.15, change: -2.35, changePct: -0.51, volume: '5.4M', sector: 'IT', high: 468, low: 458 },
  { symbol: 'TITAN', name: 'Titan Company Ltd', price: 3250.40, change: 12.50, changePct: 0.39, volume: '1.2M', sector: 'Consumer Goods', high: 3280, low: 3230 },
  { symbol: 'HCLTECH', name: 'HCL Technologies', price: 1340.20, change: -5.80, changePct: -0.43, volume: '1.8M', sector: 'IT', high: 1360, low: 1330 },
];
export const appRouter = router({
  getAIAnalysis: publicProcedure

    .input(z.object({ 
      symbol: z.string(), 
      data: z.record(z.unknown()) 
    }))
    .mutation(async ({ input }) => {
      return await generateStockAnalysis(input.symbol, input.data);
    }),

  syncUser: publicProcedure

    .input(z.object({
      id: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      photoURL: z.string().nullable(),
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO users (id, email, name, photoURL)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          photoURL = excluded.photoURL
      `);
      stmt.run(input.id, input.email, input.name, input.photoURL);
      return { success: true };
    }),

  // --- Watchlist Procedures ---
  getWatchlist: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT symbol FROM watchlist WHERE userId = ? ORDER BY addedAt DESC')
        .all(input.userId) as { symbol: string }[];
      return rows.map(r => r.symbol);
    }),

  addToWatchlist: publicProcedure
    .input(z.object({ userId: z.string(), symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare('INSERT OR IGNORE INTO watchlist (userId, symbol) VALUES (?, ?)');
      stmt.run(input.userId, input.symbol);
      return { success: true };
    }),

  removeFromWatchlist: publicProcedure
    .input(z.object({ userId: z.string(), symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare('DELETE FROM watchlist WHERE userId = ? AND symbol = ?');
      stmt.run(input.userId, input.symbol);
      return { success: true };
    }),

  // --- Signal Procedures (Refactored to SQLite) ---
  getSignals: publicProcedure
    .input(z.object({ limit: z.number().optional().default(5) }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT * FROM signals ORDER BY createdAt DESC LIMIT ?')
        .all(input.limit);
      return rows;
    }),

  saveSignal: publicProcedure
    .input(z.object({
      symbol: z.string(),
      type: z.enum(["BUY", "SELL", "HOLD"]),
      entry: z.number(),
      target: z.number(),
      stopLoss: z.number(),
      confidence: z.number(),
      reasoning: z.string(),
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `);
      stmt.run(input.symbol, input.type, input.entry, input.target, input.stopLoss, input.confidence, input.reasoning);
      return { success: true };
    }),

  getSignalHistory: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT * FROM signals WHERE symbol = ? ORDER BY createdAt DESC')
        .all(input.symbol);
      return rows;
    }),

  getAccuracyMetrics: publicProcedure.query(async () => {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM signals
    `).get() as { total: number, completed: number, failed: number };
    
    const relevant = (stats.completed || 0) + (stats.failed || 0);
    
    return {
      precision: relevant > 0 ? (stats.completed / relevant) * 100 : 0,
      totalSignals: stats.total || 0,
      profitHitRate: relevant > 0 ? (stats.completed / relevant) * 100 : 0,
    };
  }),

  // --- Backtest Procedures (Refactored to SQLite) ---
  saveBacktestStrategy: publicProcedure
    .input(z.object({
      name: z.string(),
      symbol: z.string(),
      timeframe: z.string(),
      params: z.object({
        rsiUpper: z.number(),
        rsiLower: z.number(),
        emaShort: z.number(),
        emaLong: z.number(),
      })
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO backtest_strategies (name, symbol, timeframe, params)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(input.name, input.symbol, input.timeframe, JSON.stringify(input.params));
      return { success: true };
    }),

  getBacktestStrategies: publicProcedure
    .query(async () => {
      const rows = db.prepare('SELECT * FROM backtest_strategies ORDER BY createdAt DESC').all() as any[];
      return rows.map(r => ({ ...r, params: JSON.parse(r.params) }));
    }),

  // --- Existing Market Data Procedures (Unchanged) ---
  getFnOSignals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getFnOSignals(input.symbol);
    }),

  getTechnicalScan: publicProcedure
    .input(z.object({ symbol: z.string(), forceRefresh: z.boolean().optional() }))
    .query(async ({ input }) => {
      const { symbol, forceRefresh } = input;
      if (!forceRefresh) {
        const cached = await getCachedScan(symbol);
        if (cached) return cached;
      }
      return await runTechnicalScan(symbol);
    }),

  getStockList: publicProcedure.query(() => {
    return getAllStocks();
  }),

  // LIVE STOCK DATA ENDPOINTS
  // Fetch real-time quotes from external APIs instead of dummy data
  // Data sources: MoneyControl API, Finnhub, BSE/NSE Direct
  getLiveStockQuote: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const quoteData = await fetchStockDataWithCache(input.symbol);
      if (!quoteData) {
        throw new Error(`Failed to fetch live data for ${input.symbol}`);
      }
      return quoteData;
    }),

  getLiveStocks: publicProcedure.query(async () => {
    // Returns all live stock quotes
    // Fetches from MoneyControl API with fallback to Finnhub
    // Data is cached for 30 seconds per stock
    return await getOrRefreshAllStocks();
  }),

  getRatios: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchMCRatios(input.symbol);
    }),

  getShareholding: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchETShareholding(input.symbol);
    }),

  getCorporateActions: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchETCorporateActions(input.symbol);
    }),

  getStockDetailsMap: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => {
      return getStockMapping(input.symbol);
    }),

  getTechnicalDetails: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.enum(['D', 'W', 'M']).optional() }))
    .query(async ({ input }) => {
      return await fetchTechIndicators(input.symbol, input.dur);
    }),

  getInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getMoneycontrolInsights(input.symbol);
    }),

  getStockInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getStockInsights(input.symbol);
    }),

  getIndexDetails: publicProcedure
    .input(z.object({ indexId: z.string() }))
    .query(async ({ input }) => {
      return await getIndexData(input.indexId);
    }),

  getMarketMapData: publicProcedure
    .input(z.object({ indId: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchMarketMap(input.indId);
    }),

  getOHLCData: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchHistoricalOHLC(input.symbol, input.dur);
    }),

  getAllIndices: publicProcedure.query(async () => {
    return await fetchAllIndianIndices();
  }),

  getGlobalIndices: publicProcedure.query(async () => {
    return await fetchGlobalIndices();
  }),

  getTrendlyneFundamentals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchTrendlyneFundamentals(input.symbol);
    }),

  getMFInvestments: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchMFInvestments(input.symbol);
    }),

  getTrendingScreeners: publicProcedure.query(async () => {
    return await fetchTrendingScreeners();
  }),

  getETPennyStocks: publicProcedure.query(async () => {
    return await fetchETPennyStocks();
  }),

  getTechnicalTrends: publicProcedure
    .input(z.object({ 
      type: z.enum(['bullish', 'bearish', 'turning-bullish', 'turning-bearish']), 
      index: z.string().optional() 
    }))
    .query(async ({ input }) => {
      return await fetchTechnicalTrends(input.type, input.index);
    }),

  getETStats: publicProcedure
    .input(z.object({ 
      type: z.enum(['gainers', 'losers']), 
      duration: z.string().optional() 
    }))
    .query(async ({ input }) => {
      return await fetchETStats(input.type, input.duration);
    }),

  getStocks: publicProcedure
    .input(z.object({ limit: z.number().optional().default(10), sector: z.string().optional() }))
    .query(({ input }) => {
      let filtered = stocks;
      if (input.sector) {
        filtered = stocks.filter(s => s.sector === input.sector);
      }
      return filtered.slice(0, input.limit);
    }),

  getSectorPerformance: publicProcedure
    .input(z.object({ indexId: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const data = await fetchSectorPerformance(input?.indexId);
      if (data && data.success === 1 && data.data) {
        return data.data.map((s: any) => ({
          name: s.sectorName,
          change: parseFloat(s.percentChange),
          stocks: s.stocksCount || 0
        }));
      }
      
      const sectors = ['Energy', 'IT', 'Banking', 'Consumer Goods', 'Telecom'];
      return sectors.map(sector => ({
        name: sector,
        change: (Math.random() - 0.4) * 2,
        stocks: stocks.filter(s => s.sector === sector).length
      }));
    }),

  getScreenerResults: publicProcedure
    .input(z.object({
      filter: z.string(),
      sector: z.string().optional(),
      minPe: z.number().optional(),
      maxPe: z.number().optional(),
      minRoe: z.number().optional(),
      maxPb: z.number().optional(),
      maxDe: z.number().optional(),
    }))
    .query(({ input }) => {
      let data = stocks.map(s => ({
        ...s,
        pe: 15 + (Math.sin(s.symbol.length) + 1) * 15,
        roe: 10 + (Math.cos(s.symbol.length) + 1) * 10,
        pb: 2 + (Math.sin(s.symbol.length * 2) + 1) * 4,
        debtEquity: (Math.abs(Math.sin(s.symbol.length * 3))) * 2,
        high52w: s.price * (1.1 + Math.abs(Math.sin(s.symbol.length)) * 0.2),
        low52w: s.price * (0.7 + Math.abs(Math.cos(s.symbol.length)) * 0.2),
      }));

      if (input.filter === 'High ROE') {
        data = data.filter(s => s.roe > 15);
      } else if (input.filter === 'Low Debt') {
        data = data.filter(s => s.debtEquity < 0.5);
      } else if (input.filter === 'Gainers') {
        data = data.filter(s => s.changePct > 0);
      } else if (input.filter === 'Losers') {
        data = data.filter(s => s.changePct < 0);
      } else if (input.filter === 'Near 52W High') {
        data = data.filter(s => (s.price / s.high52w) > 0.95);
      } else if (input.filter === 'Near 52W Low') {
        data = data.filter(s => (s.price / s.low52w) < 1.05);
      }

      if (input.sector && input.sector !== 'All') {
        data = data.filter(s => s.sector === input.sector);
      }

      if (input.minPe !== undefined) data = data.filter(s => s.pe >= input.minPe!);
      if (input.maxPe !== undefined) data = data.filter(s => s.pe <= input.maxPe!);
      if (input.minRoe !== undefined) data = data.filter(s => s.roe >= input.minRoe!);
      if (input.maxPb !== undefined) data = data.filter(s => s.pb <= input.maxPb!);
      if (input.maxDe !== undefined) data = data.filter(s => s.debtEquity <= input.maxDe!);

      return data;
    }),
  
  getMarketOverview: publicProcedure.query(() => {
    return {
      nifty50: { value: 22450.2, change: 124.5, changePct: 0.56 },
      sensex: { value: 73850.4, change: 412.1, changePct: 0.56 },
      bankNifty: { value: 48250.3, change: -120.4, changePct: -0.25 },
    };
  }),

  getMarketScanners: publicProcedure.query(() => {
    return [
      { category: 'Breakout Intelligence', items: [
        { id: 'mc-25-OHLC_D_P_BPBULL', provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL', name: 'Range Breakout', type: 'techscanner' as const },
        { id: 'mc-25-OHLC_D_P_WIBL', provider: 'mc', catId: 25, scanId: 'OHLC_D_P_WIBL', name: 'White Marubozu', type: 'techscanner' as const },
        { id: 'mc-25-OHLC_D_I_RSIPOWBO', provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO', name: 'RSI Resistance BO', type: 'techscanner' as const },
        { id: 'mc-patterns-triangle', provider: 'mc', catId: 'patterns', scanId: 'triangle', name: 'Triangle Breakout', type: 'techscanner' as const },
        { id: 'mc-patterns-flag', provider: 'mc', catId: 'patterns', scanId: 'flag', name: 'Flag Pattern', type: 'techscanner' as const },
      ]},
      { category: 'Multi-Timeframe Highs', items: [
        { id: 'hh-15m-1h', provider: 'custom', name: '15m & 1h New Highs', type: 'multi-tf' as const, timeframes: ['15m', '1h'] },
        { id: 'hh-1h-4h-d', provider: 'custom', name: '1h, 4h & Daily Highs', type: 'multi-tf' as const, timeframes: ['1h', '4h', 'D'] },
        { id: 'hh-d-w', provider: 'custom', name: 'Daily & Weekly Highs', type: 'multi-tf' as const, timeframes: ['D', 'W'] },
      ]},
      { category: 'Value & Quality (MC)', items: [
        { id: 'mc-1-146', provider: 'mc', catId: 1, scanId: '146', name: 'Bargain Buys', type: 'proscanner' as const },
        { id: 'mc-1-181', provider: 'mc', catId: 1, scanId: '181', name: 'Reasonable Price', type: 'proscanner' as const },
        { id: 'mc-1-178', provider: 'mc', catId: 1, scanId: '178', name: 'Growth Stocks', type: 'proscanner' as const },
      ]},
      { category: 'Technical Breakouts (MC)', items: [
        { id: 'mc-25-BPBULL', provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL', name: 'Bullish Breakaway', type: 'techscanner' as const },
        { id: 'mc-25-RSIPOWBO', provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO', name: 'RSI Power BO', type: 'techscanner' as const },
        { id: 'mc-17-52HIGH', provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52HIGH', name: '52 Week High', type: 'techscanner' as const },
        { id: 'mc-17-52LOW', provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52LOW', name: '52 Week Low', type: 'techscanner' as const },
      ]},
      { category: 'Technical Trends (MC)', items: [
        { id: 'mc-tt-bullish', provider: 'mc', catId: 'uptrend/bullish', scanId: '7', name: 'Nifty 500 Bullish', type: 'technical-trends' as const },
        { id: 'mc-tt-turning-bullish', provider: 'mc', catId: 'uptrend/turning-bullish', scanId: '7', name: 'Turning Bullish', type: 'technical-trends' as const },
        { id: 'mc-tt-bearish', provider: 'mc', catId: 'downtrend/bearish', scanId: '7', name: 'Nifty 500 Bearish', type: 'technical-trends' as const },
        { id: 'mc-tt-turning-bearish', provider: 'mc', catId: 'downtrend/turning-bearish', scanId: '7', name: 'Turning Bearish', type: 'technical-trends' as const },
      ]},
      { category: 'ETnow Elite (ET)', items: [
        { id: 'et-73', provider: 'et', screenerId: '73', name: 'Cash Cows', queryCondition: " Cash & Cash Equiv (Rs Cr) >=2500 AND  CF Operations (Rs Cr) >=1000 AND  Chg in Working Cap (Rs Cr) >=3000 AND   Quick Ratio >=1.5" },
        { id: 'et-75', provider: 'et', screenerId: '75', name: 'Elite Bluechips', queryCondition: " Market Cap (Rs Cr) > 60000  AND  Pitroski Score  >=6 AND  Return on Equity (%) >=  Avg ROE 5Y (%) AND  ROA (%) >=  Avg ROA 5Y AND  PEG Ratio <=1.5 AND CFO_By_Profit After Tax (Rs Cr) >=1" },
        { id: 'et-79', provider: 'et', screenerId: '79', name: 'Zero Debt Quality', queryCondition: " Debt to Equity <=0.1 AND  LT DE Ratio <=0.1 AND  Int Coverage Ratio >=100 AND Market Cap (Rs Cr) >=500 AND  Z Score >=3 AND  Pitroski Score >=6" },
        { id: 'et-91', provider: 'et', screenerId: '91', name: 'Buy on Dips', queryCondition: " Pitroski Score >=6 AND  YTD Returns (%) <=15 AND  PEG Ratio <=0.8 AND  Sustainable Growth (%) >=7 AND  Market Cap (Rs Cr) >=2000 AND  CFO_By_Profit After Tax (Rs Cr) >=1 AND  PEG Ratio >=0" },
        { id: 'et-195', provider: 'et', screenerId: '195', name: 'Potential Multibaggers', queryCondition: " Return on Equity (%) >  Return on Equity 1Y (%) AND  Return on Equity (%) >=20 AND  EBITDA Margin % >  EBITDA Margin % 1Y AND  Sustainable Growth (%) >=15 AND Earnings Retention % Net Profit >=85 AND  LT DE Ratio <=1 AND CFO_By_Profit After Tax (Rs Cr) >= 1 AND  Rel Ret vs BSE 500 YTD >=1 AND  PEG Ratio <=1" },
        { id: 'et-118', provider: 'et', screenerId: '118', name: 'Straight Flush', queryCondition: " Qtr Net Profit (Rs Cr) >0 AND  PBT before Q1 >0 AND PAT 2 Qtr Ago (Rs Cr) >0 AND PAT 3 Qtr Ago (Rs Cr) >0 AND PAT 4 Qtr Ago (Rs Cr) >0 AND Qtr Net Profit % >10 AND  Net Profit QoQ Chg (%) >20 AND Qtr Net profit YoY Chg (%) >20 AND  Pitroski Score >=6" },
        { id: 'et-362', provider: 'et', screenerId: '362', name: 'RSI Oversold', queryCondition: " RSI Current<30 AND RSI Previous<30" },
      ]},
      { category: 'Sector GEMS (ET)', items: [
        { id: 'et-518', provider: 'et', screenerId: '518', name: 'The Tata Empire', queryCondition: " Tata = True" },
        { id: 'et-520', provider: 'et', screenerId: '520', name: 'Adani Universe', queryCondition: " Adani Group = True" },
        { id: 'et-514', provider: 'et', screenerId: '514', name: 'PSU Gems', queryCondition: " Handpicked PSU Gems = True" },
        { id: 'et-515', provider: 'et', screenerId: '515', name: 'Monopoly Biz', queryCondition: " Monopoly Businesses = True" },
        { id: 'et-1101', provider: 'et', screenerId: '1101', name: 'Defence Sector', queryCondition: " Industry=2076" },
        { id: 'et-1100', provider: 'et', screenerId: '1100', name: 'Infra Boost', queryCondition: " Industry =2141 AND  PB TTM >=0 AND  Market Cap (Rs Cr) >=300" },
      ]}
    ];
  }),

  fetchMarketData: publicProcedure
    .input(z.object({
      provider: z.string(),
      params: z.any()
    }))
    .query(async ({ input }) => {
      try {
        if (input.provider === 'mc') {
          const { type, catId, scanId } = input.params;
          return await fetchMCScreener(type as any, catId, scanId);
        } else if (input.provider === 'et') {
          const { screenerId, queryCondition } = input.params;
          return await fetchETnowScreener(screenerId, queryCondition);
        } else if (input.provider === 'custom') {
          const { timeframes } = input.params;
          const selected = stocks.filter(() => Math.random() > 0.7).map(s => ({
            symbol: s.symbol,
            name: s.name,
            ltp: s.price * (1 + (Math.random() - 0.5) * 0.01),
            perChg: (Math.random() * 5).toFixed(2),
            volume: (Math.random() * 1000000).toFixed(0),
            mktCap: "₹" + (Math.random() * 100000).toFixed(0) + " Cr",
            sector: s.sector,
            timeframesMet: timeframes?.join(", ") || "D, W",
            momentum: "Strong Bullish",
            pattern: "Channel Breakout"
          }));

          return {
            success: true,
            searchResult: { searchData: { records: selected } },
            data: {
              list: {
                scannerDetails: selected.map(s => ({
                  ...s,
                  columns: [
                    { name: "LTP", value: s.ltp },
                    { name: "% Change", value: s.perChg },
                    { name: "Volume", value: s.volume },
                    { name: "Momentum", value: s.momentum }
                  ]
                }))
              }
            }
          };
        }
      } catch (error) {
        console.error("Market Data Fetch Error:", error);
        throw new Error("Failed to fetch market data from provider.");
      }
    }),

  runBacktest: publicProcedure
    .input(z.object({ 
      symbol: z.string(), 
      strategy: z.string(), 
      period: z.string(),
      params: z.object({
        rsiUpper: z.number().optional(),
        rsiLower: z.number().optional(),
        emaShort: z.number().optional(),
        emaLong: z.number().optional(),
      }).optional()
    }))
    .mutation(async ({ input }) => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const rsiDiff = (input.params?.rsiUpper || 70) - (input.params?.rsiLower || 30);
      const emaDiff = (input.params?.emaLong || 50) - (input.params?.emaShort || 20);
      const winRateBase = 60 + (rsiDiff / 10);
      const returnBase = 30 + (emaDiff / 2);

      return {
        winRate: parseFloat(winRateBase.toFixed(1)),
        profitFactor: 2.14,
        maxDrawdown: 12.5,
        totalReturn: parseFloat(returnBase.toFixed(1)),
        trades: 124,
        history: Array.from({ length: 100 }, (_, i) => ({ day: i, equity: 10000 * Math.pow(1.002, i) + Math.random() * 500, drawdown: -Math.random() * 5 }))
      };
    }),

  generateTrendReport: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stock = stocks.find(s => s.symbol === input.symbol);
      if (!stock) throw new Error("Stock not found");
      
      const analysis = await generateStockAnalysis(stock.symbol, stock);
      return {
        title: `${stock.symbol} Deep Intelligence Report`,
        summary: `Strategic analysis for ${stock.name} based on current market dynamics.`,
        investmentThesis: analysis.reasoning,
        riskFactors: [
          "Market volatility and sector-specific rotation.",
          "Potential resistance near multi-month highs.",
          "Global macro-economic shifts affecting export revenues."
        ],
        outlook: analysis.sentiment,
        generatedAt: new Date().toISOString()
      };
    }),
});

export type AppRouter = typeof appRouter;
