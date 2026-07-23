import { z } from "zod";
import { fetchMCRatios, fetchETShareholding, fetchETCorporateActions, fetchMFInvestments } from "../marketData";
import { fetchTrendlyneFundamentals, fetchCompanyOverview } from "../trendlyneService";
import { getMoneycontrolInsights } from "../moneycontrolService";
import { getStockInsights } from "../insightService";
import { getFinologyData } from "../finologyService";
import { dbAll } from "../dbAsync";
import { router, publicProcedure, adminProcedure } from "../trpc";

export const fundamentalsRouter = router({
  triggerFundamentalsSync: adminProcedure
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
      return { progress: getSyncProgress(), dbCounts: await getFundamentalsCount() };
    }),

  getStockFundamentals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { getStoredFundamentals, refreshSymbolFundamentals } = await import('../fundamentalsSyncService');
      let row = await getStoredFundamentals(input.symbol);
      if (!row) {
        await refreshSymbolFundamentals(input.symbol).catch(() => null);
        row = await getStoredFundamentals(input.symbol);
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

  // Market-wide corporate actions calendar — corporate_actions is populated daily but had no
  // consumer beyond a per-stock "has an action" boolean flag in EarlyHoursSpotter.tsx.
  getCorporateActionsCalendar: publicProcedure
    .input(z.object({
      daysBack: z.number().min(0).max(60).optional().default(3),
      daysForward: z.number().min(0).max(60).optional().default(21),
      actionType: z.string().optional(),
    }))
    .query(async ({ input }) => {
      try {
        const rows = await dbAll<any>(
          `SELECT ca.symbol, ns.name, ca.ex_date, ca.action_type, ca.ratio, ca.amount
           FROM corporate_actions ca
           LEFT JOIN nse_stocks ns ON ns.symbol = ca.symbol AND ns.status = 'ACTIVE'
           WHERE ca.ex_date >= (CURRENT_DATE - (? || ' days')::interval)::text
             AND ca.ex_date <= (CURRENT_DATE + (? || ' days')::interval)::text
             ${input.actionType ? "AND ca.action_type = ?" : ""}
           ORDER BY ca.ex_date ASC`,
          input.actionType
            ? [input.daysBack, input.daysForward, input.actionType.toUpperCase()]
            : [input.daysBack, input.daysForward]
        );
        return rows || [];
      } catch (e: any) {
        console.error("[Fundamentals Router] Error fetching corporate actions calendar:", e);
        return [];
      }
    }),

  // credit_rating_events is populated by credit_rating_fetcher.py but had no tRPC procedure at
  // all — only fed internal technical_signals scoring flags.
  getCreditRatingEvents: publicProcedure
    .input(z.object({ symbol: z.string().optional(), limit: z.number().min(1).max(200).optional().default(60) }))
    .query(async ({ input }) => {
      try {
        const rows = await dbAll<any>(
          `SELECT bse_code, symbol, isin, announcement_date, rating_agency, action, instrument_type, headline
           FROM credit_rating_events
           ${input.symbol ? "WHERE symbol = ?" : ""}
           ORDER BY announcement_date DESC
           LIMIT ?`,
          input.symbol ? [input.symbol.toUpperCase(), input.limit] : [input.limit]
        );
        return rows || [];
      } catch (e: any) {
        console.error("[Fundamentals Router] Error fetching credit rating events:", e);
        return [];
      }
    }),

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
      const { dbGet } = await import('../dbAsync');
      const row = await dbGet<any>(`
        SELECT symbol, company_name, description, high_growth_scope, in_news_for_growth, growth_score, ai_analysis, last_updated
        FROM company_profiles
        WHERE symbol = ?
      `, [input.symbol]);
      return row || null;
    }),

  // Finology valuation + peers for the stock-detail page (unlocked, keyed by fincode; 1h cache).
  getFinologyData: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return getFinologyData(input.symbol);
    }),
});
