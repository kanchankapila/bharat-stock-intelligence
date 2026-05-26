import { z } from "zod";
import { getFnOSignals } from "../fnoService";
import { fetchOptionChain, fetchFnoSymbols } from "../optionChainService";
import { alphaQuant } from "../alphaQuantClient";
import { fetchWithCache } from "../cacheService";
import type { FnoIndexId } from "../marketIntelService";
import { router, publicProcedure } from "../trpc";

export const fnoRouter = router({
  getFnOSignals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getFnOSignals(input.symbol)),

  getTrendlyneFnoScanners: publicProcedure
    .input(z.object({ mtype: z.enum(['options', 'futures']), screenType: z.string(), instType: z.string().optional() }))
    .query(async ({ input }) => {
      const { getTrendlyneFnoScanners } = await import('../fnoService');
      return getTrendlyneFnoScanners(input.mtype, input.screenType, input.instType);
    }),

  getMCFnoOverview: publicProcedure
    .input(z.object({ id: z.string(), instType: z.enum(['futures', 'options']).optional().default('futures') }))
    .query(async ({ input }) => {
      const { getMCFnoOverview } = await import('../fnoService');
      return getMCFnoOverview(input.id, input.instType);
    }),

  getOptionsIntelligence: publicProcedure
    .query(async () => {
      try {
        return await alphaQuant.getPcr({}, 10_000);
      } catch (e: any) {
        return [];
      }
    }),

  getTrendlyneFnoHeatmap: publicProcedure
    .query(async () => {
      const { getTrendlyneFnoHeatmap } = await import('../fnoService');
      return getTrendlyneFnoHeatmap();
    }),

  getFnoSymbols: publicProcedure
    .query(async () => fetchWithCache('fno_symbols', fetchFnoSymbols, 3600)),

  getOptionChain: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchOptionChain(input.symbol)),

  getIndexFno: publicProcedure
    .input(z.object({ id: z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']) }))
    .query(async ({ input }) => {
      const { fetchIndexFnoAll } = await import('../marketIntelService');
      return fetchIndexFnoAll(input.id as FnoIndexId);
    }),

  runPcrFetch: publicProcedure
    .input(z.object({ symbols: z.array(z.string()).optional() }))
    .mutation(async ({ input }) => {
      try {
        const body = { symbols: input.symbols?.length ? input.symbols : undefined, delay: 0.2 };
        const data = await alphaQuant.getPcr(body, 60_000);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, error: String(err) };
      }
    }),
});
