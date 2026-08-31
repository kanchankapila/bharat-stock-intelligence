import { z } from "zod";
import { dbGet, dbAll, dbRun } from "../dbAsync";
import { fetchMCScreener } from "../moneycontrol";
import { fetchETnowScreener } from "../etnow";
import { fetchTrendingScreeners, fetchETPennyStocks, fetchETStats } from "../marketData";
import { getOrRefreshAllStocks } from "../liveStockData";
import {
  fetchTrendlyneScreenerData,
  fetchAllTrendlyneScreenerNames,
  getTrendlyneScreenerList,
  getTrendlyneScreenerCategories,
  updateFetchInterval,
  updateScreenerNamesInterval,
  testTrendlyneApiResponse,
  recategorizeAllScreeners,
} from "../trendlyneScreener";
import { router, publicProcedure, adminProcedure, expensiveProcedure } from "../trpc";
import { SCANNER_CATALOG } from "../config/scannerCatalog";

// Real quant_scores columns runScreener is allowed to filter on (see db.ts's CREATE TABLE).
// A zod enum, not a free-form string -- prevents a client-supplied "id" from being
// interpolated into the WHERE clause as arbitrary SQL.
const SCREENER_CRITERIA_COLUMNS = [
  'return_1w', 'return_1m', 'return_3m', 'return_6m', 'return_12m',
  'above_sma200', 'sma200_distance_pct', 'momentum_score',
  'annualized_vol', 'sharpe_ratio', 'max_drawdown_1y', 'vol_rank', 'sharpe_rank',
  'trailing_pe', 'forward_pe', 'debt_to_equity', 'return_on_equity',
  'operating_margins', 'revenue_growth', 'piotroski_f_score', 'valuation_score',
  'bullish_screener_count', 'bearish_screener_count', 'screener_category_breadth',
  'screener_net_score', 'confluence_rank',
  'rank_momentum', 'rank_quality', 'rank_value', 'rank_composite',
] as const;

const factorPickSchema = z.object({
  symbol: z.string().min(1),
  date: z.string(),
  score: z.number().finite(),
  close: z.number().finite().optional(),
  next_open: z.number().finite().optional(),
  r12_1: z.number().finite().optional(),
  vol21: z.number().finite().optional(),
  adt20: z.number().finite().optional(),
});

const factorPicksSnapshotSchema = z.object({
  factor: z.literal('momentum_12_1'),
  asOf: z.string(),
  // Entry state, not just age. 'entry_passed' means the open this list would have entered on
  // has already traded, so the list is a record and not a trade — a distinction `asOf` alone
  // cannot express. Defaulted rather than required so a snapshot written by the pre-2026-08-10
  // producer still parses instead of the panel silently vanishing; it degrades to the
  // pessimistic reading, which is the safe direction for a stale snapshot.
  entryStatus: z.enum(['pending_next_open', 'entry_passed']).default('entry_passed'),
  entrySession: z.string().nullable().default(null),
  generatedAt: z.string(),
  validatedTopKMin: z.number().int().min(50),
  evidence: z.literal('paper_trade_candidate'),
  caveat: z.string().min(1),
  picks: z.array(factorPickSchema),
});

