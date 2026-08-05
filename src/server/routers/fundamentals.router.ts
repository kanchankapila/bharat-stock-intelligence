import { z } from "zod";
import { fetchMCRatios, fetchETShareholding, fetchETCorporateActions, fetchMFInvestments } from "../marketData";
import { fetchTrendlyneFundamentals, fetchCompanyOverview } from "../trendlyneService";
import { getMoneycontrolInsights } from "../moneycontrolService";
import { getStockInsights } from "../insightService";
import { getFinologyData } from "../finologyService";
import { dbAll } from "../dbAsync";
import { router, publicProcedure, adminProcedure } from "../trpc";
import { fetchWithCache } from "../cacheService";

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

  // Ratios/shareholding/corporate-actions/MF-investment data changes at most quarterly, but
  // previously called the live MoneyControl/ET upstream on every single stock-page view with
  // no caching. fetchWithCache (Redis/in-memory fallback + in-flight de-dup) already existed
  // in this codebase (used correctly by getSuperstarList/getEarningsSummary) -- these simply
  // weren't calling it.
  getRatios: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchWithCache(`fund:ratios:${input.symbol}`, () => fetchMCRatios(input.symbol), 3600)),

  getShareholding: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchWithCache(`fund:shareholding:${input.symbol}`, async () => {
      const live = await fetchETShareholding(input.symbol);
      if (live) return live;
      // ET Markets unreachable/no data — technical_signals already carries a promoter/FII/MF/
      // pledge trail (populated by fundamentals_snapshot.py for the scoring engine) that this
      // endpoint never read; fall back to the latest row instead of leaving the page empty.
      try {
        const row = await dbAll<any>(
          `SELECT promoter_pct, fii_pct, mf_pct, pledge_pct, promoter_chg_qoq, fii_chg_qoq, mf_chg_qoq, pledge_chg_qoq
           FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1`,
          [input.symbol.toUpperCase()]
        );
        return row[0] ?? null;
      } catch (e) {
        console.error("[Fundamentals Router] getShareholding DB fallback failed:", e);
        return null;
      }
    }, 3600)),

  // Added 2026-07-30 (Finding #94, full-stack audit): SmartMoneyMonitor.tsx previously had
  // no backend call at all -- a hardcoded array of 9 stocks with invented promoter/FII/DII
  // percentage-change numbers presented as live data, with no fallback framing (it was the
  // only data path that existed). This surfaces the SAME real, quarterly promoter/FII/MF
  // ownership-change trail getShareholding's DB fallback already reads per-symbol
  // (technical_signals, populated by fundamentals_snapshot.py), ranked across the whole
  // universe instead of one symbol at a time. mf_chg_qoq (mutual fund flow) is used as the
  // DII proxy -- it's the closest real column to "DII flow" this table actually has; there
  // is no separate non-MF-DII column to report instead.
  getSmartMoneyFlow: publicProcedure
    .input(z.object({
      direction: z.enum(['accumulation', 'distribution']).default('accumulation'),
      limit: z.number().min(1).max(50).optional().default(20),
    }))
    .query(async ({ input }) => fetchWithCache(`fund:smart-money:${input.direction}:${input.limit}`, async () => {
      try {
        // The windowed subquery used to be `SELECT *` -- materializing every one of
        // technical_signals' ~300 columns for every historical row matching the (unindexed) OR
        // filter, before the outer query narrows to rn=1. Deliberately NOT adding a date bound
        // here (unlike the sibling fixes in this file/session): fii_chg_qoq/mf_chg_qoq are
        // quarterly figures that may persist unchanged on a symbol's row for weeks, so a narrow
        // date window could silently drop symbols whose latest value sits on an older row --
        // that's a real behavior/correctness risk this sandbox has no live DB to verify against.
        // Projecting only the columns actually read below is output-identical and still cuts
        // the I/O materially.
        const rows = await dbAll<any>(`
          SELECT t.symbol, ns.name, t.date, t.promoter_chg_qoq, t.fii_chg_qoq, t.mf_chg_qoq,
                 (COALESCE(t.fii_chg_qoq, 0) + COALESCE(t.mf_chg_qoq, 0)) AS net_flow
          FROM (
            SELECT symbol, date, promoter_chg_qoq, fii_chg_qoq, mf_chg_qoq,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
            FROM technical_signals
            WHERE fii_chg_qoq IS NOT NULL OR mf_chg_qoq IS NOT NULL
          ) t
          LEFT JOIN nse_stocks ns ON ns.symbol = t.symbol
          WHERE t.rn = 1
          ORDER BY net_flow ${input.direction === 'accumulation' ? 'DESC' : 'ASC'}
          LIMIT ?
        `, [input.limit]);

        return rows.map((r: any) => ({
          symbol: r.symbol,
          name: r.name ?? r.symbol,
          promoter: r.promoter_chg_qoq != null ? Number(r.promoter_chg_qoq) : null,
          fii: r.fii_chg_qoq != null ? Number(r.fii_chg_qoq) : null,
          dii: r.mf_chg_qoq != null ? Number(r.mf_chg_qoq) : null,
          netFlow: Number(r.net_flow),
          status: r.net_flow >= 0 ? 'accumulation' : 'distribution',
          asOfDate: r.date,
        }));
      } catch (e) {
        console.error("[Fundamentals Router] getSmartMoneyFlow failed:", e);
        return [];
      }
    }, 300)),

  getCorporateActions: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchWithCache(`fund:corp-actions:${input.symbol}`, () => fetchETCorporateActions(input.symbol), 3600)),

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
    .query(async ({ input }) => fetchWithCache(`fund:mf-investments:${input.symbol}`, () => fetchMFInvestments(input.symbol), 3600)),

  // InvestSights superstar investor activity (urls.txt expansion): per-stock entry/increase/
  // decrease/exit activity keyed by NSE symbol, populated by
  // investsights_investor_activity_fetcher.py.
  getSuperstarInvestorActivity: publicProcedure
    .input(z.object({ symbol: z.string(), limit: z.number().min(1).max(100).optional().default(30) }))
    .query(async ({ input }) => fetchWithCache(`fund:superstar-activity:${input.symbol}:${input.limit}`, async () => {
      try {
        const rows = await dbAll<any>(
          `SELECT symbol, investor_slug, change_type, curr_pct_holding, pct_holding_change, period_end_date, fetched_at
           FROM superstar_investor_activity
           WHERE symbol = ?
           ORDER BY period_end_date DESC, fetched_at DESC
           LIMIT ?`,
          [input.symbol.toUpperCase(), input.limit]
        );
        return rows || [];
      } catch (e) {
        console.error('[Fundamentals Router] getSuperstarInvestorActivity failed:', e);
        return [];
      }
    }, 3600)),

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
