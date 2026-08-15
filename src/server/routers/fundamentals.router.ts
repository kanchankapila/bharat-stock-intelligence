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
        // Cutoffs computed in JS and bound as plain date-string params, not `CURRENT_DATE ±
        // (? || ' days')::interval` -- trpc-surface-review (2026-08-14) found this pattern
        // silently no-ops under the SQLite dev fallback: stripPgCasts strips the ::interval/
        // ::date/::text casts but SQLite has no interval arithmetic to fall back to, so the
        // residual `CURRENT_DATE - (? || ' days')` evaluates to nonsense and the WHERE clause
        // matches every row regardless of window (valid on live Postgres, so no production
        // impact, but silently wrong for local dev). Same fix already applied to
        // getScreenerSurfacingSignals/getScreenerSectorRotation (screeners.router.ts).
        const fromDate = new Date(Date.now() - input.daysBack * 24 * 3600_000).toISOString().slice(0, 10);
        const toDate = new Date(Date.now() + input.daysForward * 24 * 3600_000).toISOString().slice(0, 10);
        const rows = await dbAll<any>(
          `SELECT ca.symbol, ns.name, ca.ex_date, ca.action_type, ca.ratio, ca.amount
           FROM corporate_actions ca
           LEFT JOIN nse_stocks ns ON ns.symbol = ca.symbol AND ns.status = 'ACTIVE'
           WHERE ca.ex_date >= ?
             AND ca.ex_date <= ?
             ${input.actionType ? "AND ca.action_type = ?" : ""}
           ORDER BY ca.ex_date ASC`,
          input.actionType
            ? [fromDate, toDate, input.actionType.toUpperCase()]
            : [fromDate, toDate]
        );
        return rows || [];
      } catch (e: any) {
        console.error("[Fundamentals Router] Error fetching corporate actions calendar:", e);
        return [];
      }
    }),

  // Deep per-stock corporate-action history (dividends/bonus/splits/rights), 2026-08-07
  // urls.txt open-source sourcing pass. Distinct from getCorporateActions above (that one
  // proxies ET Markets live with no persistence) — this reads the DB-backed ledger
  // mc_corporate_actions_fetcher.py builds, the same one ohlcv_adjust.py's
  // cross_validate_with_mc_actions() cross-checks against.
  getCorporateActionHistory: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchWithCache(`fund:corp-action-history:${input.symbol}`, async () => {
      try {
        const upperSymbol = input.symbol.toUpperCase();
        const [rows, factorRows] = await Promise.all([
          dbAll<any>(
            `SELECT action_type, announce_date, record_date, ratio_text, ratio_factor, amount, source
             FROM stock_corporate_action_history
             WHERE symbol = ?
             ORDER BY COALESCE(record_date, announce_date) DESC`,
            [upperSymbol]
          ),
          // ohlcv_adjustment_factors carries both bhavcopy-heuristic-detected splits/bonuses
          // (source='bhavcopy_prev_close', the DB default) and ones only ever found via this
          // same MC ledger (source='mc_corporate_action', see ohlcv_adjust.cross_validate_
          // with_mc_actions()). Cross-referencing here surfaces that reconciliation to the
          // user instead of leaving it as an internal-only backtest-accuracy check.
          dbAll<{ ex_date: string; factor: number; source: string }>(
            `SELECT ex_date, factor, source FROM ohlcv_adjustment_factors WHERE symbol = ?`,
            [upperSymbol]
          ).catch(() => []),
        ]);

        // Mirrors ohlcv_adjust.py's own DATE_WINDOW_DAYS=5 / RATIO_TOL=0.025 constants -- keep
        // both in sync with that file if either is ever retuned there.
        const DATE_WINDOW_DAYS = 5;
        const RATIO_TOL = 0.025;
        const annotated = (rows || []).map((a: any) => {
          const factor = Number(a.ratio_factor);
          if (!a.record_date || !Number.isFinite(factor) || factor <= 0) {
            return { ...a, crossCheck: 'not_applicable' as const };
          }
          const recordDate = new Date(a.record_date);
          if (Number.isNaN(recordDate.getTime())) return { ...a, crossCheck: 'not_applicable' as const };
          const match = (factorRows || []).find((f) => {
            const exDate = new Date(f.ex_date);
            if (Number.isNaN(exDate.getTime())) return false;
            const daysApart = Math.abs((exDate.getTime() - recordDate.getTime()) / 86_400_000);
            return daysApart <= DATE_WINDOW_DAYS && Math.abs(f.factor - factor) / factor <= RATIO_TOL;
          });
          if (!match) return { ...a, crossCheck: 'unconfirmed' as const };
          return {
            ...a,
            crossCheck: match.source === 'mc_corporate_action' ? 'confirmed_via_this_source' as const : 'confirmed_by_bhavcopy' as const,
          };
        });
        return annotated;
      } catch (e: any) {
        console.error("[Fundamentals Router] Error fetching corporate action history:", e);
        return [];
      }
    }, 3600)),

  // Market-wide corporate actions sourced from real NSE regulatory filings (InvestSights),
  // 2026-08-07 urls.txt open-source sourcing pass — the completeness cross-check for
  // getCorporateActionHistory's per-stock MoneyControl ledger, not a replacement for it.
  getFiledCorporateActionsCalendar: publicProcedure
    .input(z.object({
      daysBack: z.number().min(0).max(180).optional().default(14),
      daysForward: z.number().min(0).max(365).optional().default(60),
      symbol: z.string().optional(),
    }))
    .query(async ({ input }) => fetchWithCache(
      `fund:filed-corp-actions:${input.daysBack}:${input.daysForward}:${input.symbol ?? ''}`,
      async () => {
        try {
          // JS-computed cutoffs -- see getCorporateActionsCalendar above for why (same
          // SQLite-dev-fallback no-op the CURRENT_DATE ± interval form silently hits).
          const fromDate = new Date(Date.now() - input.daysBack * 24 * 3600_000).toISOString().slice(0, 10);
          const toDate = new Date(Date.now() + input.daysForward * 24 * 3600_000).toISOString().slice(0, 10);
          const rows = await dbAll<any>(
            `SELECT symbol, company_name, category, headline, dividend_per_share,
                    record_date, ex_date, filing_date, source_url, upcoming
             FROM nse_filed_corporate_actions
             WHERE filing_date >= ?
               AND filing_date <= ?
               ${input.symbol ? "AND symbol = ?" : ""}
             ORDER BY filing_date DESC`,
            input.symbol
              ? [fromDate, toDate, input.symbol.toUpperCase()]
              : [fromDate, toDate]
          );
          return rows || [];
        } catch (e: any) {
          console.error("[Fundamentals Router] Error fetching filed corporate actions calendar:", e);
          return [];
        }
      },
      1800
    )),

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

  // Market-wide feed of the same table (no symbol filter) -- the per-stock procedure above has
  // no discovery surface: you need to already know a symbol to see any superstar activity at
  // all. This backs a leaderboard/feed widget instead.
  getSuperstarActivityFeed: publicProcedure
    .input(z.object({
      changeType: z.enum(['entry', 'exit', 'increase', 'decrease']).optional(),
      limit: z.number().min(1).max(100).optional().default(30),
    }))
    .query(async ({ input }) => fetchWithCache(`fund:superstar-feed:${input.changeType ?? 'all'}:${input.limit}`, async () => {
      try {
        const params: any[] = [];
        let where = '1=1';
        if (input.changeType) { where += ' AND change_type = ?'; params.push(input.changeType); }
        params.push(input.limit);
        const rows = await dbAll<any>(
          `SELECT symbol, investor_slug, investor_name, change_type, curr_pct_holding, pct_holding_change, period_end_date, fetched_at
           FROM superstar_investor_activity
           WHERE ${where}
           ORDER BY fetched_at DESC, period_end_date DESC
           LIMIT ?`,
          params
        );
        return rows || [];
      } catch (e) {
        console.error('[Fundamentals Router] getSuperstarActivityFeed failed:', e);
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
