import { z } from "zod";
import { resolveMoneycontrolSymbol } from "../stockMapping";
import { alphaQuant } from "../alphaQuantClient";
import { router, publicProcedure } from "../trpc";
import type { McStockNewsResponse } from "../mcApiService";
import { fetchWithCache } from "../cacheService";

// getMcConsolidated already routes through getMcConsolidatedData's own 1h fundamentalCache
// (mcApiService.ts). Every other single-symbol MC procedure below called its raw fetchMcXxx
// upstream function directly on EVERY request with no caching at all -- a stock-detail page
// view (or its 5 tabs, each firing its own one of these) hit MoneyControl live every time.
// Wrapped in the same fetchWithCache primitive already used elsewhere (Redis/in-memory
// fallback + in-flight de-dup), keyed per scId since that's the real MC identity, TTL matching
// this data's documented ~1h cache convention.
//
// scId resolution (2026-08-02 fix): every procedure below used to do
// `getStockMapping(input.symbol)?.mcsymbol || input.symbol`. stocklist.ts has grown to cover
// ~2,000 NSE stocks (CLAUDE.md's "180 liquid stocks" figure is stale), so this mostly worked --
// but `mapping?.mcsymbol` is `""` (empty string, not undefined) for ~23 known entries (illiquid/
// delisted-ish names, live-verified: Bartronics India/ASMS, SAMTELTD, etc.) plus any symbol not
// yet present in the file at all (new listings). `"" || input.symbol` is falsy either way, so
// those cases silently sent the RAW NSE TICKER to MoneyControl as if it were the opaque scId
// (live-verified: `scId=ASMS` -- Bartronics' real NSE symbol -- returns a blank SWOT response),
// which is the "lots of SWOT errors in logs" report that surfaced this. resolveMoneycontrolSymbol
// already implements this codebase's own documented resolution order (hardcoded mapping ->
// in-memory cache -> MC autocomplete API fallback, live-verified working) and was already proven
// correct in getMcStockNews; every procedure here now goes through it instead of guessing, and
// returns null (not a broken live call) when even autocomplete can't resolve an obscure symbol.
export const moneycontrolRouter = router({
  getMcConsolidated: publicProcedure
    .input(z.object({
      symbol:    z.string(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D'),
    }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      const { getMcConsolidatedData } = await import('../mcApiService');
      return getMcConsolidatedData(scId, input.symbol, input.timeframe);
    }),

  getMcTechnical: publicProcedure
    .input(z.object({ symbol: z.string(), duration: z.enum(['D', 'W', 'M']).optional().default('D') }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:technical:${scId}:${input.duration}`, async () => {
        const { fetchMcTechnicalData } = await import('../mcApiService');
        return fetchMcTechnicalData(scId, input.duration, input.symbol);
      }, 3600);
    }),

  getMcEquityCash: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:equity-cash:${scId}`, async () => {
        const { fetchMcEquityCash } = await import('../mcApiService');
        return fetchMcEquityCash(scId, input.symbol);
      }, 3600);
    }),

  getMcSwot: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:swot:${scId}`, async () => {
        const { fetchMcSwot } = await import('../mcApiService');
        return fetchMcSwot(scId, input.symbol);
      }, 3600);
    }),

  getMcEssentials: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:essentials:${scId}`, async () => {
        const { fetchMcEssentials } = await import('../mcApiService');
        return fetchMcEssentials(scId, input.symbol);
      }, 3600);
    }),

  getMcInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:insights:${scId}`, async () => {
        const { fetchMcInsights } = await import('../mcApiService');
        return fetchMcInsights(scId, input.symbol);
      }, 3600);
    }),

  getMcDetailedInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:detailed-insights:${scId}`, async () => {
        const { fetchMcDetailedInsights } = await import('../mcApiService');
        return fetchMcDetailedInsights(scId, input.symbol);
      }, 3600);
    }),

  getMcPriceVolume: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:price-volume:${scId}`, async () => {
        const { fetchMcPriceVolume } = await import('../mcApiService');
        return fetchMcPriceVolume(scId, input.symbol);
      }, 900);
    }),

  getMcAnalystRating: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:analyst-rating:${scId}`, async () => {
        const { fetchMcAnalystRating } = await import('../mcApiService');
        return fetchMcAnalystRating(scId, input.symbol);
      }, 3600);
    }),

  getMcEarningsForecast: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:earnings-forecast:${scId}`, async () => {
        const { fetchMcEarningsForecast } = await import('../mcApiService');
        return fetchMcEarningsForecast(scId, input.symbol);
      }, 3600);
    }),

  getMcPriceForecast: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:price-forecast:${scId}`, async () => {
        const { fetchMcPriceForecast } = await import('../mcApiService');
        return fetchMcPriceForecast(scId, input.symbol);
      }, 3600);
    }),

  getMcConsensus: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:consensus:${scId}`, async () => {
        const { fetchMcConsensus } = await import('../mcApiService');
        return fetchMcConsensus(scId, input.symbol);
      }, 3600);
    }),

  getMcVwapChart: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) return null;
      return fetchWithCache(`mc:vwap-chart:${scId}`, async () => {
        const { fetchMcVwapChart } = await import('../mcApiService');
        return fetchMcVwapChart(scId);
      }, 900);
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

  getMcStockNews: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }): Promise<McStockNewsResponse> => {
      // resolveMoneycontrolSymbol already prefers stocklist.ts's mcsymbol before
      // falling back to MC autocomplete. The news endpoint is keyed strictly on
      // sc_id — a raw NSE ticker answers `news: null` — so don't waste a call.
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) {
        return { scId: '', status: 'no_news', count: 0, news: [], additional_links: [] };
      }
      return fetchWithCache(`mc:stock-news:${scId}`, async () => {
        const { fetchMcStockNews } = await import('../mcApiService');
        return fetchMcStockNews(scId, input.symbol);
      }, 600);
    }),
});
