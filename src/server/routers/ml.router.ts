import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { dbGet, dbAll, dbRun } from "../dbAsync";
import { alphaQuant } from "../alphaQuantClient";
import { enqueueWalkForwardOptimize, getWalkForwardOptimizeJobStatus } from "../queues";
import { router, publicProcedure, adminProcedure } from "../trpc";
import { fetchWithCache } from "../cacheService";

type RocResult = {
  regime: string; n: number; positives: number; negatives: number;
  baseRate: number; auc: number; roc: { fpr: number; tpr: number }[];
};

/**
 * Rank-based AUC (== sklearn roc_auc_score, tie-aware) + ROC curve points for one group of
 * (score, label) pairs. Read-only diagnostics — deliberately NOT a call into ml_calibration.py
 * (that recalibrates and writes). Returns null for groups too small or single-class to score.
 */
function computeRoc(regime: string, pts: { p: number; y: number }[], minN: number, maxPoints: number): RocResult | null {
  const n = pts.length;
  const positives = pts.reduce((s, d) => s + d.y, 0);
  const negatives = n - positives;
  if (n < minN || positives === 0 || negatives === 0) return null;

  // AUC via Mann-Whitney U: (sum of avg-ranks of positives - nP*(nP+1)/2) / (nP*nN)
  const asc = [...pts].sort((a, b) => a.p - b.p);
  let i = 0, rankSum = 0;
  while (i < n) {
    let j = i;
    while (j < n && asc[j].p === asc[i].p) j++;
    const avgRank = (i + 1 + j) / 2;               // average of 1-indexed ranks [i+1..j]
    for (let k = i; k < j; k++) if (asc[k].y === 1) rankSum += avgRank;
    i = j;
  }
  const auc = (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);

  // ROC curve: threshold sweep from high score to low, grouping tied scores into one step.
  const desc = [...pts].sort((a, b) => b.p - a.p);
  const roc: { fpr: number; tpr: number }[] = [{ fpr: 0, tpr: 0 }];
  let tp = 0, fp = 0, k = 0;
  while (k < n) {
    let m = k;
    while (m < n && desc[m].p === desc[k].p) m++;
    for (let t = k; t < m; t++) { if (desc[t].y === 1) tp++; else fp++; }
    roc.push({ fpr: fp / negatives, tpr: tp / positives });
    k = m;
  }
  const curve = roc.length > maxPoints
    ? Array.from({ length: maxPoints }, (_, idx) => roc[Math.round((idx * (roc.length - 1)) / (maxPoints - 1))])
    : roc;

  return {
    regime, n, positives, negatives,
    baseRate: Math.round((positives / n) * 1000) / 1000,
    auc: Math.round(auc * 1000) / 1000,
    roc: curve,
  };
}

