import { z } from "zod";
import {
  fetchTrendlyneSwot,
  fetchTrendlyneChecklist,
  getTrendlyneDVMFromDb,
  fetchTrendlyneStockMetrics,
  fetchTrendlyneAdvTechnicalAnalysis,
  getTrendlyneOverview,
  fetchTrendlyneSectorRotation,
  fetchTrendlyneIndexRotation,
  fetchTrendlyneStockOptionChain,
} from "../trendlyneService";
import { fetchTrendlyneJsonScreener, fetchTrendlyneAllInOneScreener } from "../marketData";
import { router, publicProcedure } from "../trpc";
import { ensureTrendlyneSession, fetchTrendlyneWithAuth } from '../trendlyneAuthService';

export const trendlyneRouter = router({
  getTrendlyneSwot: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchTrendlyneSwot(input.symbol)),

  getTrendlyneChecklist: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchTrendlyneChecklist(input.symbol)),

  getTrendlyneDVM: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getTrendlyneDVMFromDb(input.symbol)),

  getTrendlyneStockMetrics: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchTrendlyneStockMetrics(input.symbol)),

  getTrendlyneStockOptionChain: publicProcedure
    .input(z.object({ symbol: z.string(), expiryDate: z.string().optional() }))
    .query(async ({ input }) => fetchTrendlyneStockOptionChain(input.symbol, input.expiryDate)),

  getTrendlyneStockExpiries: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const symbol = input.symbol.toUpperCase();
      try {
        const res = await fetch(
          `https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=${symbol}&exchange=nse`,
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
        );
        if (res.ok) {
          const json = await res.json();
          const list = json?.resultData?.filter((d: any) => d.symbol_name === symbol) || [];
          return list.map((d: any) => d.expiry_date.split('T')[0]);
        }
      } catch { /* fall through to default */ }
      return [new Date().toISOString().split('T')[0]];
    }),

  getTrendlyneAdvTechnicalAnalysis: publicProcedure
    .input(z.object({ symbol: z.string(), timeframe: z.enum(['D', 'W', 'M']).optional().default('D') }))
    .query(async ({ input }) => fetchTrendlyneAdvTechnicalAnalysis(input.symbol, input.timeframe)),

  getTrendlyneOverview: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getTrendlyneOverview(input.symbol)),

  getTrendlyneSectorRotation: publicProcedure
    .query(async () => fetchTrendlyneSectorRotation()),

  getTrendlyneIndexRotation: publicProcedure
    .query(async () => fetchTrendlyneIndexRotation()),

  getTrendlyneHealth: publicProcedure
    .query(async () => {
      try {
        const auth = await ensureTrendlyneSession();
        let fetchOk = false;
        let status: number | null = null;
        if (auth) {
          try {
            const res = await fetchTrendlyneWithAuth('https://trendlyne.com/', { method: 'GET' });
            fetchOk = res.ok;
            status = res.status;
          } catch (e) {
            fetchOk = false;
          }
        }
        return { auth, fetchOk, status };
      } catch (e) {
        return { auth: false, fetchOk: false, status: null };
      }
    }),

  getTrendlyneJsonScreener: publicProcedure
    .input(z.object({ screenerId: z.string(), limit: z.number().optional().default(25) }))
    .query(async ({ input }) => fetchTrendlyneJsonScreener(input.screenerId, input.limit)),

  getTrendlyneAIOScreener: publicProcedure
    .input(z.object({ screenpk: z.string(), limit: z.number().optional().default(25) }))
    .query(async ({ input }) => fetchTrendlyneAllInOneScreener(input.screenpk, input.limit)),
});
