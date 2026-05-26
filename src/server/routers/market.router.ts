import { z } from "zod";
import {
  fetchAllIndianIndices,
  fetchGlobalIndices,
  fetchSectorPerformance,
  fetchHistoricalOHLC,
  fetchMarketMap,
} from "../marketData";
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
      } catch {}
      return {
        nifty50:   { indId: '9',  value: 22450.2, change: 124.5,  changePct:  0.56 },
        sensex:    { indId: '4',  value: 73850.4, change: 412.1,  changePct:  0.56 },
        bankNifty: { indId: '23', value: 48250.3, change: -120.4, changePct: -0.25 },
      };
    }),

  getTopMovers: publicProcedure
    .query(async () => fetchTopMovers()),

  getBreakouts: publicProcedure
    .query(async () => fetchNiftyTraderBreakouts()),

  getSectorPerformance: publicProcedure
    .input(z.object({ indexId: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const data = await fetchSectorPerformance(input?.indexId);
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