export function parseFactorPicksSnapshot(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = factorPicksSnapshotSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const screenersRouter = router({
  getTrendingScreeners: publicProcedure
    .query(async () => fetchTrendingScreeners()),

  getETPennyStocks: publicProcedure
    .query(async () => fetchETPennyStocks()),

  getETStats: publicProcedure
    .input(z.object({ type: z.enum(['gainers', 'losers']), duration: z.string().optional() }))
    .query(async ({ input }) => fetchETStats(input.type, input.duration)),

  getMarketScanners: publicProcedure
    .query(() => SCANNER_CATALOG),

  fetchMarketData: publicProcedure
    .input(z.object({ provider: z.string(), params: z.any() }))
    .query(async ({ input }) => {
      if (input.provider === 'mc') {
        const { type, catId, scanId } = input.params;
        return fetchMCScreener(type as any, catId, scanId);
      }
      if (input.provider === 'et') {
        const { screenerId, queryCondition } = input.params;
        return fetchETnowScreener(screenerId, queryCondition);
      }
      if (input.provider === 'custom') {
        const { timeframes, minVolume = 0, minMktCap = 0, sector } = input.params;
        const allStocks = await getOrRefreshAllStocks();
        const parseVol = (v: string): number => {
          if (!v) return 0;
          if (v.endsWith('M')) return parseFloat(v) * 1_000_000;
          if (v.endsWith('K')) return parseFloat(v) * 1_000;
          return parseFloat(v) || 0;
        };
        const parseMarketCap = (value: any): number => {
          if (value == null) return 0;
          if (typeof value === 'number') return value;
          const str = String(value).replace(/[,₹\s]/g, '').toUpperCase();
          if (str.endsWith('M')) return parseFloat(str.slice(0, -1)) * 1_000_000;
          if (str.endsWith('B')) return parseFloat(str.slice(0, -1)) * 1_000_000_000;
          if (str.endsWith('K')) return parseFloat(str.slice(0, -1)) * 1_000;
          return parseFloat(str) || 0;
        };

        const shouldMatchSector = (s: any) => {
          if (!sector || sector === 'All') return true;
          return String(s.sector || s.industry || '').toLowerCase() === String(sector).toLowerCase();
        };

        const selected = allStocks
          .filter((s: any) => {
            const vol = parseVol(s.volume);
            const mcap = parseMarketCap(s.marketCap ?? s.mcap ?? s.market_cap ?? s.marketCapText ?? s.mcapText ?? '');
            return s.changePct > 0 && vol > minVolume && s.price > 0 && shouldMatchSector(s) && mcap >= minMktCap;
          })
          .sort((a: any, b: any) => b.changePct - a.changePct)
          .slice(0, 50)
          .map((s: any) => ({
            symbol: s.symbol, name: s.name, ltp: s.price,
            perChg: s.changePct.toFixed(2), volume: s.volume,
            mktCap: s.marketCap ?? s.mcap ?? s.market_cap ?? '—', sector: s.sector || '—',
            timeframesMet: timeframes?.join(', ') || 'D, W',
            momentum: s.changePct > 2 ? 'Strong Bullish' : 'Bullish',
            pattern: s.high52w && (s.price / s.high52w) > 0.95 ? 'Near 52W High' : 'Uptrend',
          }));
        return {
          success: true,
          searchResult: { searchData: { records: selected } },
          data: { list: { scannerDetails: selected.map(s => ({ ...s, columns: [
            { name: 'LTP', value: s.ltp }, { name: '% Change', value: s.perChg },
            { name: 'Volume', value: s.volume }, { name: 'Momentum', value: s.momentum },
          ] })) } },
        };
      }
      throw new Error('Unknown provider');
    }),

  getTrendlyneScreener: publicProcedure
    .input(z.object({ screenpk: z.string(), screenerName: z.string(), pageNumber: z.number().optional().default(0) }))
    .query(async ({ input }) => {
      if (input.screenpk.startsWith('MC_')) {
        const scanId = input.screenpk.replace('MC_', '');
        const stocks = await dbAll<any>(`
          SELECT ss.symbol as "stockId", ss.stock_name as name, ss.symbol
          FROM moneycontrol_screener_stocks ss WHERE ss.scan_id = ?
        `, [scanId]);
        return {
          success: true,
          data: stocks.map(s => ({
            stockId: s.stockId || s.symbol || '', name: s.name || s.symbol || '',
            symbol: s.symbol || s.stockId || '', ltp: 0, change: 0, changePercent: 0,
            screenerName: input.screenerName, screenerType: 'moneycontrol',
          })),
          screenerName: input.screenerName, totalResults: stocks.length,
        };
      }
      if (input.screenpk.startsWith('ET_')) {
        const screenerId = input.screenpk.replace('ET_', '');
        const etScreener = await dbGet<{ query_condition: string }>(
          'SELECT query_condition FROM etnow_screeners WHERE screener_id = ?', [screenerId]);
        if (etScreener) {
          const result = await fetchETnowScreener(screenerId, etScreener.query_condition);
          const records = result?.searchResult?.searchData?.records || [];
          return {
            success: true,
            data: records.map((r: any) => ({
              stockId: r.symbol || '', name: r.companyName || r.name || '',
              ltp: parseFloat(r.currentPrice || 0), change: parseFloat(r.priceChange || 0),
              changePercent: parseFloat(r.percentChange || 0),
              screenerName: input.screenerName, screenerType: 'etnow',
            })),
            screenerName: input.screenerName, totalResults: records.length,
          };
        }
      }
      return fetchTrendlyneScreenerData(input.screenpk, input.screenerName, input.pageNumber);
    }),

  getTrendlyneCategories: publicProcedure
    .query(() => getTrendlyneScreenerCategories()),

  getTrendlyneScreenerNames: publicProcedure
    .query(async () => getTrendlyneScreenerList()),

  configTrendlyneFetchInterval: adminProcedure
    .input(z.object({ intervalMs: z.number().min(0), type: z.enum(['screener', 'names']).optional().default('screener') }))
    .mutation(({ input }) => {
      if (input.type === 'names') updateScreenerNamesInterval(input.intervalMs);
      else updateFetchInterval(input.intervalMs);
      return {
        success: true,
        message: `${input.type} fetch interval updated to ${input.intervalMs}ms (${(input.intervalMs / 1000 / 60).toFixed(2)} minutes)`,
      };
    }),

  testTrendlyneApi: publicProcedure
    .input(z.object({ stockId: z.string().optional() }))
    .query(async ({ input }) => testTrendlyneApiResponse(input.stockId)),

  fetchTrendlyneScreenerNames: publicProcedure
    .query(async () => fetchAllTrendlyneScreenerNames()),

  getStockScreeners: publicProcedure
    .input(z.object({ stockId: z.string() }))
    .query(async ({ input }) => {
      const { findScreenersByStock } = await import('../trendlyneScreener');
      const { findMcScreenersByStock } = await import('../moneycontrolScreener');
      const { findEtScreenersByStock } = await import('../etnow');
      const { findEtMarketstatsScreenersByStock } = await import('../etMarketstatsSync');
      // These 4 lookups hit independent tables keyed on the same stockId -- were run
      // sequentially (await, await, await, await), tripling+ this call's latency for no
      // reason. Independent, so fan them out concurrently instead.
      const [trendlyne, mc, et, etMarketstats] = await Promise.all([
        findScreenersByStock(input.stockId),
        findMcScreenersByStock(input.stockId),
        findEtScreenersByStock(input.stockId),
        findEtMarketstatsScreenersByStock(input.stockId),
      ]);
      return [...trendlyne, ...mc, ...et, ...etMarketstats];
    }),

  getEtMarketstatsScreeners: publicProcedure
    .query(async () => {
      const { getEtMarketstatsScreenerDefs } = await import('../etMarketstats');
      return getEtMarketstatsScreenerDefs();
    }),

  refreshTrendlyneScreenersDB: adminProcedure
    .mutation(async () => {
      const screenerNames = await fetchAllTrendlyneScreenerNames(true);
      return { success: true, message: `Refreshed screener database with ${screenerNames.size} screeners`, count: screenerNames.size };
    }),

  recategorizeTrendlyneScreeners: adminProcedure
    .mutation(async () => recategorizeAllScreeners()),

  // ── Screener Intelligence (Sub-project A) ─────────────────────────────────

  // RETRACTED 2026-08-12 (measurement.md's top banner): both factors' significance depended on
  // factor_backtest.py's exit-pricing bug, now fixed -- neither clears significance any more
  // (value_book_to_price t 2.67->1.99, momentum_12_1 t 2.08->1.10). Kept as paper screens for
  // visibility, not as validated edges (AF-20260818-37). Shape kept backward compatible: the
  // top-level fields still describe momentum_12_1 for any existing caller, `factors` alongside.
  getFactorPaperPicks: publicProcedure.query(async () => {
    const keys = ['value_book_to_price', 'momentum_12_1'] as const;
    const rows = await Promise.all(keys.map(f =>
      dbGet<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = ?', [`factor_picks_${f}`]
      )
    ));
    const factors = keys
      .map((f, i) => ({ factor: f, ...parseFactorPicksSnapshot(rows[i]?.value) }))
      .filter(s => s.picks?.length);
    const legacy = parseFactorPicksSnapshot(rows[keys.indexOf('momentum_12_1')]?.value);
    return { ...legacy, factors };
  }),

  getScreenerLeaderboard: publicProcedure
    .input(z.object({
      category:    z.string().optional(),
      subcategory: z.string().optional(),
      source:      z.enum(['trendlyne', 'moneycontrol', 'etnow']).optional(),
      horizon:     z.enum(['5d', '10d', '20d', '60d', '120d']).default('20d'),
      tier:        z.enum(['A', 'B', 'C', 'D', 'Unranked']).optional(),
      limit:       z.number().min(1).max(200).default(50),
      offset:      z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const validHorizonCols: Record<string, string> = {
        '5d': 'wr_5d', '10d': 'wr_10d', '20d': 'wr_20d', '60d': 'wr_60d', '120d': 'wr_120d',
      };
      const wrCol = validHorizonCols[input.horizon] ?? 'wr_20d';

      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.category)    { conditions.push('sm.inferred_category = ?'); params.push(input.category); }
      if (input.subcategory) { conditions.push('sm.subcategory = ?');        params.push(input.subcategory); }
      if (input.source)      { conditions.push('spv.source = ?');            params.push(input.source); }
      if (input.tier)        { conditions.push('spv.tier = ?');              params.push(input.tier); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(input.limit, input.offset);

      return dbAll(`
        SELECT
          spv.screener_id,
          sm.name,
          spv.source,
          sm.inferred_category  AS category,
          sm.subcategory,
          spv.tier,
          spv.bayesian_score,
          spv.${wrCol}          AS win_rate,
          spv.avg_ret_20d       AS avg_return,
          spv.alpha_20d         AS alpha,
          spv.sharpe_20d        AS sharpe,
          spv.resolved_count,
          spv.total_appearances,
          spv.data_source,
          spv.last_computed
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id AND sm.source = spv.source
        ${where}
        ORDER BY NULLIF(spv.bayesian_score, 'NaN'::float8) DESC
        LIMIT ? OFFSET ?
      `, params);
    }),

  // Screener Confluence Universe: opt-in universe narrowing driven by screener membership,
  // NOT a replacement for unified_ranker.py's own full-universe scoring. unified_ranker
  // deliberately scores every symbol regardless of screener presence (screener-membership
  // selection bias is a real, previously-fought class of bug in this codebase -- restricting
  // the CORE ranker to only screener-appearing names would just trade survivorship bias for
  // screener-coverage bias). This procedure is a pure read-only filter/rank layer on top of
  // the canonical unified_recommendations output -- it narrows the universe for a caller that
  // explicitly wants a curated, multi-screener-confirmed shortlist (a CANSLIM/Minervini-style
  // "institutional confirmation" screen: N+ independent bullish screeners agreeing, zero
  // active bearish screeners), it never feeds back into scoring. See the 2026-08-04 screener
  // audit memory for why this is additive-only, and why minBullishScreeners defaults to 2 (the
  // same "at least 2 independent confirming screens" bar screener_signal_generator.py already
  // uses for its own signal-emission gate, MIN_BULL_SCREENERS).
  getScreenerConfluenceUniverse: publicProcedure
    .input(z.object({
      minBullishScreeners: z.number().min(1).max(20).default(2),
      excludeBearishSignals: z.boolean().default(true),
      minUnifiedScore: z.number().min(0).max(100).default(0),
      conviction: z.enum(['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM', 'C_LOW', 'D_MARGINAL']).default('ALL'),
      limit: z.number().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const latestRow = await dbGet<{ ts: string }>(
        'SELECT CAST(MAX(computed_at) AS TEXT) AS ts FROM unified_recommendations'
      );
      const latest = latestRow?.ts ?? null;
      if (!latest) {
        return { asOf: null, universeSize: 0, filteredCount: 0, stocks: [] };
      }

      const universeSizeRow = await dbGet<{ n: number }>(
        'SELECT COUNT(*) AS n FROM unified_recommendations WHERE CAST(computed_at AS TEXT) = ?',
        [latest]
      );

      const conditions = ['CAST(computed_at AS TEXT) = ?', 'bullish_screener_count >= ?', 'unified_score >= ?'];
      const params: (string | number)[] = [latest, input.minBullishScreeners, input.minUnifiedScore];
      if (input.excludeBearishSignals) {
        conditions.push('bearish_screener_count = 0');
      }
      if (input.conviction !== 'ALL') {
        conditions.push('conviction_level = ?');
        params.push(input.conviction);
      }
      params.push(input.limit);

      const stocks = await dbAll<any>(`
        SELECT symbol, unified_score, conviction_level, classification, timeframe, sector,
               bullish_screener_count, bearish_screener_count, screener_stock_score,
               screener_names_json, entry_zone_low, entry_zone_high, stop_loss,
               target_1, risk_reward, trade_reasoning
        FROM unified_recommendations
        WHERE ${conditions.join(' AND ')}
        ORDER BY NULLIF(unified_score, 'NaN'::float8) DESC
        LIMIT ?
      `, params);

      const stocksParsed = stocks.map((r: any) => {
        let screenerNames: any = null;
        try { screenerNames = r.screener_names_json ? JSON.parse(r.screener_names_json) : null; }
        catch { /* malformed JSON from an older row shape -- surface null, not a crash */ }
        return { ...r, screener_names_json: undefined, screeners: screenerNames };
      });

      return {
        asOf: latest,
        universeSize: universeSizeRow?.n ?? 0,
        filteredCount: stocksParsed.length,
        stocks: stocksParsed,
      };
    }),

  getScreenerDetail: publicProcedure
    .input(z.object({ screener_id: z.string() }))
    // NOTE: screener_id (scan_id) alone can still be ambiguous across providers (MC/ETnow
    // collide, see the 2026-08-04 screener_master memory) -- this procedure has no `source`
    // input to disambiguate, so dbGet below can return either provider's row when both exist.
    // The JOIN itself is now correct (sm always matches spv's own source), just not the input.
    .query(async ({ input }) => {
      const perf = await dbGet(`
        SELECT spv.*, sm.name, sm.inferred_category AS category, sm.subcategory,
               sm.inferred_sentiment AS sentiment, sm.inferred_timeframe AS timeframe,
               sm.classified_by
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id AND sm.source = spv.source
        WHERE spv.screener_id = ?
      `, [input.screener_id]);

      const recentAppearances = await dbAll(`
        SELECT symbol, appeared_date, exited_date,
               return_5d, return_10d, return_20d, return_60d, return_120d,
               nifty_ret_20d, outcome_20d
        FROM screener_appearances
        WHERE screener_id = ?
        ORDER BY appeared_date DESC
        LIMIT 30
      `, [input.screener_id]);

      const topStocks = await dbAll(`
        SELECT symbol, COUNT(*) AS appearances
        FROM screener_appearances
        WHERE screener_id = ?
        GROUP BY symbol
        ORDER BY appearances DESC
        LIMIT 15
      `, [input.screener_id]);

      return { perf, recentAppearances, topStocks };
    }),

  getScreenerCategoryStats: publicProcedure
    .input(z.object({
      horizon: z.enum(['5d', '10d', '20d', '60d', '120d']).default('20d'),
    }))
    .query(async ({ input }) => {
      const validHorizonCols: Record<string, string> = {
        '5d': 'wr_5d', '10d': 'wr_10d', '20d': 'wr_20d', '60d': 'wr_60d', '120d': 'wr_120d',
      };
      const wrCol = validHorizonCols[input.horizon] ?? 'wr_20d';

      return dbAll(`
        SELECT
          sm.inferred_category                                              AS category,
          sm.subcategory,
          COUNT(*)                                                          AS screener_count,
          AVG(spv.${wrCol})                                                 AS avg_win_rate,
          AVG(spv.alpha_20d)                                                AS avg_alpha,
          SUM(CASE WHEN spv.tier = 'A' THEN 1 ELSE 0 END)                  AS tier_a_count,
          SUM(CASE WHEN spv.tier IN ('A','B') THEN 1 ELSE 0 END)           AS tier_ab_count,
          MAX(spv.bayesian_score)                                           AS best_score
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id AND sm.source = spv.source
        WHERE sm.inferred_category IS NOT NULL
        GROUP BY sm.inferred_category, sm.subcategory
        ORDER BY avg_win_rate DESC
      `);
    }),

  getScreenerAppearanceHistory: publicProcedure
    .input(z.object({
      symbol:      z.string().optional(),
      screener_id: z.string().optional(),
      from_date:   z.string().optional(),
      limit:       z.number().min(1).max(500).default(100),
    }).refine(d => d.symbol || d.screener_id, { message: 'Provide symbol or screener_id' }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.symbol)      { conditions.push('sa.symbol = ?');       params.push(input.symbol); }
      if (input.screener_id) { conditions.push('sa.screener_id = ?');   params.push(input.screener_id); }
      if (input.from_date)   { conditions.push('sa.appeared_date >= ?'); params.push(input.from_date); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(input.limit);

      return dbAll(`
        SELECT
          sa.screener_id, sm.name AS screener_name, sa.source,
          sa.symbol, sa.appeared_date, sa.exited_date,
          sa.return_20d, sa.outcome_20d, sa.nifty_ret_20d,
          spv.tier AS screener_tier
        FROM screener_appearances sa
        -- screener_appearances.source is lowercase ('moneycontrol') while screener_master.source
        -- is not ('MoneyControl') -- a pre-existing casing mismatch between the two tables,
        -- unrelated to this fix; LOWER() bridges it rather than normalizing either table.
        JOIN screener_master sm ON sm.scan_id = sa.screener_id AND LOWER(sm.source) = sa.source
        LEFT JOIN screener_performance_v2 spv ON spv.screener_id = sa.screener_id AND LOWER(spv.source) = sa.source
        ${where}
        ORDER BY sa.appeared_date DESC
        LIMIT ?
      `, params);
    }),

  triggerScreenerPerformanceRecompute: adminProcedure
    .input(z.object({ force: z.boolean().optional() }))
    .mutation(async () => {
      try {
        const { screenerPerfQueue } = await import('../queues');
        if (!screenerPerfQueue) throw new Error('Queue not initialised');
        await screenerPerfQueue.add('screener-performance-manual', {}, { removeOnComplete: 3 });
        return { queued: true, message: 'Screener performance job queued' };
      } catch (e: any) {
        return { queued: false, message: `Queue unavailable: ${e.message}` };
      }
    }),

  createScreenerRun: adminProcedure
    .input(z.object({
      screenerId: z.string(),
      symbols: z.array(z.string()),
      triggeredBy: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const runId = `run_${input.screenerId}_${Date.now()}`;
      const records = input.symbols.map(s => ({ symbol: s }));
      await dbRun(`
        INSERT INTO screener_runs (run_id, screener_id, run_ts, records_json, symbol_count, triggered_by)
        VALUES (?, ?, datetime('now'), ?, ?, ?)
        ON CONFLICT(run_id) DO NOTHING
      `, [runId, input.screenerId, JSON.stringify(records), input.symbols.length, input.triggeredBy ?? 'manual']);
      return { runId, symbolCount: input.symbols.length };
    }),

  getScreenerRuns: publicProcedure
    .input(z.object({
      screenerId: z.string().optional(),
      limit: z.number().min(1).max(100).default(20),
    }))
    .query(async ({ input }) => {
      if (input.screenerId) {
        return dbAll(`
          SELECT run_id, screener_id, run_ts, symbol_count, triggered_by
          FROM screener_runs WHERE screener_id = ?
          ORDER BY run_ts DESC LIMIT ?
        `, [input.screenerId, input.limit]);
      }
      return dbAll(`
        SELECT run_id, screener_id, run_ts, symbol_count, triggered_by
        FROM screener_runs ORDER BY run_ts DESC LIMIT ?
      `, [input.limit]);
    }),

  getScreenerSectorRotation: publicProcedure
    .input(z.object({
      days: z.number().min(1).max(90).default(7),
      sector: z.string().optional(),
    }))
    .query(async ({ input }) => {
      // date('now', ? || ' days') never translated to Postgres -- sqlTranslate.ts's date('now',
      // ...) rule only matches a bare quoted-string modifier, not a parameter concatenation, so
      // this threw `function date(unknown, text) does not exist` on every call in production
      // (trpc-surface-review full sweep, 2026-08-14). Same JS-computed-cutoff fix already
      // applied to getScreenerSurfacingSignals in this file.
      const params: any[] = [];
      const cutoff = new Date(Date.now() - input.days * 24 * 3600_000).toISOString().slice(0, 10);
      let where = 'WHERE date >= ?';
      params.push(cutoff);
      if (input.sector) {
        where += ' AND sector = ?';
        params.push(input.sector);
      }
      return dbAll(`
        SELECT sector, date, bull_count, bear_count, net_score, stock_count,
               tier1_bull_count, breadth_score, momentum_change, top_stocks
        FROM screener_sector_rotation
        ${where}
        ORDER BY date DESC, net_score DESC
      `, params);
    }),

  getScreenerBasket: publicProcedure
    .input(z.object({
      topN: z.number().min(5).max(100).default(20),
      minMomentum: z.number().default(5.0),
    }))
    .query(async ({ input }) => {
      // Was a correlated `WHERE ts.date = (SELECT MAX(date) ... WHERE t2.symbol = ts.symbol)`
      // subquery -- the exact anti-pattern already fixed once in misc.router.ts (Finding #33,
      // full-stack audit 2026-07-30): it re-executes once per row of the FULL historical
      // technical_signals table (O(total rows)) instead of O(distinct symbols). Rewritten to
      // the same ROW_NUMBER() partition used at misc.router.ts's getTradeDecisionCockpitData.
      return dbAll(`
        SELECT symbol, screener_momentum_score, screener_bull_count, screener_bear_count,
               screener_tier1_count, screener_cat_breadth, screener_streak_days,
               screener_name_signal, screener_alpha_score, sector, company_name
        FROM (
          SELECT ts.symbol, ts.screener_momentum_score, ts.screener_bull_count,
                 ts.screener_bear_count, ts.screener_tier1_count, ts.screener_cat_breadth,
                 ts.screener_streak_days, ts.screener_name_signal, ts.screener_alpha_score,
                 ns.sector, ns.company_name,
                 ROW_NUMBER() OVER (PARTITION BY ts.symbol ORDER BY ts.date DESC) AS rn
          FROM technical_signals ts
          LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
        ) t
        WHERE rn = 1
          AND screener_momentum_score >= ?
          AND screener_bull_count > screener_bear_count
        ORDER BY NULLIF(screener_momentum_score, 'NaN'::float8) DESC
        LIMIT ?
      `, [input.minMomentum, input.topN]);
    }),

  getScreenerSurfacingSignals: publicProcedure
    .input(z.object({
      days: z.number().min(1).max(30).default(3),
      limit: z.number().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      // Cutoff computed in JS and bound as a parameter, not `NOW() - INTERVAL ...` -- this
      // codebase has repeatedly been bitten by Postgres-only date arithmetic that doesn't
      // survive sqlTranslate.ts's translation to the SQLite dev fallback (same pattern already
      // proven safe at monitor.router.ts's news-sentiment stat).
      const cutoff = new Date(Date.now() - input.days * 24 * 3600_000).toISOString();
      return dbAll(`
        SELECT symbol, signal_date, signal_type, confidence_score,
               entry_price, target_price, stop_loss,
               screener_momentum_score, screener_tier1_count, screener_cat_breadth,
               reasoning
        FROM unified_signals
        WHERE signal_source = 'SCREENER_SURFACING'
          AND signal_date >= ?
        ORDER BY signal_date DESC, NULLIF(screener_momentum_score, 'NaN'::float8) DESC
        LIMIT ?
      `, [cutoff, input.limit]);
    }),
    
    // Ids here must be real quant_scores columns (see SCREENER_CRITERIA_COLUMNS below) --
    // runScreener whitelists against that same set, so an id added here without a backing
    // column is rejected at request time rather than silently matching nothing.
    getScreenerCriteria: publicProcedure
    .query(async () => {
      const criteria = {
        'Fundamental': [
          { id: 'trailing_pe', name: 'Trailing P/E', type: 'number' },
          { id: 'forward_pe', name: 'Forward P/E', type: 'number' },
          { id: 'debt_to_equity', name: 'Debt to Equity', type: 'number' },
          { id: 'return_on_equity', name: 'Return on Equity', type: 'number' },
        ],
        'Technical': [
          { id: 'return_1m', name: '1-Month Return', type: 'number' },
          { id: 'return_3m', name: '3-Month Return', type: 'number' },
          { id: 'above_sma200', name: 'Above 200-Day SMA', type: 'boolean' },
        ],
        'Quantitative': [
            { id: 'momentum_score', name: 'Momentum Score', type: 'number' },
            { id: 'valuation_score', name: 'Value Score', type: 'number' },
            { id: 'rank_quality', name: 'Quality Score', type: 'number' },
            { id: 'rank_composite', name: 'Overall Score', type: 'number' },
        ]
      };
      return criteria;
    }),

  runScreener: expensiveProcedure
    .input(z.array(z.object({
      id: z.enum(SCREENER_CRITERIA_COLUMNS),
      operator: z.enum(['gt', 'lt', 'eq', 'gte', 'lte']),
      value: z.any(),
    })))
    .mutation(async ({ input }) => {
      let query = 'SELECT * FROM quant_scores WHERE ';
      const params: any[] = [];

      input.forEach((criterion, index) => {
        if (index > 0) {
          query += ' AND ';
        }

        const operatorMap = {
          'gt': '>',
          'lt': '<',
          'eq': '=',
          'gte': '>=',
          'lte': '<=',
        };

        // criterion.id is zod-validated against the SCREENER_CRITERIA_COLUMNS whitelist above,
        // so this interpolation can't carry client-controlled SQL.
        query += `${criterion.id} ${operatorMap[criterion.operator]} ?`;
        params.push(criterion.value);
      });

      const results = await dbAll<any>(query, params);
      return results;
    }),
});
