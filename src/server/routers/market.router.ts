import { z } from "zod";
import { dbGet, dbAll } from "../dbAsync";
import {
  fetchAllIndianIndices,
  fetchGlobalIndices,
  fetchSectorPerformance,
  fetchHistoricalOHLC,
  fetchMarketMap,
} from "../marketData";
import { fetchSectorTechnicalTrends } from "../sectorApiService";
import { fetchStockDataWithCache, getOrRefreshAllStocks } from "../liveStockData";
import { fetchTopMovers } from "../topMoversService";
import { fetchNiftyTraderBreakouts } from "../marketData";
import { fetchGlobalMarketData } from "../globalMarketService";
import { generateStockAnalysis } from "../../services/aiService";
import { router, publicProcedure } from "../trpc";

export const marketRouter = router({
  getGlobalMarketData: publicProcedure
    .query(async () => fetchGlobalMarketData()),

  getLiveStocks: publicProcedure
    .query(async () => getOrRefreshAllStocks()),

  getLiveStockQuote: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const data = await fetchStockDataWithCache(input.symbol);
      if (!data) throw new Error(`Failed to fetch live data for ${input.symbol}`);
      return data;
    }),

  getLiveQuotesBatch: publicProcedure
    .input(z.array(z.string()))
    .query(async ({ input }) => {
      if (!input || input.length === 0) return [];
      const results = await Promise.all(input.map(sym => fetchStockDataWithCache(sym)));
      return results.filter(Boolean);
    }),

  getStocks: publicProcedure
    .input(z.object({ limit: z.number().optional().default(10), sector: z.string().optional() }))
    .query(async ({ input }) => {
      const all = await getOrRefreshAllStocks();
      const filtered = input.sector ? all.filter((s: any) => s.sector === input.sector) : all;
      return filtered.slice(0, input.limit);
    }),

  getMarketOverview: publicProcedure
    .query(async () => {
      const parse = (s: unknown) => parseFloat(String(s ?? '0').replace(/,/g, '')) || 0;
      const { getIndexByName } = await import('../indexMapping');
      const extractId = (name: string, url: string) => {
        const m = url?.match(/-(\d+)\.html$/);
        if (m) return m[1];
        return getIndexByName(name)?.id || null;
      };
      try {
        const data = await fetchAllIndianIndices();
        if (data?.success === 1) {
          const keyList: any[] = data.data?.indiceList?.[0]?.list ?? [];
          const find = (name: string) => keyList.find((i: any) => i.name === name);
          const n50 = find('NIFTY 50');
          const sx  = find('SENSEX');
          const bnk = find('NIFTY BANK');
          if (n50 && sx && bnk) {
            return {
              nifty50:   { indId: extractId('NIFTY 50', n50.url),    value: parse(n50.value),  change: parse(n50.change),  changePct: parse(n50.changePer)  },
              sensex:    { indId: extractId('SENSEX', sx.url),        value: parse(sx.value),   change: parse(sx.change),   changePct: parse(sx.changePer)   },
              bankNifty: { indId: extractId('NIFTY BANK', bnk.url),  value: parse(bnk.value),  change: parse(bnk.change),  changePct: parse(bnk.changePer)  },
            };
          }
        }
      } catch (e) { console.error(e); }
      return {
        nifty50:   { indId: '9',  value: null, change: null, changePct: null, stale: true },
        sensex:    { indId: '4',  value: null, change: null, changePct: null, stale: true },
        bankNifty: { indId: '23', value: null, change: null, changePct: null, stale: true },
      };
    }),

  getTopMovers: publicProcedure
    .query(async () => fetchTopMovers()),

  getBreakouts: publicProcedure
    .query(async () => fetchNiftyTraderBreakouts()),

  getEarlyHoursPredictions: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(async ({ input }) => {
      let targetDate = input?.date;
      if (!targetDate) {
        const row = await dbGet<{ date: string }>(
          'SELECT MAX(date) as date FROM early_hours_predictions'
        );
        targetDate = row?.date;
      }
      if (!targetDate) return [];
      
      const rows = await dbAll<any>(
        'SELECT * FROM early_hours_predictions WHERE date = ? ORDER BY score DESC',
        [targetDate]
      );
      
      return rows.map((r: any) => ({
        symbol: r.symbol,
        date: r.date,
        score: r.score,
        iepGapPct: r.iep_gap_pct,
        preopenImbalance: r.preopen_imbalance,
        deliverySpikePct: r.delivery_spike_pct,
        hasCorporateAction: r.has_corporate_action === 1,
        corporateActionTitle: r.corporate_action_title,
        breakoutSignals: r.breakout_signals ? r.breakout_signals.split(',') : [],
        reasons: JSON.parse(r.reasons_json || '[]'),
        computedAt: r.computed_at,
      }));
    }),

  getSectorPerformance: publicProcedure
    .input(z.object({
      indexId: z.string().optional(),
      dur:     z.enum(['1d', '5d', '1m', '3m', '6m', '1y']).optional(),
      type:    z.enum(['top', 'under']).optional(),
      section: z.enum(['sector', 'industry']).optional(),
      limit:   z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const data = await fetchSectorPerformance(input);
      if (data && data.success === 1 && data.data) {
        return data.data.map((s: any) => {
          const name = s.sectorName || s.sector || 'Unknown';
          const rawChange = s.percentChange ?? s.mcapPerChange ?? 0;
          const change = typeof rawChange === 'number' ? rawChange : parseFloat(String(rawChange).replace(/,/g, ''));
          return { name, change: isNaN(change) ? 0 : change, stocks: s.stocksCount || 0 };
        });
      }
      const allStocks = await getOrRefreshAllStocks();
      const sectorMap = new Map<string, number[]>();
      for (const stock of allStocks) {
        const sector = (stock as any).sector || (stock as any).industry;
        if (sector && sector !== 'Unknown') {
          if (!sectorMap.has(sector)) sectorMap.set(sector, []);
          sectorMap.get(sector)!.push(stock.changePct);
        }
      }
      return Array.from(sectorMap.entries())
        .map(([name, changes]) => {
          const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
          return { name, change: isNaN(avgChange) ? 0 : Number(avgChange.toFixed(2)), stocks: changes.length };
        })
        .sort((a, b) => b.change - a.change);
    }),

  getSectorTechnicalTrends: publicProcedure
    .input(z.object({ sectorName: z.string() }))
    .query(async ({ input }) => {
      return await fetchSectorTechnicalTrends(input.sectorName);
    }),

  getOHLCData: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.string().optional() }))
    .query(async ({ input }) => fetchHistoricalOHLC(input.symbol, input.dur)),

  getMarketMapData: publicProcedure
    .input(z.object({ indId: z.string().optional() }))
    .query(async ({ input }) => fetchMarketMap(input.indId)),

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
    .query(async ({ input }) => {
      const allStocks = await getOrRefreshAllStocks();
      let data: any[] = allStocks;
      if (input.filter === 'Gainers') {
        data = data.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
      } else if (input.filter === 'Losers') {
        data = data.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
      } else if (input.filter === 'Near 52W High') {
        data = data.filter(s => s.high52w && s.high52w > 0 && (s.price / s.high52w) > 0.95)
          .sort((a, b) => (b.price / b.high52w) - (a.price / a.high52w));
      } else if (input.filter === 'Near 52W Low') {
        data = data.filter(s => s.low52w && s.low52w > 0 && (s.price / s.low52w) < 1.05)
          .sort((a, b) => (a.price / a.low52w) - (b.price / b.low52w));
      } else if (input.filter === 'High Volume') {
        data = [...data].sort((a: any, b: any) => {
          const parseVol = (v: string) => {
            if (!v) return 0;
            if (v.endsWith('M')) return parseFloat(v) * 1_000_000;
            if (v.endsWith('K')) return parseFloat(v) * 1_000;
            return parseFloat(v) || 0;
          };
          return parseVol(b.volume) - parseVol(a.volume);
        });
      }
      if (input.sector && input.sector !== 'All') {
        data = data.filter(s => s.sector === input.sector);
      }
      return data.slice(0, 200);
    }),

  generateTrendReport: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stock = await fetchStockDataWithCache(input.symbol);
      if (!stock) throw new Error('Stock not found');
      const analysis = await generateStockAnalysis(stock.symbol, stock);
      return {
        title: `${stock.symbol} Deep Intelligence Report`,
        summary: `Strategic analysis for ${(stock as any).name || stock.symbol} based on current market dynamics.`,
        investmentThesis: analysis.reasoning,
        riskFactors: [
          'Market volatility and sector-specific rotation.',
          'Potential resistance near multi-month highs.',
          'Global macro-economic shifts affecting export revenues.',
        ],
        outlook: analysis.sentiment,
        generatedAt: new Date().toISOString(),
      };
    }),
});
