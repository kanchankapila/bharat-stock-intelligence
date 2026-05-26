import { z } from "zod";
import {
  fetchAllIndianIndices,
  fetchGlobalIndices,
  fetchIndexFullDetails,
  fetchIndexStocksList,
  fetchIndexPriceFeed,
  fetchIndexTechnicals,
  fetchIndexGraph,
} from "../marketData";
import { getIndexData } from "../insightService";
import { router, publicProcedure } from "../trpc";

export const indicesRouter = router({
  getAllIndices: publicProcedure
    .query(async () => fetchAllIndianIndices()),

  getGlobalIndices: publicProcedure
    .query(async () => fetchGlobalIndices()),

  getIndexDetails: publicProcedure
    .input(z.object({ indexId: z.string() }))
    .query(async ({ input }) => getIndexData(input.indexId)),

  getIndexFullDetails: publicProcedure
    .input(z.object({ indId: z.string() }))
    .query(async ({ input }) => fetchIndexFullDetails(input.indId)),

  getIndexStocksList: publicProcedure
    .input(z.object({ indId: z.string(), type: z.enum(['0', '1']).optional() }))
    .query(async ({ input }) => fetchIndexStocksList(input.indId, input.type ?? '0')),

  getIndexPriceFeed: publicProcedure
    .input(z.object({ bridgeSymbol: z.string() }))
    .query(async ({ input }) => fetchIndexPriceFeed(input.bridgeSymbol)),

  getIndexTechnicals: publicProcedure
    .input(z.object({ period: z.enum(['D', 'W', 'M']), bridgeSymbol: z.string() }))
    .query(async ({ input }) => fetchIndexTechnicals(input.period, input.bridgeSymbol)),

  getIndexGraph: publicProcedure
    .input(z.object({ indId: z.string(), range: z.string().optional().default('1d'), type: z.string().optional().default('line') }))
    .query(async ({ input }) => {
      const { fetchIndexGraph } = await import('../indexApiService');
      return fetchIndexGraph(input.indId, input.range, input.type);
    }),

  getIndexPeChart: publicProcedure
    .input(z.object({ indId: z.string(), duration: z.string().optional().default('1Y') }))
    .query(async ({ input }) => {
      const { fetchIndexPeChart } = await import('../indexApiService');
      return fetchIndexPeChart(input.indId, input.duration);
    }),

  getIndexPbChart: publicProcedure
    .input(z.object({ indId: z.string(), duration: z.string().optional().default('1Y') }))
    .query(async ({ input }) => {
      const { fetchIndexPbChart } = await import('../indexApiService');
      return fetchIndexPbChart(input.indId, input.duration);
    }),

  getIndicesList: publicProcedure
    .query(async () => {
      const { fetchIndianIndices } = await import('../indexApiService');
      return fetchIndianIndices();
    }),

  getIndexFullData: publicProcedure
    .input(z.object({
      indId: z.string(),
      bridgeSymbol: z.string().optional(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D'),
    }))
    .query(async ({ input }) => {
      const { fetchIndexFullDetails, fetchIndexFundamentals, fetchIndexTechnicals } = await import('../indexApiService');
      const { getIndexById } = await import('../indexMapping');
      const [details, fundamentals] = await Promise.all([
        fetchIndexFullDetails(input.indId),
        fetchIndexFundamentals(input.indId),
      ]);
      const mapped = getIndexById(input.indId);
      const bSym = input.bridgeSymbol || details?.indices?.bridgesymbol || mapped?.symbol;
      const technicals = bSym ? await fetchIndexTechnicals(input.timeframe, bSym) : null;
      return { details, fundamentals, technicals };
    }),

  getIndexMapping: publicProcedure
    .query(async () => {
      const { INDEX_MAPPING } = await import('../indexMapping');
      return INDEX_MAPPING;
    }),

  getIndexConstituents: publicProcedure
    .input(z.object({ indId: z.string(), type: z.enum(['0', '1']).optional().default('0') }))
    .query(async ({ input }) => {
      const { fetchIndexConstituents } = await import('../indexApiService');
      return fetchIndexConstituents(input.indId, input.type);
    }),

  getAdvanceDecline: publicProcedure
    .input(z.object({ ex: z.string().optional().default('N') }))
    .query(async ({ input }) => {
      const { fetchAdvanceDecline } = await import('../indexApiService');
      return fetchAdvanceDecline(input.ex);
    }),
});
