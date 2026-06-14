import { z } from "zod";
import db from "../db";
import { alphaQuant } from "../alphaQuantClient";
import { router, publicProcedure } from "../trpc";

export const mlRouter = router({
  getFiiDiiFlow: publicProcedure
    .input(z.object({ days: z.number().min(1).max(90).default(30) }).optional())
    .query(({ input }) => {
      return db.prepare(`
        SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source, fetched_at
        FROM fii_dii_flow ORDER BY date DESC LIMIT ?
      `).all(input?.days ?? 30);
    }),

  getStrategyPerformance: publicProcedure
    .input(z.object({
      horizonDays: z.union([z.literal(5), z.literal(15)]).default(15),
      segment:     z.enum(['signal_type', 'sector', 'nifty_regime', 'score_bucket', 'overall']).optional(),
      minSignals:  z.number().min(1).default(5),
    }).optional())
    .query(({ input }) => {
      const horizon = input?.horizonDays ?? 15;
      const seg     = input?.segment;
      const min     = input?.minSignals ?? 5;
      const where   = seg ? `AND segment = '${seg}'` : '';
      return db.prepare(`
        SELECT perf_key, strategy_name, segment, segment_value, horizon_days,
               market_regime, total_signals, win_rate, avg_return_pct,
               profit_factor, sharpe_ratio, max_drawdown_pct, alpha_vs_nifty,
               signal_decay_halflife_days, false_positive_rate, last_computed
        FROM strategy_performance
        WHERE horizon_days = ? AND total_signals >= ? ${where}
        ORDER BY win_rate DESC
      `).all(horizon, min);
    }),

  getPerformanceDashboard: publicProcedure
    .query(() => {
      return {
        overall: db.prepare(`
          SELECT win_rate, avg_return_pct, sharpe_ratio, profit_factor, max_drawdown_pct,
                 alpha_vs_nifty, total_signals, last_computed
          FROM strategy_performance WHERE segment = 'overall' ORDER BY last_computed DESC LIMIT 1
        `).get(),
        topSignals: db.prepare(`
          SELECT strategy_name, win_rate, avg_return_pct, sharpe_ratio, total_signals
          FROM strategy_performance WHERE segment = 'signal_type' AND total_signals >= 10
          ORDER BY win_rate DESC LIMIT 5
        `).all(),
        byRegime: db.prepare(`
          SELECT market_regime, AVG(win_rate) AS avg_win_rate, SUM(total_signals) AS total_signals
          FROM strategy_performance WHERE segment = 'signal_type' AND market_regime != 'ALL'
          GROUP BY market_regime ORDER BY avg_win_rate DESC
        `).all(),
        latestModel: db.prepare(`
          SELECT model_name, model_type, cv_roc_auc, training_samples, trained_at
          FROM model_registry WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 3
        `).all(),
        recentBacktest: db.prepare(`
          SELECT run_name, win_rate, total_return_pct, cagr_pct, sharpe_ratio,
                 max_drawdown_pct, alpha_pct, run_at
          FROM backtesting_runs ORDER BY run_at DESC LIMIT 5
        `).all(),
        weightHistory: db.prepare(`
          SELECT optimization_method, baseline_win_rate, optimized_win_rate,
                 improvement_pct, snapshot_at
          FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT 3
        `).all(),
      };
    }),

  getMLModelRegistry: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }).optional())
    .query(({ input }) => {
      return db.prepare(`
        SELECT id, model_name, model_version, model_type, trained_at,
               training_samples, cv_roc_auc, cv_accuracy, precision_score,
               recall_score, f1_score, feature_count, is_active, horizon_days
        FROM model_registry ORDER BY trained_at DESC LIMIT ?
      `).all(input?.limit ?? 20);
    }),

  getFeatureImportance: publicProcedure
    .input(z.object({ modelName: z.string().default('ensemble'), topN: z.number().default(20) }).optional())
    .query(({ input }) => {
      return db.prepare(`
        SELECT fil.feature_name, fil.importance, fil.rank_position, fil.computed_at, mr.model_type
        FROM feature_importance_log fil
        LEFT JOIN model_registry mr ON mr.id = fil.model_id
        WHERE fil.model_name = ?
        ORDER BY fil.computed_at DESC, fil.rank_position ASC
        LIMIT ?
      `).all(input?.modelName ?? 'ensemble', input?.topN ?? 20);
    }),

  getScreenerWeightHistory: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(30).default(10) }).optional())
    .query(({ input }) => {
      return db.prepare(`
        SELECT id, snapshot_at, optimization_method, category_weights_json,
               source_weights_json, baseline_win_rate, optimized_win_rate,
               improvement_pct, training_samples
        FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT ?
      `).all(input?.limit ?? 10);
    }),

  getSignalQualityReport: publicProcedure
    .input(z.object({ horizonDays: z.union([z.literal(5), z.literal(15)]).default(15) }).optional())
    .query(({ input }) => {
      const horizon = input?.horizonDays ?? 15;
      return {
        bySignalType: db.prepare(`
          SELECT strategy_name AS signal_type, win_rate, avg_return_pct, profit_factor,
                 sharpe_ratio, total_signals, false_positive_rate, max_drawdown_pct,
                 alpha_vs_nifty, signal_decay_halflife_days, market_regime
          FROM strategy_performance
          WHERE segment = 'signal_type' AND horizon_days = ?
          ORDER BY win_rate DESC
        `).all(horizon),
        recommendationStats: db.prepare(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
                 SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
                 AVG(actual_return_pct) AS avg_return,
                 MAX(actual_return_pct) AS best_return,
                 MIN(actual_return_pct) AS worst_return
          FROM recommendation_log WHERE outcome IS NOT NULL
        `).get(),
      };
    }),

  getSignalReportCard: publicProcedure
    .input(z.object({
      horizonDays: z.union([z.literal(5), z.literal(15)]).default(15),
      activeLimit: z.number().min(1).max(200).default(50),
      recentBacktests: z.number().min(1).max(20).default(10),
    }).optional())
    .query(({ input }) => {
      const horizon = input?.horizonDays ?? 15;
      const activeLimit = input?.activeLimit ?? 50;
      const recentBacktests = input?.recentBacktests ?? 10;

      const sourceSummary = db.prepare(`
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
               SUM(CASE WHEN computed_at >= date('now', '-7 days') THEN 1 ELSE 0 END) AS active_signals,
               SUM(CASE WHEN computed_at < date('now', '-7 days') THEN 1 ELSE 0 END) AS completed_signals,
               AVG(confluence_score) AS avg_confidence_score,
               NULL AS avg_technical_score,
               NULL AS avg_quant_score,
               NULL AS avg_entry_price,
               AVG(julianday('now') - julianday(computed_at)) AS avg_age_days
        FROM confluence_signals
        WHERE computed_at >= date('now', '-30 days')
        GROUP BY signal_source
      `).all() as any[];

      const outcomeSummary = db.prepare(`
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
        WHERE outcome IS NOT NULL
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
      `).all() as any[];

      const activeSignalGrowth = db.prepare(`
        SELECT ts.id,
               ts.symbol,
               ts.date AS signal_date,
               'TECHNICAL' AS signal_source,
               'BUY' AS signal_type,
               ts.cmp AS entry_price,
               ts.signal_score AS confidence_score,
               'ACTIVE' AS status,
               ts.date AS signal_generated_at,
               (SELECT close FROM stock_ohlcv WHERE symbol = ts.symbol ORDER BY date DESC LIMIT 1) AS latest_price,
               ROUND(
                 COALESCE(
                   100.0 * ((SELECT close FROM stock_ohlcv WHERE symbol = ts.symbol ORDER BY date DESC LIMIT 1) - ts.cmp) / NULLIF(ts.cmp, 0),
                   0.0
                 ),
                 4
               ) AS growth_pct
        FROM technical_signals ts
        WHERE ts.date >= date('now', '-30 days')
          AND ts.signal_score >= 5
        ORDER BY ts.date DESC
        LIMIT ?
      `).all(activeLimit) as any[];

      const recommendationSummary = db.prepare(`
        SELECT COUNT(*) AS total_recommendations,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS win_count,
               SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS loss_count,
               SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) AS neutral_count,
               AVG(actual_return_pct) AS avg_actual_return_pct,
               MAX(actual_return_pct) AS best_actual_return_pct,
               MIN(actual_return_pct) AS worst_actual_return_pct
        FROM recommendation_log
        WHERE actual_return_pct IS NOT NULL
      `).get() as any;

      const recommendationSourceBreakdown = db.prepare(`
        SELECT source,
               COUNT(*) AS total_recs,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS win_count,
               AVG(actual_return_pct) AS avg_actual_return_pct,
               AVG(confidence_score) AS avg_confidence_score
        FROM recommendation_log
        GROUP BY source
        ORDER BY total_recs DESC
      `).all() as any[];

      const recentBacktestResults = db.prepare(`
        SELECT run_name, start_date, end_date, win_rate, total_return_pct,
               cagr_pct, sharpe_ratio, max_drawdown_pct, alpha_pct, profit_factor, run_at
        FROM backtesting_runs
        ORDER BY run_at DESC
        LIMIT ?
      `).all(recentBacktests) as any[];

      const strategyPerformance = db.prepare(`
        SELECT strategy_name, segment, segment_value, win_rate, avg_return_pct,
               profit_factor, sharpe_ratio, max_drawdown_pct, alpha_vs_nifty,
               total_signals, last_computed
        FROM strategy_performance
        WHERE segment = 'signal_type' AND horizon_days = ?
        ORDER BY win_rate DESC
        LIMIT 20
      `).all(horizon) as any[];

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

  runFullBacktest: publicProcedure
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
        return { message: `Error: ${err.message}` };
      }
    }),

  optimizeScreenerWeights: publicProcedure
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
        return { message: `Error: ${err.message}` };
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
    .mutation(({ input }) => {
      db.prepare('INSERT INTO backtest_strategies (name, symbol, timeframe, params) VALUES (?, ?, ?, ?)')
        .run(input.name, input.symbol, input.timeframe, JSON.stringify(input.params));
      return { success: true };
    }),

  getBacktestStrategies: publicProcedure
    .query(() => {
      return (db.prepare('SELECT * FROM backtest_strategies ORDER BY createdAt DESC').all() as any[])
        .map(r => ({ ...r, params: JSON.parse(r.params) }));
    }),

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
    .mutation(({ input }) => {
      const rsiUpper = input.params?.rsiUpper ?? 70;
      const rsiLower = input.params?.rsiLower ?? 30;

      const outcomes = db.prepare(`
        SELECT so.return_pct, so.outcome, so.entry_price, so.exit_price,
               so.signal_date, ts.rsi
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts ON so.symbol = ts.symbol AND so.signal_date = ts.date
        WHERE so.symbol = ?
          AND so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
        ORDER BY so.signal_date ASC
      `).all(input.symbol) as any[];

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
      const equityCurve = filtered.map((r: any) => {
        equity *= (1 + (r.return_pct ?? 0) / 100);
        return { date: r.signal_date, equity: Math.round(equity * 100) / 100 };
      });

      const returns = filtered.map((r: any) => r.return_pct ?? 0);
      const avgReturn = returns.reduce((s: number, v: number) => s + v, 0) / returns.length;
      const variance  = returns.reduce((s: number, v: number) => s + (v - avgReturn) ** 2, 0) / returns.length;
      const sharpe    = variance > 0 ? avgReturn / Math.sqrt(variance) : 0;

      return {
        symbol:       input.symbol,
        totalTrades:  filtered.length,
        wins,
        losses,
        winRate:      Math.round(winRate * 10000) / 100,
        profitFactor: Math.round(profitFactor * 100) / 100,
        avgReturn:    Math.round(avgReturn * 100) / 100,
        sharpe:       Math.round(sharpe * 100) / 100,
        equityCurve,
      };
    }),
});
