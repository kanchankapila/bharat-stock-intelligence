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

  getMcSeasonality: publicProcedure
    .input(z.object({ month: z.number().optional() }))
    .query(async ({ input }) => {
      const month = input.month ?? (new Date().getMonth() + 1);
      const { dbAll } = await import('../dbAsync');
      return dbAll(`
        SELECT tab_type, sc_fullname as name, avg_pct, max_pct, min_pct, total_yr as years_positive, tot_yr as total_years, sc_id
        FROM mc_seasonality_best_stocks
        WHERE month = ?
        ORDER BY avg_pct DESC
        LIMIT 50
      `, [month]);
    }),
});