export const mlRouter = router({
  getFiiDiiFlow: publicProcedure
    // fii_dii_flow was deep-backfilled to 2016-01-01 (see fii_dii_history_fetcher.py) --
    // 4000 comfortably covers the full history (~2,600 trading days) for long-range trend views.
    .input(z.object({ days: z.number().min(1).max(4000).default(30) }).optional())
    .query(async ({ input }) => {
      return dbAll(`
        SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net,
               fii_net_all_segments, mf_total, source, fetched_at
        FROM fii_dii_flow ORDER BY date DESC LIMIT ?
      `, [input?.days ?? 30]);
    }),

  getStrategyPerformance: publicProcedure
    .input(z.object({
      horizonDays: z.union([z.literal(5), z.literal(15)]).default(15),
      segment:     z.enum(['signal_type', 'sector', 'nifty_regime', 'score_bucket', 'overall']).optional(),
      minSignals:  z.number().min(1).default(5),
    }).optional())
    .query(async ({ input }) => {
      const horizon = input?.horizonDays ?? 15;
      const seg     = input?.segment;
      const min     = input?.minSignals ?? 5;
      const where   = seg ? `AND segment = '${seg}'` : '';
      return dbAll(`
        SELECT perf_key, strategy_name, segment, segment_value, horizon_days,
               market_regime, total_signals, win_rate, avg_return_pct,
               profit_factor, sharpe_ratio, max_drawdown_pct, alpha_vs_nifty,
               signal_decay_halflife_days, false_positive_rate, last_computed
        FROM strategy_performance
        WHERE horizon_days = ? AND total_signals >= ? ${where}
        ORDER BY win_rate DESC
      `, [horizon, min]);
    }),

  getPerformanceDashboard: publicProcedure
    .query(async () => {
      return {
        // Pin to the canonical 15-day horizon (the default used across getStrategyPerformance /
        // getSignalQualityReport). A bare "most recent" flips the headline win-rate/Sharpe between
        // the 5d and 15d rows depending on which performance_tracker horizon ran last.
        overall: await dbGet(`
          SELECT win_rate, avg_return_pct, sharpe_ratio, profit_factor, max_drawdown_pct,
                 alpha_vs_nifty, total_signals, horizon_days, last_computed
          FROM strategy_performance WHERE segment = 'overall'
          ORDER BY (horizon_days = 15) DESC, last_computed DESC LIMIT 1
        `),
        topSignals: await dbAll(`
          SELECT strategy_name, win_rate, avg_return_pct, sharpe_ratio, total_signals
          FROM strategy_performance WHERE segment = 'signal_type' AND total_signals >= 10
          ORDER BY win_rate DESC LIMIT 5
        `),
        byRegime: await dbAll(`
          SELECT market_regime, AVG(win_rate) AS avg_win_rate, SUM(total_signals) AS total_signals
          FROM strategy_performance WHERE segment = 'signal_type' AND market_regime != 'ALL'
          GROUP BY market_regime ORDER BY avg_win_rate DESC
        `),
        latestModel: await dbAll(`
          SELECT model_name, model_type, cv_roc_auc, training_samples, trained_at
          FROM model_registry WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 3
        `),
        recentBacktest: await dbAll(`
          SELECT run_name, win_rate, total_return_pct, cagr_pct, sharpe_ratio,
                 max_drawdown_pct, alpha_pct, run_at
          FROM backtesting_runs ORDER BY run_at DESC LIMIT 5
        `),
        weightHistory: await dbAll(`
          SELECT optimization_method, baseline_win_rate, optimized_win_rate,
                 improvement_pct, snapshot_at
          FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT 3
        `),
      };
    }),

  getMLModelRegistry: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }).optional())
    .query(async ({ input }) => {
      return dbAll(`
        SELECT id, model_name, model_version, model_type, trained_at,
               training_samples, cv_roc_auc, cv_accuracy, precision_score,
               recall_score, f1_score, feature_count, is_active, horizon_days
        FROM model_registry ORDER BY trained_at DESC LIMIT ?
      `, [input?.limit ?? 20]);
    }),

  getFeatureImportance: publicProcedure
    .input(z.object({ modelName: z.string().default('ensemble'), topN: z.number().default(20) }).optional())
    .query(async ({ input }) => {
      return dbAll(`
        SELECT fil.feature_name, fil.importance, fil.rank_position, fil.computed_at, mr.model_type
        FROM feature_importance_log fil
        LEFT JOIN model_registry mr ON mr.id = fil.model_id
        WHERE fil.model_name = ?
        ORDER BY fil.computed_at DESC, fil.rank_position ASC
        LIMIT ?
      `, [input?.modelName ?? 'ensemble', input?.topN ?? 20]);
    }),

  getScreenerWeightHistory: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(30).default(10) }).optional())
    .query(async ({ input }) => {
      return dbAll(`
        SELECT id, snapshot_at, optimization_method, category_weights_json,
               source_weights_json, baseline_win_rate, optimized_win_rate,
               improvement_pct, training_samples
        FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT ?
      `, [input?.limit ?? 10]);
    }),

  getSignalQualityReport: publicProcedure
    .input(z.object({ horizonDays: z.union([z.literal(5), z.literal(15)]).default(15) }).optional())
    .query(async ({ input }) => {
      const horizon = input?.horizonDays ?? 15;
      const [bySignalType, recommendationStats] = await Promise.all([
        dbAll(`
          SELECT strategy_name AS signal_type, win_rate, avg_return_pct, profit_factor,
                 sharpe_ratio, total_signals, false_positive_rate, max_drawdown_pct,
                 alpha_vs_nifty, signal_decay_halflife_days, market_regime
          FROM strategy_performance
          WHERE segment = 'signal_type' AND horizon_days = ?
          ORDER BY win_rate DESC
        `, [horizon]),
        dbGet(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
                 SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
                 AVG(actual_return_pct) AS avg_return,
                 MAX(actual_return_pct) AS best_return,
                 MIN(actual_return_pct) AS worst_return
          FROM recommendation_log WHERE outcome IS NOT NULL
        `),
      ]);
      return { bySignalType, recommendationStats };
    }),

  // Live emitted-signal hit rates straight from unified_signal_outcomes, broken down by
  // source × regime × horizon. Surfaces the emission-quality problem (e.g. a high NEUTRAL /
  // low decisive rate) that precomputed strategy_performance rollups hide. This is the
  // standing observability view for "does the deployed signal actually resolve, and win?".
  getLiveHitRates: publicProcedure
    .input(z.object({
      days:       z.number().min(7).max(1825).default(180),
      minSignals: z.number().min(1).max(100).default(10),
    }).optional())
    .query(async ({ input }) => {
      const days = input?.days ?? 180;
      const minSignals = input?.minSignals ?? 10;
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

      // Shared aggregate expressions. win_rate is among DECIDED signals (win/loss/stop);
      // decisive_rate = fraction that resolved to any directional outcome (the key emission
      // metric); neutral_rate = fraction that expired flat.
      const agg = `
        COUNT(*) AS total,
        SUM(CASE WHEN uso.outcome='WIN'       THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN uso.outcome='LOSS'      THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN uso.outcome='NEUTRAL'   THEN 1 ELSE 0 END) AS neutrals,
        SUM(CASE WHEN uso.outcome='STOP_LOSS' THEN 1 ELSE 0 END) AS stops,
        ROUND(100.0 * SUM(CASE WHEN uso.outcome='WIN' THEN 1 ELSE 0 END)
              / NULLIF(SUM(CASE WHEN uso.outcome IN ('WIN','LOSS','STOP_LOSS') THEN 1 ELSE 0 END), 0), 1) AS win_rate,
        ROUND(100.0 * SUM(CASE WHEN uso.outcome != 'NEUTRAL' THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0), 1) AS decisive_rate,
        ROUND(100.0 * SUM(CASE WHEN uso.outcome='NEUTRAL' THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0), 1) AS neutral_rate,
        ROUND(AVG(uso.return_pct), 2) AS avg_return`;
      const base = `
        FROM unified_signal_outcomes uso
        -- signal_date is stored in mixed formats ('YYYY-MM-DD' and 'YYYY-MM-DD HH:MM:SS+00');
        -- normalise to the 10-char date so the regime join matches either way.
        LEFT JOIN market_regimes mr ON mr.date = substr(uso.signal_date, 1, 10)
        WHERE uso.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND uso.return_pct IS NOT NULL
          AND uso.signal_date >= ?`;

      const [overall, bySource, byRegime, byHorizon, grid] = await Promise.all([
        dbGet(`SELECT ${agg} ${base}`, [cutoff]),
        dbAll(`SELECT uso.signal_source, ${agg} ${base} GROUP BY uso.signal_source ORDER BY total DESC`, [cutoff]),
        dbAll(`SELECT COALESCE(mr.regime,'UNKNOWN') AS regime, ${agg} ${base} GROUP BY COALESCE(mr.regime,'UNKNOWN') ORDER BY total DESC`, [cutoff]),
        dbAll(`SELECT uso.horizon_days, ${agg} ${base} GROUP BY uso.horizon_days ORDER BY uso.horizon_days`, [cutoff]),
        dbAll(
          `SELECT uso.signal_source, COALESCE(mr.regime,'UNKNOWN') AS regime, uso.horizon_days, ${agg} ${base}
           GROUP BY uso.signal_source, COALESCE(mr.regime,'UNKNOWN'), uso.horizon_days
           HAVING COUNT(*) >= ? ORDER BY total DESC`, [cutoff, minSignals]),
      ]);

      return { asOf: cutoff, windowDays: days, overall, bySource, byRegime, byHorizon, grid };
    }),

  getSignalReportCard: publicProcedure
    .input(z.object({
      horizonDays: z.union([z.literal(5), z.literal(15)]).default(15),
      activeLimit: z.number().min(1).max(200).default(50),
      recentBacktests: z.number().min(1).max(20).default(10),
    }).optional())
    .query(async ({ input }) => {
      const horizon = input?.horizonDays ?? 15;
      const activeLimit = input?.activeLimit ?? 50;
      const recentBacktests = input?.recentBacktests ?? 10;

      const sourceSummary = await dbAll<any>(`
        SELECT 'TECHNICAL' AS signal_source,
               COUNT(*) AS total_signals,
               SUM(CASE WHEN date >= date('now', '-7 days') THEN 1 ELSE 0 END) AS active_signals,
               SUM(CASE WHEN date < date('now', '-7 days') THEN 1 ELSE 0 END) AS completed_signals,
               AVG(signal_score) AS avg_confidence_score,
               AVG(rsi) AS avg_technical_score,
               AVG(adx) AS avg_quant_score,
               AVG(cmp) AS avg_entry_price,
               AVG(julianday('now') - julianday(date)) AS avg_age_days
        FROM technical_signals
        WHERE date >= date('now', '-30 days')
        GROUP BY signal_source
        UNION ALL
        SELECT 'CONFLUENCE' AS signal_source,
               COUNT(*) AS total_signals,
               SUM(CASE WHEN date(computed_at)::text >= date('now', '-7 days') THEN 1 ELSE 0 END) AS active_signals,
               SUM(CASE WHEN date(computed_at)::text < date('now', '-7 days') THEN 1 ELSE 0 END) AS completed_signals,
               AVG(confluence_score) AS avg_confidence_score,
               NULL AS avg_technical_score,
               NULL AS avg_quant_score,
               NULL AS avg_entry_price,
               AVG(julianday('now') - julianday(computed_at)) AS avg_age_days
        FROM confluence_signals
        -- Was  WHERE date(computed_at)::text >= date('now', '-30 days')  -- wrapping the raw
        -- partition column (confluence_signals is a TimescaleDB hypertable chunked on
        -- computed_at) in date()::text defeats both a plain btree index AND Timescale's own
        -- chunk-exclusion pruning, forcing a scan across every chunk back to the table's full
        -- history instead of just the last ~5 (30d / 7d chunks). Casting the literal side
        -- instead keeps the column bare and sargable; ::timestamptz survives PG translation
        -- and is stripped (no-op) on the SQLite fallback path via stripPgCasts.
        WHERE computed_at >= (date('now', '-30 days'))::timestamptz
        GROUP BY signal_source
      `);

      const outcomeSummary = await dbAll<any>(`
        SELECT 'TECHNICAL' AS signal_source,
               15 AS horizon_days,
               COUNT(*) AS total_outcomes,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS win_count,
               SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS loss_count,
               SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutral_count,
               AVG(return_pct) AS avg_return_pct,
               AVG(max_return_pct) AS avg_max_return_pct,
               NULL AS avg_min_return_pct
        FROM signal_outcomes
        WHERE outcome IS NOT NULL AND signal_source = 'technical'
        UNION ALL
        SELECT 'RECOMMENDATION' AS signal_source,
               15 AS horizon_days,
               COUNT(*) AS total_outcomes,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS win_count,
               SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS loss_count,
               SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutral_count,
               AVG(actual_return_pct) AS avg_return_pct,
               NULL AS avg_max_return_pct,
               NULL AS avg_min_return_pct
        FROM recommendation_log
        WHERE outcome IS NOT NULL
        ORDER BY signal_source, win_count DESC
      `);

      // Was `WHERE (symbol, date) IN (SELECT symbol, MAX(date) FROM stock_ohlcv GROUP BY
      // symbol)` -- a full GROUP BY aggregation over the entire stock_ohlcv hypertable to
      // build the row-value IN list, re-scanning the table a second time to match it. Same
      // ROW_NUMBER() rewrite used at scoring.router.ts's getStrategyPicks.
      const activeSignalGrowth = await dbAll<any>(`
        WITH latest_price AS (
          SELECT symbol, close FROM (
            SELECT symbol, close,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
            FROM stock_ohlcv
          ) t WHERE rn = 1
        )
        SELECT ts.id,
               ts.symbol,
               ts.date AS signal_date,
               'TECHNICAL' AS signal_source,
               'BUY' AS signal_type,
               ts.cmp AS entry_price,
               ts.signal_score AS confidence_score,
               'ACTIVE' AS status,
               ts.date AS signal_generated_at,
               lp.close AS latest_price,
               ROUND(COALESCE(100.0 * (lp.close - ts.cmp) / NULLIF(ts.cmp, 0), 0.0), 4) AS growth_pct
        FROM technical_signals ts
        LEFT JOIN latest_price lp ON lp.symbol = ts.symbol
        WHERE ts.date >= date('now', '-30 days')
          AND ts.signal_score >= 5
        ORDER BY ts.date DESC
        LIMIT ?
      `, [activeLimit]);

      const recommendationSummary = await dbGet<any>(`
        SELECT COUNT(*) AS total_recommendations,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS win_count,
               SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS loss_count,
               SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutral_count,
               AVG(actual_return_pct) AS avg_actual_return_pct,
               MAX(actual_return_pct) AS best_actual_return_pct,
               MIN(actual_return_pct) AS worst_actual_return_pct
        FROM recommendation_log
        WHERE actual_return_pct IS NOT NULL
      `);

      const recommendationSourceBreakdown = await dbAll<any>(`
        SELECT source,
               COUNT(*) AS total_recs,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS win_count,
               AVG(actual_return_pct) AS avg_actual_return_pct,
               AVG(confidence_score) AS avg_confidence_score
        FROM recommendation_log
        GROUP BY source
        ORDER BY total_recs DESC
      `);

      const recentBacktestResults = await dbAll<any>(`
        SELECT run_name, start_date, end_date, win_rate, total_return_pct,
               cagr_pct, sharpe_ratio, max_drawdown_pct, alpha_pct, profit_factor, run_at
        FROM backtesting_runs
        ORDER BY run_at DESC
        LIMIT ?
      `, [recentBacktests]);

      const strategyPerformance = await dbAll<any>(`
        SELECT strategy_name, segment, segment_value, win_rate, avg_return_pct,
               profit_factor, sharpe_ratio, max_drawdown_pct, alpha_vs_nifty,
               total_signals, last_computed
        FROM strategy_performance
        WHERE segment = 'signal_type' AND horizon_days = ?
        ORDER BY win_rate DESC
        LIMIT 20
      `, [horizon]);

      return {
        sourceSummary,
        outcomeSummary,
        activeSignalGrowth,
        recommendationSummary,
        recommendationSourceBreakdown,
        recentBacktestResults,
        strategyPerformance,
      };
    }),

  runFullBacktest: adminProcedure
    .input(z.object({
      start:          z.string().default('2023-01-01'),
      end:            z.string().optional(),
      horizonDays:    z.number().min(5).max(30).default(15),
      minScore:       z.number().min(1).max(10).default(3),
      maxPositions:   z.number().min(5).max(50).default(20),
      initialCapital: z.number().min(100000).default(1000000),
      runName:        z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const data = await alphaQuant.backtest({
          start: input.start,
          end:   input.end ?? new Date().toISOString().split('T')[0],
          horizon:   input.horizonDays,
          min_score: input.minScore,
          max_pos:   input.maxPositions,
          capital:   input.initialCapital,
          name:      input.runName ?? '',
        });
        return { run_id: data.run_id, message: 'Backtest complete' };
      } catch (err: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
    }),

  runWalkForwardOptimization: adminProcedure
    .input(z.object({
      start:       z.string().default('2020-01-01'),
      end:         z.string().optional(),
      mode:        z.enum(['rolling', 'anchored']).default('rolling'),
      nFolds:      z.number().min(2).max(12).default(4),
      isDays:      z.number().min(90).max(1500).default(365),
      oosDays:     z.number().min(30).max(365).default(90),
      stepDays:    z.number().min(30).max(365).default(90),
      optimize:    z.boolean().default(true),
      objective:   z.enum(['sharpe', 'sortino']).default('sharpe'),
      minScore:    z.number().min(1).max(10).default(3),
      horizonDays: z.number().min(5).max(30).default(15),
      maxPositions:   z.number().min(5).max(50).default(20),
      initialCapital: z.number().min(100000).default(1000000),
      runName:        z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const { jobId } = await enqueueWalkForwardOptimize({
          start: input.start,
          end:   input.end ?? new Date().toISOString().split('T')[0],
          mode:  input.mode,
          n_folds: input.nFolds,
          is_days: input.isDays,
          oos_days: input.oosDays,
          step_days: input.stepDays,
          optimize: input.optimize,
          objective: input.objective,
          min_score: input.minScore,
          horizon:   input.horizonDays,
          max_pos:   input.maxPositions,
          capital:   input.initialCapital,
          name:      input.runName ?? '',
        });
        return { jobId, message: 'Walk-forward optimization queued' };
      } catch (err: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
    }),

  getWalkForwardStatus: publicProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ input }) => {
      try {
        return await getWalkForwardOptimizeJobStatus(input.jobId);
      } catch (err: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
    }),

  optimizeScreenerWeights: adminProcedure
    .input(z.object({
      horizonDays: z.union([z.literal(5), z.literal(15)]).default(15),
      iterations:  z.number().min(50).max(1000).default(300),
      apply:       z.boolean().default(true),
    }).optional())
    .mutation(async ({ input }) => {
      try {
        const data = await alphaQuant.optimize({
          horizon_days: input?.horizonDays ?? 15,
          iterations:   input?.iterations ?? 300,
          apply:        input?.apply ?? true,
        });
        return { message: 'Optimization completed', improvement: data.improvement_pct };
      } catch (err: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
    }),

  saveBacktestStrategy: publicProcedure
    .input(z.object({
      name:      z.string(),
      symbol:    z.string(),
      timeframe: z.string(),
      params: z.object({
        rsiUpper: z.number(),
        rsiLower: z.number(),
        emaShort: z.number(),
        emaLong:  z.number(),
      }),
    }))
    .mutation(async ({ input }) => {
      await dbRun('INSERT INTO backtest_strategies (name, symbol, timeframe, params) VALUES (?, ?, ?, ?)',
        [input.name, input.symbol, input.timeframe, JSON.stringify(input.params)]);
      return { success: true };
    }),

  getBacktestStrategies: publicProcedure
    .query(async () => {
      return (await dbAll<any>('SELECT * FROM backtest_strategies ORDER BY "createdAt" DESC'))
        .map(r => ({ ...r, params: JSON.parse(r.params) }));
    }),

  // Pure read + in-memory aggregation over already-computed signal_outcomes for one symbol --
  // no writes, no expensive job trigger, so this stays public like its sibling saveBacktestStrategy
  // (it was previously adminProcedure, which silently 401'd the public Backtest tab for every
  // non-admin user -- an oversight from the 2026-07-23 mass admin-gating pass, not intentional).
  runBacktest: publicProcedure
    .input(z.object({
      symbol:   z.string(),
      strategy: z.string(),
      period:   z.string(),
      params: z.object({
        rsiUpper: z.number().optional(),
        rsiLower: z.number().optional(),
        emaShort: z.number().optional(),
        emaLong:  z.number().optional(),
      }).optional(),
    }))
    .mutation(async ({ input }) => {
      const rsiUpper = input.params?.rsiUpper ?? 70;
      const rsiLower = input.params?.rsiLower ?? 30;

      const outcomes = await dbAll<any>(`
        SELECT so.return_pct, so.outcome, so.entry_price, so.exit_price,
               so.signal_date, ts.rsi
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts ON so.symbol = ts.symbol AND so.signal_date = ts.date
        WHERE so.symbol = ?
          AND so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
          AND so.signal_source = 'technical'
        ORDER BY so.signal_date ASC
      `, [input.symbol]);

      if (!outcomes.length) return null;

      const filtered = outcomes.filter((r: any) => {
        if (r.rsi == null) return true;
        return r.rsi >= rsiLower && r.rsi <= rsiUpper;
      });

      if (!filtered.length) return null;

      const wins   = filtered.filter((r: any) => r.outcome === 'WIN').length;
      const losses = filtered.filter((r: any) => r.outcome === 'LOSS').length;
      const winRate = filtered.length > 0 ? wins / filtered.length : 0;

      const grossProfit = filtered.filter((r: any) => r.return_pct > 0).reduce((s: number, r: any) => s + r.return_pct, 0);
      const grossLoss   = Math.abs(filtered.filter((r: any) => r.return_pct < 0).reduce((s: number, r: any) => s + r.return_pct, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

      let equity = 100;
      let peak = 100;
      let maxDrawdown = 0;
      const equityCurve = filtered.map((r: any) => {
        equity *= (1 + (r.return_pct ?? 0) / 100);
        peak = Math.max(peak, equity);
        const drawdown = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
        maxDrawdown = Math.min(maxDrawdown, drawdown);
        return { date: r.signal_date, equity: Math.round(equity * 100) / 100, drawdown: Math.round(drawdown * 100) / 100 };
      });

      const returns = filtered.map((r: any) => r.return_pct ?? 0);
      const avgReturn = returns.reduce((s: number, v: number) => s + v, 0) / returns.length;
      const variance  = returns.reduce((s: number, v: number) => s + (v - avgReturn) ** 2, 0) / returns.length;
      const sharpe    = variance > 0 ? avgReturn / Math.sqrt(variance) : 0;
      const totalReturn = equity - 100;

      return {
        symbol:       input.symbol,
        totalTrades:  filtered.length,
        wins,
        losses,
        winRate:      Math.round(winRate * 10000) / 100,
        profitFactor: Math.round(profitFactor * 100) / 100,
        avgReturn:    Math.round(avgReturn * 100) / 100,
        totalReturn:  Math.round(totalReturn * 100) / 100,
        maxDrawdown:  Math.round(maxDrawdown * 100) / 100,
        sharpe:       Math.round(sharpe * 100) / 100,
        equityCurve,
      };
    }),

  // Honest deployment diagnostics: the live win_probability's ability to rank realized
  // WIN vs LOSS, per market regime. Replicates ml_calibration.per_regime_auc's exact join so
  // the AUC matches (BULL/SIDEWAYS ~0.50 = no live edge, BEAR ~0.62). Surfaces the gap between
  // the model's flattering training-CV AUC (model_registry.cv_roc_auc) and what actually holds
  // in deployment — the panel exists to keep that gap visible, not to hide it.
  getModelRocDiagnostics: publicProcedure
    .input(z.object({
      minSamples: z.number().min(20).max(2000).default(50),
      maxPoints:  z.number().min(20).max(500).default(120),
      // signal_outcomes has no upper bound on this query's WHERE clause and grows daily
      // (237,816 rows and climbing per the 2026-07-28 audit) -- this AUC/ROC computation also
      // runs synchronously in the request handler (Mann-Whitney rank sort over the whole
      // result set), so an unbounded query means both I/O and CPU cost grow forever. A rolling
      // window is enough for a regime-level AUC read and caps both.
      days: z.number().min(30).max(1825).default(365),
    }).optional())
    .query(async ({ input }) => {
      const minN = input?.minSamples ?? 50;
      const maxPoints = input?.maxPoints ?? 120;
      const days = input?.days ?? 365;
      const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

      // Same underlying data (signal_outcomes/technical_signals/model_registry) only changes on
      // batch-job cadence, not per request -- this whole read-only diagnostics computation was
      // re-run from scratch (including the synchronous rank-sort AUC math) on every single call.
      return fetchWithCache(`ml:roc-diagnostics:${minN}:${maxPoints}:${days}`, async () => {
      const rows = await dbAll(`
        SELECT ts.nifty_regime AS regime, ts.win_probability AS prob,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND ts.date = so.signal_date
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
          AND so.signal_date >= ? AND so.signal_source = 'technical'
      `, [cutoff]) as Array<{ regime: string | null; prob: number; y: number }>;

      // A signal counts only when the ensemble actually scored it. Unscored rows carry
      // win_probability = 0.5 exactly (legacy default from the pre-fix scoring outage) or NaN — if
      // left in, they drag whatever regime they fall in toward a fabricated AUC 0.5 (a constant
      // score is always 0.5). Split them out so a regime with no real scores reads as "unmeasured",
      // not "no edge".
      const groups = new Map<string, { p: number; y: number }[]>();
      const unscored = new Map<string, number>();
      const push = (key: string, p: number, y: number) => {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push({ p, y });
      };
      for (const r of rows) {
        const p = Number(r.prob);
        const reg = r.regime ?? 'UNKNOWN';
        if (!Number.isFinite(p) || p === 0.5) {
          unscored.set(reg, (unscored.get(reg) ?? 0) + 1);
          continue;
        }
        const y = Number(r.y) === 1 ? 1 : 0;
        push(reg, p, y);
        push('OVERALL', p, y);
      }

      const regimes = [...groups.entries()]
        .map(([regime, pts]) => computeRoc(regime, pts, minN, maxPoints))
        .filter((x): x is RocResult => x !== null)
        .sort((a, b) => (a.regime === 'OVERALL' ? -1 : b.regime === 'OVERALL' ? 1 : b.n - a.n));

      // Regimes that appear in resolved outcomes but have no scored signals to evaluate — reported
      // so the panel doesn't imply they were tested and failed.
      const scoredRegimes = new Set(regimes.map((r) => r.regime));
      const unscoredRegimes = [...unscored.entries()]
        .filter(([reg]) => !scoredRegimes.has(reg))
        .map(([regime, count]) => ({ regime, count }))
        .sort((a, b) => b.count - a.count);

      const model = await dbGet(`
        SELECT cv_roc_auc, model_version, trained_at FROM model_registry
        WHERE model_name = 'ensemble' AND is_active = 1
        ORDER BY trained_at DESC LIMIT 1
      `) as { cv_roc_auc: number | null; model_version: string | null; trained_at: string | null } | undefined;

      const scoredTotal = regimes.find((r) => r.regime === 'OVERALL')?.n
        ?? [...groups.values()].reduce((s, g) => s + g.length, 0);

      return {
        regimes,
        unscoredRegimes,
        trainingAuc: model?.cv_roc_auc ?? null,
        trainingModelVersion: model?.model_version ?? null,
        trainingTrainedAt: model?.trained_at ?? null,
        totalResolved: rows.length,
        scoredTotal,
        computedAt: new Date().toISOString(),
      };
      }, 300);
    }),
});
