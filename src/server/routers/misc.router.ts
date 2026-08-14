import { z } from "zod";
import { dbGet, dbAll } from "../dbAsync";
import { mcFetchJson } from "../mcApiService";
import { getStockMapping } from "../stockMapping";
import { fetchWithCache } from "../cacheService";
import { generateStockAnalysis } from "../../services/aiService";
import { alphaQuant } from "../alphaQuantClient";
import { TRPCError } from "@trpc/server";
import {
  fetchPremarketAll,
  fetchDealsAll,
  fetchEarningsAll,
  fetchEarningsCalendar,
  fetchEarningsRapidResults,
  fetchEarningsPriceShockers,
  fetchStockEarningsSummary,
  type FnoIndexId,
} from "../marketIntelService";
import { router, publicProcedure } from "../trpc";

export const miscRouter = router({
  getAIAnalysis: publicProcedure
    .input(z.object({ symbol: z.string(), data: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ input }) => {
      const { symbol, data } = input;
      const enriched: Record<string, unknown> = { ...data };

      // Technical signals (RSI, MACD, SMAs) — most recent scan row
      const techSignal = await dbGet<any>(`
        SELECT rsi, sma50, sma200, macd, macd_signal, bb_width, volume_ratio,
               above_sma200, signal_score, signals_json
        FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1
      `, [symbol]);
      if (techSignal) {
        enriched.rsi              = techSignal.rsi;
        enriched.macd             = techSignal.macd;
        enriched.macd_signal      = techSignal.macd_signal;
        enriched.sma50            = techSignal.sma50;
        enriched.sma200           = techSignal.sma200;
        enriched.above_sma200     = !!techSignal.above_sma200;
        enriched.bb_width         = techSignal.bb_width;
        enriched.volume_ratio     = techSignal.volume_ratio;
        enriched.signal_score     = techSignal.signal_score;
        if (techSignal.signals_json) {
          try { enriched.detected_patterns = JSON.parse(techSignal.signals_json); } catch (e) { console.warn('[misc] failed to parse detected_patterns', e); }
        }
      }

      // Fundamentals — PE, ROE, D/E, growth rates, Piotroski
      const fund = await dbGet<any>(`
        SELECT trailing_pe, forward_pe, price_to_book, eps_ttm,
               debt_to_equity, return_on_equity, revenue_growth, earnings_growth,
               operating_margins, piotroski_f_score, dividend_yield, analyst_rating,
               fifty_two_week_high, fifty_two_week_low
        FROM stock_fundamentals WHERE symbol = ?
      `, [symbol]);
      if (fund) {
        enriched.pe_ratio             = fund.trailing_pe;
        enriched.forward_pe           = fund.forward_pe;
        enriched.price_to_book        = fund.price_to_book;
        enriched.eps_ttm              = fund.eps_ttm;
        enriched.debt_to_equity       = fund.debt_to_equity;
        enriched.roe_pct              = fund.return_on_equity != null ? +(fund.return_on_equity * 100).toFixed(1) : null;
        enriched.revenue_growth_pct   = fund.revenue_growth   != null ? +(fund.revenue_growth   * 100).toFixed(1) : null;
        enriched.earnings_growth_pct  = fund.earnings_growth  != null ? +(fund.earnings_growth  * 100).toFixed(1) : null;
        enriched.operating_margin_pct = fund.operating_margins != null ? +(fund.operating_margins * 100).toFixed(1) : null;
        enriched.piotroski_f_score    = fund.piotroski_f_score;
        enriched.dividend_yield       = fund.dividend_yield;
        enriched.analyst_rating       = fund.analyst_rating;
        enriched.week52_high          = fund.fifty_two_week_high;
        enriched.week52_low           = fund.fifty_two_week_low;
      }

      // AI factor breakdown scores (0–100 each), including news sentiment score
      const factors = await dbGet<any>(`
        SELECT technical, fundamental, momentum, valuation, delivery, news
        FROM stock_factor_breakdown WHERE symbol = ? AND timeframe = 'long_term'
      `, [symbol]);
      if (factors) {
        enriched.factor_scores = {
          technical: factors.technical,
          fundamental: factors.fundamental,
          momentum: factors.momentum,
          valuation: factors.valuation,
          delivery: factors.delivery,
          news: factors.news,
        };
      }

      // Quant classification + returns
      const quant = await dbGet<any>(`
        SELECT composite_class, rank_composite, return_1m, return_3m, return_6m, annualized_vol
        FROM quant_scores WHERE symbol = ?
      `, [symbol]);
      if (quant) {
        enriched.quant_class           = quant.composite_class;
        enriched.quant_rank_pct        = quant.rank_composite;
        enriched.return_1m_pct         = quant.return_1m;
        enriched.return_3m_pct         = quant.return_3m;
        enriched.annualized_vol_pct    = quant.annualized_vol;
      }

      // Recent news with NLP sentiment — try exact symbol match first,
      // fall back to company-name match (news says "HDFC Bank" not "HDFCBANK")
      const stockMeta = await dbGet<any>(`SELECT name, sector FROM nse_stocks WHERE symbol = ?`, [symbol]);
      let news = await dbAll<any>(`
        SELECT title, sentiment, impact, category
        FROM news_sentiment_items
        WHERE symbols_json LIKE ? ORDER BY published_at DESC LIMIT 5
      `, [`%"${symbol}"%`]);

      if (news.length === 0 && stockMeta?.name) {
        const nameKeyword = stockMeta.name.split(' ').slice(0, 2).join(' ');
        news = await dbAll<any>(`
          SELECT title, sentiment, impact, category
          FROM news_sentiment_items
          WHERE title LIKE ? ORDER BY published_at DESC LIMIT 5
        `, [`%${nameKeyword}%`]);
      }

      // If still nothing, pull top-impact sector news as market context
      if (news.length === 0 && stockMeta?.sector) {
        news = await dbAll<any>(`
          SELECT title, sentiment, impact, category
          FROM news_sentiment_items
          WHERE sector = ? AND impact IN ('HIGH', 'MEDIUM')
          ORDER BY published_at DESC LIMIT 3
        `, [stockMeta.sector]);
      }

      if (news.length > 0) {
        enriched.recent_news = news.map(n => ({
          title: n.title,
          sentiment: n.sentiment,
          impact: n.impact,
          category: n.category,
        }));
      }

      // Strip nulls so the prompt only contains meaningful data
      const payload = Object.fromEntries(
        Object.entries(enriched).filter(([, v]) => v !== null && v !== undefined)
      );

      return generateStockAnalysis(symbol, payload);
    }),

  getSuperstarList: publicProcedure
    .query(async () =>
      fetchWithCache('superstar_list', async () => {
        const res = await fetch(
          'https://portal.tradebrains.in/api/prices/superstar/portfolio/star/view/?page_size=100&page=1&search=',
          {
            headers: {
              Accept: 'application/json, text/plain, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              Referer: 'https://portal.tradebrains.in/superstar-portfolio',
              Origin: 'https://portal.tradebrains.in',
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!res.ok) throw new Error(`TradeBrains superstar list HTTP ${res.status}`);
        return res.json();
      }, 3600)
    ),

  getSuperstarPortfolio: publicProcedure
    .input(z.object({ slug: z.string(), quarter: z.string() }))
    .query(async ({ input }) =>
      fetchWithCache(`superstar_${input.slug}_${input.quarter}`, async () => {
        const url = `https://portal.tradebrains.in/api/prices/superstar/stocklist/${encodeURIComponent(input.slug)}/?quater=${input.quarter}&sort_by=total_quantity&is_ascending=false`;
        const res = await fetch(url, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Referer: `https://portal.tradebrains.in/superstar-portfolio/${input.slug}`,
            Origin: 'https://portal.tradebrains.in',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`TradeBrains portfolio ${input.slug} HTTP ${res.status}`);
        return res.json();
      }, 1800)
    ),

  analyzePortfolio: publicProcedure
    .input(z.object({ symbols: z.array(z.string()), weights: z.array(z.number()) }))
    .mutation(async ({ input }) => {
      try {
        return await alphaQuant.analyzePortfolio(input);
      } catch (e: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: e.message });
      }
    }),

  getPremarket: publicProcedure
    .query(async () => fetchPremarketAll()),

  getDeals: publicProcedure
    .query(async () => fetchDealsAll()),

  // block_deals (tickertape_deals_fetcher.py + block_deal_fetcher.py) has no other reader —
  // pct_transacted (% of float) is the field this source exists for, since raw qty/value alone
  // isn't comparable across a microcap vs. a large-cap.
  getBlockDeals: publicProcedure
    .input(z.object({ symbol: z.string().optional(), limit: z.number().min(1).max(200).optional().default(100) }))
    .query(async ({ input }) => {
      try {
        const rows = await dbAll<any>(
          `SELECT symbol, date, qty, price, value_cr, pct_transacted, client_name, trade_type, category
           FROM block_deals
           ${input.symbol ? "WHERE symbol = ?" : ""}
           ORDER BY date DESC
           LIMIT ?`,
          input.symbol ? [input.symbol.toUpperCase(), input.limit] : [input.limit]
        );
        return rows || [];
      } catch {
        return [];
      }
    }),

  // ── 2026-08-06 urls.txt data analysis: structured tables replacing raw-archived endpoints ──
  // (docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md). These read persisted history from
  // sector_intel/institutional_deals/concall fetchers, complementing (not replacing) getDeals
  // above — getDeals is a live on-demand snapshot across all 3 dealsTypes with no history;
  // getInstitutionalDealHistory below is a persisted, queryable, freshness-monitored
  // topInvestor-only trend.

  getSectorRotationIntel: publicProcedure
    .query(async () => fetchWithCache('sector_rotation_intel', async () => {
      const [rrg, pairs, stats, summary] = await Promise.all([
        dbAll<any>(`
          SELECT sector, week_date, rs_ratio, rs_momentum, sector_return, stocks_count, quadrant
          FROM sector_rrg_history
          WHERE week_date = (SELECT MAX(week_date) FROM sector_rrg_history)
          ORDER BY rs_ratio DESC
        `),
        dbAll<any>(`
          SELECT sector_a, sector_b, correlation, pair_type
          FROM sector_correlation_pairs
          WHERE data_date = (SELECT MAX(data_date) FROM sector_correlation_pairs)
            AND pair_type IS NOT NULL
          ORDER BY pair_type, correlation DESC
        `),
        dbAll<any>(`
          SELECT sector, avg_daily_return, volatility, total_return, data_points
          FROM sector_correlation_stats
          WHERE data_date = (SELECT MAX(data_date) FROM sector_correlation_stats)
          ORDER BY total_return DESC
        `),
        dbGet<any>(`
          SELECT data_date, avg_pairwise_correlation, pct_pairs_above_0_7, total_pairs, takeaway
          FROM sector_correlation_summary
          ORDER BY data_date DESC LIMIT 1
        `),
      ]);
      return { rrg, correlationPairs: pairs, sectorStats: stats, summary: summary ?? null };
    }, 900)),

  getInstitutionalDealHistory: publicProcedure
    .input(z.object({ symbol: z.string().optional(), days: z.number().min(1).max(90).optional().default(14) }))
    .query(async ({ input }) => {
      const key = `inst_deals_${input.symbol ?? 'all'}_${input.days}`;
      return fetchWithCache(key, async () => {
        const params: any[] = [];
        let where = `deal_date >= date('now', '-${input.days} days')`;
        if (input.symbol) { where += ` AND symbol = ?`; params.push(input.symbol.toUpperCase()); }
        return dbAll<any>(`
          SELECT symbol, exchange, sector, action, deal_type, deal_date, counterparty,
                 quantity, deal_price, deal_value_cr_1w, deals_count_1w
          FROM institutional_deal_signals
          WHERE ${where}
          ORDER BY deal_date DESC, deal_value_cr_1w DESC
          LIMIT 200
        `, params);
      }, 900);
    }),

  getConcallTakeaways: publicProcedure
    .input(z.object({ symbol: z.string().optional(), limit: z.number().min(1).max(50).optional().default(20) }))
    .query(async ({ input }) => {
      const key = `concall_takeaways_${input.symbol ?? 'all'}_${input.limit}`;
      return fetchWithCache(key, async () => {
        const params: any[] = [];
        let where = '1=1';
        if (input.symbol) { where += ` AND symbol = ?`; params.push(input.symbol.toUpperCase()); }
        params.push(input.limit);
        return dbAll<any>(`
          SELECT symbol, company_name, quarter, fiscal_year, key_takeaway, tone_assessment,
                 transcript_source, announcement_date, generated_at
          FROM concall_takeaways
          WHERE ${where}
          ORDER BY announcement_date DESC
          LIMIT ?
        `, params);
      }, 900);
    }),

  // intraday_ranker.py's emission gate (both directions) -- app_settings row it writes on
  // every run. Short TTL: the ranker re-runs every 15 min during market hours and the gate can
  // in principle flip mid-session, so a stale cached read here would show a wrong state longer
  // than necessary.
  getIntradayEmissionGateStatus: publicProcedure
    .query(async () => fetchWithCache('intraday_emission_gate_status', async () => {
      const row = await dbGet<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = 'intraday_emission_gate_status'`
      );
      if (!row?.value) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }, 60)),

  getMarketMoodIndex: publicProcedure
    .query(async () => fetchWithCache('market_mood_index', async () => {
      const rows = await dbAll<any>(`
        SELECT date, close AS indicator
        FROM macro_asset_prices
        WHERE symbol = 'INDIA_MMI'
        ORDER BY date DESC LIMIT 30
      `);
      if (!rows.length) return null;
      const latest = rows[0];
      const value = Number(latest.indicator);
      const zone = value > 70 ? 'Extreme Greed' : value > 50 ? 'Greed' : value > 30 ? 'Fear' : 'Extreme Fear';
      return { date: latest.date, indicator: value, zone, trail: rows.slice(1, 8) };
    }, 900)),

  // Insider/promoter transactions: was raw NSE PIT filings from insider_transactions, but that
  // table has been stuck at 2026-05-02 for 3+ months (NSE's corporates-pit endpoint ignores its
  // own from/to params -- see insider_transactions_fetcher.py's compute_and_write_features
  // docstring, 2026-08-07) -- confirmed live 2026-08-14 (23,596 rows, still MAX(transaction_date)
  // = 2026-05-02). The ML feature side switched to insider_trades (MoneyControl + Tickertape,
  // fresh to within a day, already used for technical_signals.promoter_*_90d_cr) that same day,
  // but this UI-facing procedure was missed and kept serving the frozen table. Repointed
  // 2026-08-14. Trade-off: insider_trades has no before/after %holding (that's NSE PIT-specific;
  // this source's closest analogue is pct_transacted, % of float, not carried here since no
  // consumer reads it) -- before_pct/after_pct now come back null, which every consumer already
  // renders as '—'.
  getInsiderTransactions: publicProcedure
    .input(z.object({ symbol: z.string().optional(), limit: z.number().min(1).max(200).optional().default(100) }))
    .query(async ({ input }) => {
      try {
        const rows = await dbAll<any>(
          `SELECT symbol, "acquirerName" AS person_name, category AS person_category,
                  "typeOfTransaction" AS transaction_mode, quantity,
                  ROUND(CAST("valueInr" AS NUMERIC) / 1e7, 4) AS value_cr,
                  NULL AS before_pct, NULL AS after_pct, date_iso AS transaction_date
           FROM insider_trades
           ${input.symbol ? "WHERE symbol = ?" : ""}
           ORDER BY date_iso DESC
           LIMIT ?`,
          input.symbol ? [input.symbol.toUpperCase(), input.limit] : [input.limit]
        );
        return rows || [];
      } catch (e: any) {
        console.error("[Misc Router] Error fetching insider transactions:", e);
        return [];
      }
    }),

  getSensibullEvents: publicProcedure
    .query(async () => {
      return fetchWithCache('sensibull_current_events', async () => {
        const url = 'https://api.sensibull.com/v1/current_events';
        return mcFetchJson<any>(url);
      }, 300000);
    }),

  // .optional() on the outer object, not just the date field -- v5's EarningsPulseDeskPage.tsx
  // (rendered for dashboardVersion==='v6' at /earnings, see App.tsx's Phase 2 wiring) calls
  // trpc.getEarnings.useQuery(undefined, ...), and Zod rejects a bare undefined against a
  // required z.object() even when every field inside it is optional -- same class of bug as
  // getAdvanceDecline's 2026-08-04 fix. v1/v2/v3's EarningsPage.tsx always sends a real
  // { date } object so it never hit this; v4's EarningsPulseWidget.tsx passes {} so it didn't
  // either -- confirmed live 2026-08-07 as a genuine 400 on every /earnings load under v6.
  getEarnings: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(async ({ input }) => fetchEarningsAll(input?.date)),

  getEarningsCalendar: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => fetchEarningsCalendar(input.date)),

  getEarningsPriceShockers: publicProcedure
    .query(async () => fetchEarningsPriceShockers()),

  getEarningsSummary: publicProcedure
    .input(z.object({ scId: z.string() }))
    .query(async ({ input }) => {
      return fetchWithCache(`earnings_summary_${input.scId}`, async () => {
        return fetchStockEarningsSummary(input.scId);
      }, 300000);
    }),

  getEarningsRapidResults: publicProcedure
    .input(z.object({ type: z.enum(['LR', 'BP']).optional().default('BP') }))
    .query(async ({ input }) => fetchEarningsRapidResults(input.type)),

  // Was uncached despite being polled every 60s by TradeDecisionCockpit.tsx from every open
  // tab -- the full query set + composite-scoring computation below reran from scratch on every
  // single request even though technical_signals/unified_signals/stock_scores/
  // news_sentiment_items only change on batch-job cadence. TTL matched to the frontend's own
  // poll interval so a cache hit never serves data older than one poll cycle would anyway.
  getTradeDecisionCockpitData: publicProcedure
    .query(async () => fetchWithCache('misc:trade-decision-cockpit', async () => {
      try {
        // Pull latest technical snapshot per symbol (most recent date per symbol)
        // Fixed 2026-07-30 (Finding #33, full-stack audit): the correlated subquery
        // re-executed once per outer row with no date bound -- O(total historical rows)
        // instead of O(distinct symbols). ROW_NUMBER() computed over the UNFILTERED
        // per-symbol history (then filtered by rn=1 AND cmp>0 in the outer WHERE, not
        // pushed into the partitioned subquery) preserves the original semantics exactly:
        // a symbol is excluded when its truly-latest row lacks a valid cmp, rather than
        // silently falling back to an earlier row that happens to have one. Also added a
        // `symbol ASC` tiebreaker to the ORDER BY -- the original had none, so with (date,
        // signal_score) tied across hundreds of symbols on any given day, LIMIT 200 was
        // returning a non-reproducible arbitrary subset (confirmed live: the correlated-
        // subquery and window-function query plans picked entirely different 200-symbol
        // sets from the same underlying ties before this tiebreaker was added).
        const signals = await dbAll<Record<string, unknown>>(`
          SELECT * FROM (
            SELECT ts.*, ns.sector, ns.industry,
                   ROW_NUMBER() OVER (PARTITION BY ts.symbol ORDER BY ts.date DESC) AS rn
            FROM technical_signals ts
            LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
          ) t
          WHERE rn = 1 AND cmp IS NOT NULL AND cmp > 0
          ORDER BY date DESC, signal_score DESC, symbol ASC
          LIMIT 200
        `);

        // Best signal levels from unified_signals (entry/target/SL) — ignore stale signals >30 days
        const thirtyDaysAgoIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const signalLevels = await dbAll<Record<string, unknown>>(`
          SELECT symbol, entry_price AS entry, target_price AS target,
                 stop_loss AS "stopLoss", confidence_score AS confidence
          FROM unified_signals
          WHERE signal_type = 'BUY' AND status = 'ACTIVE' AND entry_price IS NOT NULL AND entry_price > 0
            AND signal_generated_at >= ?
          ORDER BY confidence_score DESC, id DESC
        `, [thirtyDaysAgoIso]);
        const levelsMap = new Map<string, Record<string, unknown>>();
        for (const sl of signalLevels) {
          if (!levelsMap.has(sl.symbol as string)) levelsMap.set(sl.symbol as string, sl);
        }

        // stock_scores schema varies by scoring engine version — use try/catch to degrade gracefully
        let quantRows: Array<Record<string, unknown>> = [];
        try {
          quantRows = await dbAll<Record<string, unknown>>(`
            SELECT symbol, score AS composite_score, confidence AS technical_score,
                   score AS fundamental_score, score AS momentum_score,
                   0 AS sentiment_score, 0 AS risk_score, timeframe
            FROM stock_scores WHERE timeframe IN ('intraday','short','long_term')
            ORDER BY score DESC LIMIT 400
          `);
        } catch { /* schema mismatch — quantMap stays empty, scoring uses technical fallback */ }

        const quantMap = new Map<string, Record<string, unknown>>();
        for (const q of quantRows) quantMap.set(q.symbol as string, q);

        let newsSentiment: Array<Record<string, unknown>> = [];
        try {
          newsSentiment = await dbAll<any>(`SELECT symbol, sentiment_score FROM news_sentiment_items WHERE published_at >= datetime('now', '-7 days') ORDER BY published_at DESC`);
        } catch { /* table may not exist */ }

        const sentimentMap = new Map<string, number[]>();
        for (const n of newsSentiment) {
          const sym = n.symbol as string;
          if (!sentimentMap.has(sym)) sentimentMap.set(sym, []);
          sentimentMap.get(sym)!.push(n.sentiment_score as number);
        }

        // Heuristic fallback — only used when technical_signals.win_probability is NULL
        const heuristicWinProb = (sig: Record<string, unknown>): number => {
          let score = 0.5;
          const rsi = sig.rsi as number | null;
          const macd = sig.macd as number | null;
          const macdSig = sig.macd_signal as number | null;
          const cmp = sig.cmp as number | null;
          const sma50 = sig.sma50 as number | null;
          const sma200 = sig.sma200 as number | null;
          const adx = sig.adx as number | null;
          if (rsi != null) {
            if (rsi >= 50 && rsi < 70) score += 0.06;
            else if (rsi < 30) score += 0.04;
            else if (rsi >= 70) score -= 0.05;
          }
          if (macd != null && macdSig != null) score += macd > macdSig ? 0.08 : -0.05;
          if (cmp != null && sma50 != null)    score += cmp > sma50    ? 0.06 : -0.04;
          if (cmp != null && sma200 != null)   score += cmp > sma200   ? 0.05 : -0.03;
          if (adx != null && adx > 25)         score += 0.04;
          return Math.max(0.35, Math.min(0.85, score));
        };

        const symbolMap = new Map<string, {
          sig: Record<string, unknown>;
          quant: Record<string, unknown> | undefined;
          avgSentiment: number;
          sector: string;
          winProb: number;
        }>();

        for (const sig of signals) {
          const sym = sig.symbol as string;
          if (symbolMap.has(sym)) continue; // keep first (most recent)
          const scores = sentimentMap.get(sym) || [];
          // Prefer ML-calibrated win_probability stored by the scoring engine; fall back to heuristic.
          // Was reading sig.win_probability (raw) despite this comment — ts.* already carries
          // calibrated_win_probability, it just wasn't selected here (2026-07-18 gating follow-up).
          const dbWinProb = (sig.calibrated_win_probability as number | null) ?? (sig.win_probability as number | null);
          const winProb = dbWinProb != null ? Math.max(0.35, Math.min(0.95, dbWinProb)) : heuristicWinProb(sig);
          symbolMap.set(sym, {
            sig,
            quant: quantMap.get(sym),
            avgSentiment: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
            sector: (sig.sector as string) || 'Unknown',
            winProb,
          });
        }

        const candidates = Array.from(symbolMap.entries()).map(([symbol, data]) => {
          const { sig, quant, winProb } = data;
          const cmp = sig.cmp as number;

          const techScore  = quant ? (quant.technical_score  as number) || 0 : winProb * 100;
          const fundScore  = quant ? (quant.fundamental_score as number) || 0 : 50;
          const momScore   = quant ? (quant.momentum_score    as number) || 0 : winProb * 80;
          const sentScore  = data.avgSentiment > 0 ? 60 + data.avgSentiment * 40 : 50;
          const smartScore = 50;
          const compositeScore = techScore * 0.40 + fundScore * 0.20 + momScore * 0.20 + sentScore * 0.10 + smartScore * 0.10;

          // Entry/target/SL: use signals table if available, else derive from CMP + SMA
          const levels = levelsMap.get(symbol);
          const sma50 = sig.sma50 as number | null;
          const derivedEntry  = cmp;
          const derivedStop   = sma50 ? Math.max(sma50 * 0.985, cmp * 0.95) : cmp * 0.95;
          const derivedTarget = cmp * 1.10;

          const entryPrice  = levels ? (levels.entry  as number) : parseFloat(derivedEntry.toFixed(2));
          const stopLoss    = levels ? (levels.stopLoss as number) : parseFloat(derivedStop.toFixed(2));
          const targetPrice = levels ? (levels.target  as number) : parseFloat(derivedTarget.toFixed(2));

          const actionAdvice = compositeScore >= 70 ? 'STRONG BUY'
            : compositeScore >= 60 ? 'BUY'
            : compositeScore >= 50 ? 'WATCH'
            : 'HOLD';

          return {
            symbol, name: getStockMapping(symbol)?.name || symbol, sector: data.sector,
            advice: actionAdvice, actionAdvice,
            compositeScore: parseFloat(compositeScore.toFixed(1)),
            mlWinProbability: parseFloat((winProb * 100).toFixed(1)),
            mlProbability:    parseFloat((winProb * 100).toFixed(1)),
            techSignalCount: 1,
            quantRank: Math.round(100 - fundScore),
            smartMoneyCr: 0,
            newsSentiment: parseFloat(data.avgSentiment.toFixed(2)),
            factors: {
              technical:   parseFloat(techScore.toFixed(1)),
              fundamental: parseFloat(fundScore.toFixed(1)),
              momentum:    parseFloat(momScore.toFixed(1)),
              sentiment:   parseFloat(sentScore.toFixed(1)),
              smartMoney:  parseFloat(smartScore.toFixed(1)),
            },
            entryPrice, targetPrice, stopLoss,
            rsi:         sig.rsi        ?? null,
            macd:        sig.macd       ?? null,
            macdSignal:  sig.macd_signal ?? null,
            sma50:       sig.sma50      ?? null,
            sma200:      sig.sma200     ?? null,
            bbWidth:     sig.bb_width   ?? null,
            volumeRatio: sig.volume_ratio ?? null,
            cmp, changePct: (sig.change_pct as number) || 0,
            aiInsight:   (sig.ai_insight as string)  || null,
            signalsJson: (sig.signals_json as string) || '[]',
          };
        });

        candidates.sort((a, b) => b.compositeScore - a.compositeScore);
        const top20 = candidates.slice(0, 20);
        const bullish = candidates.filter(c => c.mlProbability > 55).length;
        const total   = candidates.length;
        const advDecRatio = total > 0 ? parseFloat((bullish / Math.max(1, total - bullish)).toFixed(2)) : 1;
        const avgWinProbability = candidates.length
          ? parseFloat((candidates.reduce((s, c) => s + c.mlProbability, 0) / candidates.length).toFixed(1))
          : 0;
        const verdict = top20.length >= 3 && avgWinProbability >= 52 ? 'TRADE' : 'NO TRADE';
        const verdictReason = verdict === 'TRADE'
          ? `${top20.length} setups · avg win rate ${avgWinProbability}% · ${bullish}/${total} stocks bullish`
          : top20.length < 3 ? 'Insufficient setups — run Technical Signal Scan first' : 'Win probability below threshold';

        // `signals` is ORDER BY date DESC first, so signals[0].date is the most recent
        // technical_signals scan date any candidate here is grounded in -- surfaced to the
        // frontend so a trader can tell whether this verdict reflects today's scan or a stale
        // one, rather than trusting the table's mere presence.
        const asOfDate = (signals[0]?.date as string) ?? null;

        return {
          success: true,
          data: {
            marketOverview: { verdict, verdictReason, advDecRatio, avgWinProbability, activeSignalsCount: candidates.length, asOfDate },
            candidates: top20,
          },
        };
      } catch (err) {
        return { success: false, data: { marketOverview: { verdict: 'NO TRADE', verdictReason: 'Data unavailable', advDecRatio: 1, avgWinProbability: 0, activeSignalsCount: 0 }, candidates: [] } };
      }
    }, 45)),

  // One reverse-chronological feed merging the two event sources that actually change during a
  // trading day (new BUY/SELL signals + market-moving news) into a single timeline a trader can
  // scan top-to-bottom, instead of cross-referencing the Signal Ledger and News tabs separately.
  // Deliberately excludes NEUTRAL/HOLD signals (pure noise at platform scale -- thousands/day
  // across ~2450 stocks) and does NOT threshold on confidence/win_probability: this codebase's
  // own calibrated win-probability values run low (documented baseline ~35-41%), so a naive
  // score cutoff would silently empty the feed rather than surface real activity.
  getActivityFeed: publicProcedure
    .input(z.object({ hours: z.number().min(1).max(72).default(24), limit: z.number().min(10).max(150).default(60) }).optional())
    .query(async ({ input }) => {
      const hours = input?.hours ?? 24;
      const limit = input?.limit ?? 60;
      return fetchWithCache(`misc:activity-feed:${hours}:${limit}`, async () => {
        const cutoffIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        const [signalRows, newsRows] = await Promise.all([
          dbAll<Record<string, unknown>>(`
            SELECT symbol, signal_source, signal_type, entry_price, target_price, stop_loss,
                   confidence_score, signal_generated_at, reasoning
            FROM unified_signals
            WHERE signal_type IN ('BUY', 'SELL') AND signal_generated_at >= ?
            ORDER BY signal_generated_at DESC
            LIMIT ?
          `, [cutoffIso, limit]).catch(() => []),
          (async () => {
            try {
              const { getNewsItems } = await import('../newsSentimentService');
              return await getNewsItems({ hours, limit });
            } catch { return []; }
          })(),
        ]);

        type ActivityItem = {
          id: string; type: 'SIGNAL' | 'NEWS'; timestamp: string;
          symbol: string | null; headline: string; detail: string | null;
          tag: string; tagSentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; source: string; url: string | null;
        };

        const signalItems: ActivityItem[] = signalRows.map((s, i): ActivityItem => ({
          id: `sig-${s.symbol}-${s.signal_generated_at}-${i}`,
          type: 'SIGNAL',
          timestamp: s.signal_generated_at as string,
          symbol: s.symbol as string,
          headline: `${s.signal_type} signal · ${s.symbol}`,
          detail: (s.reasoning as string) || (s.entry_price ? `Entry ₹${s.entry_price}${s.target_price ? ` · Target ₹${s.target_price}` : ''}${s.stop_loss ? ` · SL ₹${s.stop_loss}` : ''}` : null),
          tag: `${s.signal_source ?? 'SIGNAL'}`,
          tagSentiment: s.signal_type === 'BUY' ? 'BULLISH' : 'BEARISH',
          source: (s.signal_source as string) || 'Signal Engine',
          url: null,
        }));

        const newsItems: ActivityItem[] = (newsRows as unknown as Array<Record<string, unknown>>).map((n, i): ActivityItem => {
          let symbols: string[] = [];
          try { symbols = JSON.parse((n.symbols_json as string) || '[]'); } catch { /* ignore malformed */ }
          const sentiment = n.sentiment as string | undefined;
          return {
            id: `news-${n.id ?? i}`,
            type: 'NEWS',
            timestamp: (n.published_at as string) || (n.fetched_at as string),
            symbol: symbols[0] || null,
            headline: n.title as string,
            detail: (n.summary as string) || null,
            tag: (n.category as string) || 'NEWS',
            tagSentiment: sentiment === 'BULLISH' || sentiment === 'BEARISH' ? sentiment : 'NEUTRAL',
            source: (n.source as string) || 'News',
            url: (n.url as string) || null,
          };
        });

        const items = [...signalItems, ...newsItems]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, limit);

        return { success: true, items, generatedAt: new Date().toISOString() };
      }, 60);
    }),
});
