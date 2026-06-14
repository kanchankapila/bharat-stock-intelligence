import { z } from "zod";
import { fetchMCRatios, fetchETShareholding, fetchETCorporateActions, fetchMFInvestments } from "../marketData";
import { fetchTrendlyneFundamentals, fetchCompanyOverview } from "../trendlyneService";
import { getMoneycontrolInsights } from "../moneycontrolService";
import { getStockInsights } from "../insightService";
import { router, publicProcedure } from "../trpc";

export const fundamentalsRouter = router({
  triggerFundamentalsSync: publicProcedure
    .input(z.object({ phase2Only: z.boolean().optional() }).optional())
    .mutation(async ({ input }) => {
      const { fundamentalsSyncQueue } = await import('../queues');
      if (!fundamentalsSyncQueue) {
        const { runFullFundamentalsSync } = await import('../fundamentalsSyncService');
        runFullFundamentalsSync(input?.phase2Only ?? false).catch(console.error);
        return { queued: false, message: 'Running directly (no Redis)' };
      }
      const [waiting, active] = await Promise.all([
        fundamentalsSyncQueue.getWaiting(),
        fundamentalsSyncQueue.getActive(),
      ]);
      if (waiting.length + active.length > 0) return { queued: false, message: 'Sync already queued or running' };
      await fundamentalsSyncQueue.add(
        'sync-fundamentals',
        { phase2Only: input?.phase2Only ?? false },
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1 },
      );
      return { queued: true, message: 'Fundamentals sync job enqueued' };
    }),

  getFundamentalsStatus: publicProcedure
    .query(async () => {
      const { getSyncProgress, getFundamentalsCount } = await import('../fundamentalsSyncService');
      return { progress: getSyncProgress(), dbCounts: getFundamentalsCount() };
    }),

  getStockFundamentals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { getStoredFundamentals, refreshSymbolFundamentals } = await import('../fundamentalsSyncService');
      let row = getStoredFundamentals(input.symbol);
      if (!row) {
        await refreshSymbolFundamentals(input.symbol).catch(() => null);
        row = getStoredFundamentals(input.symbol);
      }
      return row ?? null;
    }),

  getRatios: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchMCRatios(input.symbol)),

  getShareholding: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchETShareholding(input.symbol)),

  getCorporateActions: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchETCorporateActions(input.symbol)),

  getMFInvestments: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchMFInvestments(input.symbol)),

  getInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getMoneycontrolInsights(input.symbol)),

  getStockInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getStockInsights(input.symbol)),

  getTrendlyneFundamentals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchTrendlyneFundamentals(input.symbol)),

  getCompanyOverview: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchCompanyOverview(input.symbol)),

  getCompanyProfileAnalysis: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { default: db } = await import('../db');
      const row = db.prepare(`
        SELECT symbol, company_name, description, high_growth_scope, in_news_for_growth, growth_score, ai_analysis, last_updated
        FROM company_profiles
        WHERE symbol = ?
      `).get(input.symbol) as any;
      return row || null;
    }),
});
