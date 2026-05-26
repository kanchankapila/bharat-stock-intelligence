import { z } from "zod";
import { getAllStocks, getStockMapping } from "../stockMapping";
import {
  syncNSEStocksToDatabase,
  getAllNSEStocksFromDB,
  searchNSEStocksFromDB,
  getNSEStockFromDB,
  getNSEStocksBySectorFromDB,
  getNSEStocksByIndustryFromDB,
  getAllSectorsFromDB,
  getAllIndustriesFromDB,
  getNSEStockCount,
} from "../nseService";
import { router, publicProcedure } from "../trpc";

export const stocksRouter = router({
  getStockList: publicProcedure
    .query(() => getAllStocks()),

  getStockDetailsMap: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => getStockMapping(input.symbol)),

  syncNSEStocks: publicProcedure
    .mutation(async () => syncNSEStocksToDatabase()),

  getAllNSEStocks: publicProcedure
    .query(() => {
      const stocks = getAllNSEStocksFromDB();
      return { stocks, count: stocks.length };
    }),

  searchNSEStocks: publicProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(({ input }) => {
      const stocks = searchNSEStocksFromDB(input.query);
      return { stocks, count: stocks.length };
    }),

  getNSEStockBySymbol: publicProcedure
    .input(z.object({ symbol: z.string().min(1) }))
    .query(({ input }) => {
      const stock = getNSEStockFromDB(input.symbol.toUpperCase());
      return stock ?? { error: 'Stock not found' };
    }),

  getNSEStocksBySector: publicProcedure
    .input(z.object({ sector: z.string().min(1) }))
    .query(({ input }) => {
      const stocks = getNSEStocksBySectorFromDB(input.sector);
      return { stocks, count: stocks.length };
    }),

  getNSEStocksByIndustry: publicProcedure
    .input(z.object({ industry: z.string().min(1) }))
    .query(({ input }) => {
      const stocks = getNSEStocksByIndustryFromDB(input.industry);
      return { stocks, count: stocks.length };
    }),

  getAllSectors: publicProcedure
    .query(() => getAllSectorsFromDB()),

  getAllIndustries: publicProcedure
    .query(() => getAllIndustriesFromDB()),

  getNSEStockCount: publicProcedure
    .query(() => getNSEStockCount()),

  getAlphaQuantDetail: publicProcedure
    .input(z.object({
      symbol: z.string(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D'),
      scoreTimeframe: z.enum(['long_term', 'intraday']).optional().default('long_term'),
    }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { getMcConsolidatedData } = await import('../mcApiService');
      const { getStockScoreDetail } = await import('../scoringService');
      const { fetchTradebrainsData } = await import('../tradebrainsService');
      const [mcData, scoreData, tbData] = await Promise.all([
        getMcConsolidatedData(scId, input.symbol, input.timeframe),
        getStockScoreDetail(input.symbol, input.scoreTimeframe),
        fetchTradebrainsData(input.symbol),
      ]);
      return {
        ...mcData,
        score: scoreData?.score ?? null,
        factors: scoreData?.factors ?? null,
        tradebrains: tbData ?? null,
      };
    }),
});
