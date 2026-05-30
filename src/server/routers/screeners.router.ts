import { z } from "zod";
import db from "../db";
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
import { router, publicProcedure } from "../trpc";
import { SCANNER_CATALOG } from "../config/scannerCatalog";

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
        const { timeframes, minVolume = 0 } = input.params;
        const allStocks = await getOrRefreshAllStocks();
        const parseVol = (v: string): number => {
          if (!v) return 0;
          if (v.endsWith('M')) return parseFloat(v) * 1_000_000;
          if (v.endsWith('K')) return parseFloat(v) * 1_000;
          return parseFloat(v) || 0;
        };
        const selected = allStocks
          .filter((s: any) => s.changePct > 0 && parseVol(s.volume) > minVolume && s.price > 0)
          .sort((a: any, b: any) => b.changePct - a.changePct)
          .slice(0, 50)
          .map((s: any) => ({
            symbol: s.symbol, name: s.name, ltp: s.price,
            perChg: s.changePct.toFixed(2), volume: s.volume,
            mktCap: '—', sector: s.sector || '—',
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
        const stocks = db.prepare(`
          SELECT ss.symbol as stockId, ss.stock_name as name, ss.symbol
          FROM moneycontrol_screener_stocks ss WHERE ss.scan_id = ?
        `).all(scanId) as any[];
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
        const etScreener = db.prepare('SELECT query_condition FROM etnow_screeners WHERE screener_id = ?')
          .get(screenerId) as { query_condition: string } | undefined;
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

  configTrendlyneFetchInterval: publicProcedure
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
      return [...findScreenersByStock(input.stockId), ...findMcScreenersByStock(input.stockId)];
    }),

  refreshTrendlyneScreenersDB: publicProcedure
    .mutation(async () => {
      const screenerNames = await fetchAllTrendlyneScreenerNames(true);
      return { success: true, message: `Refreshed screener database with ${screenerNames.size} screeners`, count: screenerNames.size };
    }),

  recategorizeTrendlyneScreeners: publicProcedure
    .mutation(async () => recategorizeAllScreeners()),

  // ── Screener Intelligence (Sub-project A) ─────────────────────────────────

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
    .query(({ input }) => {
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

      return db.prepare(`
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
        JOIN screener_master sm ON sm.scan_id = spv.screener_id
        ${where}
        ORDER BY spv.bayesian_score DESC
        LIMIT ? OFFSET ?
      `).all(...params);
    }),

  getScreenerDetail: publicProcedure
    .input(z.object({ screener_id: z.string() }))
    .query(({ input }) => {
      const perf = db.prepare(`
        SELECT spv.*, sm.name, sm.inferred_category AS category, sm.subcategory,
               sm.inferred_sentiment AS sentiment, sm.inferred_timeframe AS timeframe,
               sm.classified_by
        FROM screener_performance_v2 spv
        JOIN screener_master sm ON sm.scan_id = spv.screener_id
        WHERE spv.screener_id = ?
      `).get(input.screener_id);

      const recentAppearances = db.prepare(`
        SELECT symbol, appeared_date, exited_date,
               return_5d, return_10d, return_20d, return_60d, return_120d,
               nifty_ret_20d, outcome_20d
        FROM screener_appearances
        WHERE screener_id = ?
        ORDER BY appeared_date DESC
        LIMIT 30
      `).all(input.screener_id);

      const topStocks = db.prepare(`
        SELECT symbol, COUNT(*) AS appearances
        FROM screener_appearances
        WHERE screener_id = ?
        GROUP BY symbol
        ORDER BY appearances DESC
        LIMIT 15
      `).all(input.screener_id);

      return { perf, recentAppearances, topStocks };
    }),

  getScreenerCategoryStats: publicProcedure
    .input(z.object({
      horizon: z.enum(['5d', '10d', '20d', '60d', '120d']).default('20d'),
    }))
    .query(({ input }) => {
      const validHorizonCols: Record<string, string> = {
        '5d': 'wr_5d', '10d': 'wr_10d', '20d': 'wr_20d', '60d': 'wr_60d', '120d': 'wr_120d',
      };
      const wrCol = validHorizonCols[input.horizon] ?? 'wr_20d';

      return db.prepare(`
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
        JOIN screener_master sm ON sm.scan_id = spv.screener_id
        WHERE sm.inferred_category IS NOT NULL
        GROUP BY sm.inferred_category, sm.subcategory
        ORDER BY avg_win_rate DESC
      `).all();
    }),

  getScreenerAppearanceHistory: publicProcedure
    .input(z.object({
      symbol:      z.string().optional(),
      screener_id: z.string().optional(),
      from_date:   z.string().optional(),
      limit:       z.number().min(1).max(500).default(100),
    }).refine(d => d.symbol || d.screener_id, { message: 'Provide symbol or screener_id' }))
    .query(({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.symbol)      { conditions.push('sa.symbol = ?');       params.push(input.symbol); }
      if (input.screener_id) { conditions.push('sa.screener_id = ?');   params.push(input.screener_id); }
      if (input.from_date)   { conditions.push('sa.appeared_date >= ?'); params.push(input.from_date); }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      params.push(input.limit);

      return db.prepare(`
        SELECT
          sa.screener_id, sm.name AS screener_name, sa.source,
          sa.symbol, sa.appeared_date, sa.exited_date,
          sa.return_20d, sa.outcome_20d, sa.nifty_ret_20d,
          spv.tier AS screener_tier
        FROM screener_appearances sa
        JOIN screener_master sm ON sm.scan_id = sa.screener_id
        LEFT JOIN screener_performance_v2 spv ON spv.screener_id = sa.screener_id
        ${where}
        ORDER BY sa.appeared_date DESC
        LIMIT ?
      `).all(...params);
    }),

  triggerScreenerPerformanceRecompute: publicProcedure
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
});
