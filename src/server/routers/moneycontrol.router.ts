import { z } from "zod";
import { getStockMapping } from "../stockMapping";
import { alphaQuant } from "../alphaQuantClient";
import { router, publicProcedure } from "../trpc";

export const moneycontrolRouter = router({
  getMcConsolidated: publicProcedure
    .input(z.object({
      symbol:    z.string(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D'),
    }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { getMcConsolidatedData } = await import('../mcApiService');
      return getMcConsolidatedData(scId, input.symbol, input.timeframe);
    }),

  getMcTechnical: publicProcedure
    .input(z.object({ symbol: z.string(), duration: z.enum(['D', 'W', 'M']).optional().default('D') }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcTechnicalData } = await import('../mcApiService');
      return fetchMcTechnicalData(scId, input.duration);
    }),

  getMcEquityCash: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcEquityCash } = await import('../mcApiService');
      return fetchMcEquityCash(scId);
    }),

  getMcSwot: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcSwot } = await import('../mcApiService');
      return fetchMcSwot(scId);
    }),

  getMcEssentials: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcEssentials } = await import('../mcApiService');
      return fetchMcEssentials(scId);
    }),

  getMcInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcInsights } = await import('../mcApiService');
      return fetchMcInsights(scId);
    }),

  getMcDetailedInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcDetailedInsights } = await import('../mcApiService');
      return fetchMcDetailedInsights(scId);
    }),

  getMcPriceVolume: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcPriceVolume } = await import('../mcApiService');
      return fetchMcPriceVolume(scId);
    }),

  getMcAnalystRating: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcAnalystRating } = await import('../mcApiService');
      return fetchMcAnalystRating(scId);
    }),

  getMcEarningsForecast: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcEarningsForecast } = await import('../mcApiService');
      return fetchMcEarningsForecast(scId);
    }),

  getMcPriceForecast: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcPriceForecast } = await import('../mcApiService');
      return fetchMcPriceForecast(scId);
    }),

  getMcConsensus: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcConsensus } = await import('../mcApiService');
      return fetchMcConsensus(scId);
    }),

  getMcVwapChart: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcVwapChart } = await import('../mcApiService');
      return fetchMcVwapChart(scId);
    }),

  getKayalScreener: publicProcedure
    .input(z.object({ screenpk: z.string(), limit: z.number().optional().default(50) }))
    .query(async ({ input }) => {
      const { fetchKayalScreener } = await import('../mcApiService');
      return fetchKayalScreener(input.screenpk, input.limit);
    }),
});
