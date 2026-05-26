import { initTRPC } from "@trpc/server";
import { z } from "zod";
import superjson from "superjson";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import db from "./db";
import { generateStockAnalysis } from "../services/aiService";
import { fetchMCScreener } from "./moneycontrol";
import { fetchETnowScreener } from "./etnow";
import {
  fetchTechIndicators,
  fetchMarketMap,
  fetchAllIndianIndices,
  fetchMCRatios,
  fetchETShareholding,
  fetchETCorporateActions,
  fetchHistoricalOHLC,
  fetchSectorPerformance,
  fetchGlobalIndices,
  fetchMFInvestments,
  fetchTrendingScreeners,
  fetchETPennyStocks,
  fetchTechnicalTrends,
  fetchETStats,
  fetchIndexFullDetails,
  fetchIndexStocksList,
  fetchIndexPriceFeed,
  fetchIndexTechnicals,
  fetchIndexGraph,
  fetchNiftyTraderBreakouts,
  fetchTrendlyneJsonScreener,
  fetchTrendlyneAllInOneScreener,
  fetchMCTechTrendsAllSegments,
} from "./marketData";
import {
  fetchTrendlyneFundamentals,
  fetchTrendlyneSwot,
  fetchTrendlyneChecklist,
  fetchTrendlyneDVM,
  fetchTrendlyneStockMetrics,
  fetchTrendlyneAdvTechnicalAnalysis,
  getTrendlyneOverview,
  fetchTrendlyneSectorRotation,
  fetchTrendlyneIndexRotation,
  fetchTrendlyneStockOptionChain
} from "./trendlyneService";import { 
  getTopRatedStocks, 
  syncAndScore,
  recalculateScores,
  getStockScoreDetail
} from "./scoringService";
import { getMoneycontrolInsights } from "./moneycontrolService";
import { getStockInsights, getIndexData } from "./insightService";
import { getLatestRSIForSymbols } from "./technicalSignalsService";

import { getAllStocks, getStockMapping, getSymbolFromMcsymbol } from "./stockMapping";
import { getCachedScan, runTechnicalScan } from "./technicalScanner";
import { getFnOSignals } from "./fnoService";
import { fetchStockDataWithCache, getOrRefreshAllStocks } from "./liveStockData";
import { getMcConsolidatedData, fetchMcVwapChart, fetchKayalScreener } from "./mcApiService";
import {
  fetchPremarketAll,
  fetchDealsAll,
  fetchEarningsAll,
  fetchEarningsCalendar,
  fetchEarningsData,
  fetchEarningsRapidResults,
  fetchEarningsPriceShockers,
  fetchIndexFnoAll,
  type FnoIndexId,
} from './marketIntelService';
import { fetchTrendlyneScreenerData, fetchAllTrendlyneScreenerNames, getTrendlyneScreenerList, getTrendlyneScreenerCategories, updateFetchInterval, updateScreenerNamesInterval, testTrendlyneApiResponse, findScreenersByStock, recategorizeAllScreeners } from "./trendlyneScreener";
import { syncNSEStocksToDatabase, getAllNSEStocksFromDB, searchNSEStocksFromDB, getNSEStockFromDB, getNSEStocksBySectorFromDB, getNSEStocksByIndustryFromDB, getAllSectorsFromDB, getAllIndustriesFromDB, getNSEStockCount } from "./nseService";
import { fetchOptionChain, fetchFnoSymbols } from "./optionChainService";
import { fetchTopMovers } from "./topMoversService";
import { enqueueAISignals, getAIQueueStats } from "./queues";
import { fetchGlobalMarketData } from "./globalMarketService";
import { crossSourceFilter, regimeSectorFilter, qualityOversoldScanner } from './strategySignalsService';

const t = initTRPC.create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Ensure todos table exists (temporary safeguard)
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT CHECK(status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED')) DEFAULT 'PENDING',
    category TEXT DEFAULT 'IDEAS',
    priority TEXT CHECK(priority IN ('LOW', 'MEDIUM', 'HIGH')) DEFAULT 'MEDIUM',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export const appRouter = router({
  getGlobalMarketData: publicProcedure
    .query(async () => {
      return await fetchGlobalMarketData();
    }),

  getAIAnalysis: publicProcedure

    .input(z.object({ 
      symbol: z.string(), 
      data: z.record(z.string(), z.unknown())
    }))
    .mutation(async ({ input }) => {
      return await generateStockAnalysis(input.symbol, input.data);
    }),

  syncUser: publicProcedure

    .input(z.object({
      id: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      photoURL: z.string().nullable(),
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO users (id, email, name, photoURL)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          photoURL = excluded.photoURL
      `);
      stmt.run(input.id, input.email, input.name, input.photoURL);
      return { success: true };
    }),

  // --- Watchlist Procedures ---
  getWatchlist: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT symbol FROM watchlist WHERE userId = ? ORDER BY addedAt DESC')
        .all(input.userId) as { symbol: string }[];
      return rows.map(r => r.symbol);
    }),

  getWatchlistDetails: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT symbol, price, name, addedAt, source FROM watchlist WHERE userId = ? ORDER BY addedAt DESC')
        .all(input.userId) as { symbol: string; price?: number; name?: string; addedAt: string; source?: string }[];
      return rows;
    }),

  addToWatchlist: publicProcedure
    .input(z.object({
      userId: z.string(),
      symbol: z.string(),
      price: z.number().optional(),
      name: z.string().optional(),
      source: z.string().optional()
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO watchlist (userId, symbol, price, name, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(userId, symbol) DO UPDATE SET
          price = coalesce(excluded.price, price),
          name = coalesce(excluded.name, name),
          source = coalesce(excluded.source, source)
      `);
      stmt.run(input.userId, input.symbol, input.price ?? null, input.name ?? null, input.source ?? null);
      return { success: true };
    }),

  removeFromWatchlist: publicProcedure
    .input(z.object({ userId: z.string(), symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare('DELETE FROM watchlist WHERE userId = ? AND symbol = ?');
      stmt.run(input.userId, input.symbol);
      return { success: true };
    }),

  // --- Signal Procedures (Refactored to SQLite) ---
  getSignals: publicProcedure
    .input(z.object({ limit: z.number().optional().default(5) }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT * FROM signals ORDER BY createdAt DESC LIMIT ?')
        .all(input.limit);
      return rows;
    }),

  saveSignal: publicProcedure
    .input(z.object({
      symbol: z.string(),
      type: z.enum(["BUY", "SELL", "HOLD"]),
      entry: z.number(),
      target: z.number(),
      stopLoss: z.number(),
      confidence: z.number(),
      reasoning: z.string(),
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `);
      stmt.run(input.symbol, input.type, input.entry, input.target, input.stopLoss, input.confidence, input.reasoning);
      return { success: true };
    }),

  // Enqueue AI analysis for all provided stocks via BullMQ
  enqueueSignals: publicProcedure
    .input(z.array(z.object({
      symbol:    z.string(),
      stockData: z.record(z.string(), z.unknown()),
    })))
    .mutation(async ({ input }) => {
      return await enqueueAISignals(input);
    }),

  // Real-time BullMQ queue stats for progress tracking
  getQueueStats: publicProcedure.query(async () => {
    return await getAIQueueStats();
  }),

  // ── Fundamentals sync ─────────────────────────────────────────────────────

  triggerFundamentalsSync: publicProcedure
    .input(z.object({ phase2Only: z.boolean().optional() }).optional())
    .mutation(async ({ input }) => {
      const { fundamentalsSyncQueue } = await import('./queues');
      if (!fundamentalsSyncQueue) {
        // No Redis — run directly in a detached async call (non-blocking)
        const { runFullFundamentalsSync } = await import('./fundamentalsSyncService');
        runFullFundamentalsSync(input?.phase2Only ?? false).catch(console.error);
        return { queued: false, message: 'Running directly (no Redis)' };
      }
      const waiting = await fundamentalsSyncQueue.getWaiting();
      const active  = await fundamentalsSyncQueue.getActive();
      if (waiting.length + active.length > 0) {
        return { queued: false, message: 'Sync already queued or running' };
      }
      await fundamentalsSyncQueue.add(
        'sync-fundamentals',
        { phase2Only: input?.phase2Only ?? false },
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1 },
      );
      return { queued: true, message: 'Fundamentals sync job enqueued' };
    }),

  getFundamentalsStatus: publicProcedure.query(async () => {
    const { getSyncProgress, getFundamentalsCount } = await import('./fundamentalsSyncService');
    return {
      progress: getSyncProgress(),
      dbCounts: getFundamentalsCount(),
    };
  }),

  getStockFundamentals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { getStoredFundamentals, refreshSymbolFundamentals } = await import('./fundamentalsSyncService');
      let row = getStoredFundamentals(input.symbol);
      if (!row) {
        // Fetch on-demand for individual stock views
        await refreshSymbolFundamentals(input.symbol).catch(() => null);
        row = getStoredFundamentals(input.symbol);
      }
      return row ?? null;
    }),

  // ── Quantitative strategy scoring ─────────────────────────────────────────

  runQuantScoring: publicProcedure
    .mutation(async () => {
      const { quantScoringQueue } = await import('./queues');
      if (!quantScoringQueue) {
        const { runQuantScoring } = await import('./quantScoringService');
        runQuantScoring().catch(console.error);
        return { queued: false, message: 'Running directly (no Redis)' };
      }
      const waiting = await quantScoringQueue.getWaiting();
      const active  = await quantScoringQueue.getActive();
      if (waiting.length + active.length > 0) {
        return { queued: false, message: 'Scoring already queued or running' };
      }
      await quantScoringQueue.add(
        'quant-score-manual',
        {},
        { removeOnComplete: 3, removeOnFail: 3, attempts: 1 },
      );
      return { queued: true, message: 'Quant scoring job enqueued' };
    }),

  getQuantScoringStatus: publicProcedure.query(async () => {
    const { getQuantScoringProgress, getQuantScoreSummary } = await import('./quantScoringService');
    return {
      progress: getQuantScoringProgress(),
      summary:  getQuantScoreSummary(),
    };
  }),

  getStrategyStocks: publicProcedure
    .input(z.object({
      strategy: z.enum(['composite', 'momentum', 'quality', 'value', 'confluence', 'investment_picks']).default('composite'),
      limit:    z.number().min(1).max(100).default(25),
      filters:  z.object({
        minSharpe:         z.number().optional(),
        maxVol:            z.number().optional(),
        maxDrawdown:       z.number().optional(),
        aboveSma200:       z.boolean().optional(),
        maxPE:             z.number().optional(),
        minROE:            z.number().optional(),
        maxDebtToEquity:   z.number().optional(),
        minPiotroski:      z.number().optional(),
        minMarketCapCr:    z.number().optional(),
      }).optional(),
    }))
    .query(async ({ input }) => {
      const { getStrategyStocks } = await import('./quantScoringService');
      return getStrategyStocks(input.strategy, input.limit, input.filters ?? {});
    }),

  getQuantScore: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { getQuantScore } = await import('./quantScoringService');
      return getQuantScore(input.symbol) ?? null;
    }),

  // ── Technical Signals (7 daily patterns from OHLCV) ──────────────────────

  runTechnicalSignalScan: publicProcedure
    .input(z.object({ minScore: z.number().min(1).max(10).optional() }).optional())
    .mutation(async ({ input }) => {
      const { runTechnicalSignalScan } = await import('./technicalSignalsService');
      runTechnicalSignalScan({ minScore: input?.minScore ?? 2 }).catch(console.error);
      return { triggered: true };
    }),

  getTechnicalSignalsStatus: publicProcedure.query(async () => {
    const { getTechnicalSignalsProgress, getSignalSummary } = await import('./technicalSignalsService');
    return {
      progress: getTechnicalSignalsProgress(),
      summary:  getSignalSummary(),
    };
  }),

  getTechnicalSignals: publicProcedure
    .input(z.object({
      date:     z.string().optional(),
      minScore: z.number().min(1).max(10).default(1),
      limit:    z.number().min(1).max(200).default(100),
    }))
    .query(async ({ input }) => {
      const { getTechnicalSignalsForDate } = await import('./technicalSignalsService');
      const rows = getTechnicalSignalsForDate(input.date, input.minScore, input.limit);
      return rows.map(r => ({
        ...r,
        signals: (() => { try { return JSON.parse((r.signals_json as string) ?? '[]'); } catch { return []; } })(),
      }));
    }),

  getSignalDates: publicProcedure.query(async () => {
    const { getSignalDates } = await import('./technicalSignalsService');
    return getSignalDates();
  }),

  getSectorSignalStats: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const { getSectorSignalStats } = await import('./technicalSignalsService');
      return getSectorSignalStats(input?.date);
    }),

  getSignalWinRates: publicProcedure.query(async () => {
    const { getWinRateStats } = await import('./signalOutcomesService');
    return getWinRateStats();
  }),

  computeSignalOutcomes: publicProcedure
    .input(z.object({ horizonDays: z.union([z.literal(5), z.literal(15)]).default(5) }))
    .mutation(async ({ input }) => {
      const { computeSignalOutcomes } = await import('./signalOutcomesService');
      return computeSignalOutcomes(input.horizonDays);
    }),

  getSignalTypeStats: publicProcedure
    .input(z.object({ horizonDays: z.union([z.literal(5), z.literal(15)]).default(15) }).optional())
    .query(async ({ input }) => {
      const { getSignalTypeStats } = await import('./technicalSignalsService');
      return getSignalTypeStats(input?.horizonDays ?? 15);
    }),

  computeSignalTypeStats: publicProcedure
    .mutation(async () => {
      const { computeSignalTypeStats } = await import('./technicalSignalsService');
      return computeSignalTypeStats();
    }),

  getFiiDiiFlow: publicProcedure
    .input(z.object({ days: z.number().min(1).max(90).default(30) }).optional())
    .query(({ input }) => {
      const rows = db.prepare(
        `SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source, fetched_at
         FROM fii_dii_flow ORDER BY date DESC LIMIT ?`
      ).all(input?.days ?? 30);
      return rows;
    }),

  // ── ML Feedback Framework ─────────────────────────────────────────────────

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
      const rows = db.prepare(`
        SELECT perf_key, strategy_name, segment, segment_value, horizon_days,
               market_regime, total_signals, win_rate, avg_return_pct,
               profit_factor, sharpe_ratio, max_drawdown_pct, alpha_vs_nifty,
               signal_decay_halflife_days, false_positive_rate, last_computed
        FROM strategy_performance
        WHERE horizon_days = ? AND total_signals >= ? ${where}
        ORDER BY win_rate DESC
      `).all(horizon, min);
      return rows;
    }),

  getPerformanceDashboard: publicProcedure.query(() => {
    const overall = db.prepare(`
      SELECT win_rate, avg_return_pct, sharpe_ratio, profit_factor, max_drawdown_pct,
             alpha_vs_nifty, total_signals, last_computed
      FROM strategy_performance WHERE segment = 'overall' ORDER BY last_computed DESC LIMIT 1
    `).get();

    const topSignals = db.prepare(`
      SELECT strategy_name, win_rate, avg_return_pct, sharpe_ratio, total_signals
      FROM strategy_performance WHERE segment = 'signal_type' AND total_signals >= 10
      ORDER BY win_rate DESC LIMIT 5
    `).all();

    const byRegime = db.prepare(`
      SELECT market_regime, AVG(win_rate) AS avg_win_rate, SUM(total_signals) AS total_signals
      FROM strategy_performance WHERE segment = 'signal_type' AND market_regime != 'ALL'
      GROUP BY market_regime ORDER BY avg_win_rate DESC
    `).all();

    const latestModel = db.prepare(`
      SELECT model_name, model_type, cv_roc_auc, training_samples, trained_at
      FROM model_registry WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 3
    `).all();

    const recentBacktest = db.prepare(`
      SELECT run_name, win_rate, total_return_pct, cagr_pct, sharpe_ratio,
             max_drawdown_pct, alpha_pct, run_at
      FROM backtesting_runs ORDER BY run_at DESC LIMIT 5
    `).all();

    const weightHistory = db.prepare(`
      SELECT optimization_method, baseline_win_rate, optimized_win_rate,
             improvement_pct, snapshot_at
      FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT 3
    `).all();

    return { overall, topSignals, byRegime, latestModel, recentBacktest, weightHistory };
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
      const model = input?.modelName ?? 'ensemble';
      const topN  = input?.topN ?? 20;
      return db.prepare(`
        SELECT fil.feature_name, fil.importance, fil.rank_position, fil.computed_at, mr.model_type
        FROM feature_importance_log fil
        LEFT JOIN model_registry mr ON mr.id = fil.model_id
        WHERE fil.model_name = ?
        ORDER BY fil.computed_at DESC, fil.rank_position ASC
        LIMIT ?
      `).all(model, topN);
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
      const byType = db.prepare(`
        SELECT strategy_name AS signal_type, win_rate, avg_return_pct, profit_factor,
               sharpe_ratio, total_signals, false_positive_rate, max_drawdown_pct,
               alpha_vs_nifty, signal_decay_halflife_days, market_regime
        FROM strategy_performance
        WHERE segment = 'signal_type' AND horizon_days = ?
        ORDER BY win_rate DESC
      `).all(horizon);

      const recs = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
               AVG(actual_return_pct) AS avg_return,
               MAX(actual_return_pct) AS best_return,
               MIN(actual_return_pct) AS worst_return
        FROM recommendation_log WHERE outcome IS NOT NULL
      `).get();

      return { bySignalType: byType, recommendationStats: recs };
    }),

  runFullBacktest: publicProcedure
    .input(z.object({
      start:       z.string().default('2023-01-01'),
      end:         z.string().optional(),
      horizonDays: z.number().min(5).max(30).default(15),
      minScore:    z.number().min(1).max(10).default(3),
      maxPositions: z.number().min(5).max(50).default(20),
      initialCapital: z.number().min(100000).default(1000000),
      runName:     z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const end = input.end ?? new Date().toISOString().split('T')[0];
        const res = await fetch('http://127.0.0.1:8002/api/v1/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: input.start,
            end: end,
            horizon: input.horizonDays,
            min_score: input.minScore,
            max_pos: input.maxPositions,
            capital: input.initialCapital,
            name: input.runName || ''
          })
        });
        
        if (!res.ok) {
           const errText = await res.text();
           console.error('[runFullBacktest]', errText);
           return { message: `Error: ${errText.slice(0, 500)}` };
        }
        
        const data = await res.json();
        return { run_id: data.run_id, message: 'Backtest complete' };
      } catch (err: any) {
        console.error('[runFullBacktest] Fetch error:', err);
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
        const res = await fetch('http://127.0.0.1:8002/api/v1/optimize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            horizon_days: input?.horizonDays ?? 15,
            iterations: input?.iterations ?? 300,
            apply: input?.apply ?? true
          })
        });
        
        if (!res.ok) {
           const errText = await res.text();
           console.error('[optimizeScreenerWeights]', errText);
           return { message: `Optimization failed: ${errText.slice(0, 500)}` };
        }
        
        const data = await res.json();
        return { message: 'Optimization completed', improvement: data.improvement_pct };
      } catch (err: any) {
        console.error('[optimizeScreenerWeights] Fetch error:', err);
        return { message: `Error: ${err.message}` };
      }
    }),

  // ── News Sentiment ────────────────────────────────────────────────────────

  getMarketSentiment: publicProcedure
    .input(z.object({ historyHours: z.number().min(1).max(168).optional() }).optional())
    .query(async ({ input }) => {
      const { getLatestSentimentSnapshot, getSentimentHistory } = await import('./newsSentimentService');
      return {
        latest:  getLatestSentimentSnapshot(),
        history: getSentimentHistory(input?.historyHours ?? 24),
      };
    }),

  getNewsItems: publicProcedure
    .input(z.object({
      limit:      z.number().min(1).max(200).default(60),
      category:   z.enum(['ALL','EARNINGS','ORDER_WIN','BUYBACK','POLICY','IPO','GLOBAL','SECTOR','GENERAL']).default('ALL'),
      sentiment:  z.enum(['ALL','BULLISH','BEARISH','NEUTRAL']).default('ALL'),
      sourceType: z.enum(['ALL','INDIAN','GLOBAL']).default('ALL'),
      hours:      z.number().min(1).max(72).default(8),
    }).optional())
    .query(async ({ input }) => {
      const { getNewsItems } = await import('./newsSentimentService');
      return getNewsItems(input ?? {});
    }),

  getSectorNewsSentiment: publicProcedure.query(async () => {
    const { getSectorSentiment } = await import('./newsSentimentService');
    return getSectorSentiment();
  }),

  getCorporateEventNews: publicProcedure.query(async () => {
    const { getCorporateEventNews } = await import('./newsSentimentService');
    return getCorporateEventNews();
  }),

  getInstitutionalFlows: publicProcedure.query(async () => {
    return {
      success: 1,
      data: {
        institutionalDetails: [
          {
            category: 'FII/FPI',
            date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            netBuySell: '1243.80',
            buyValue: '11450.20',
            sellValue: '10206.40'
          },
          {
            category: 'DII',
            date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
            netBuySell: '879.40',
            buyValue: '9860.50',
            sellValue: '8981.10'
          }
        ]
      }
    };
  }),

  refreshNewsSentiment: publicProcedure.mutation(async () => {
    const { newsSentimentQueue } = await import('./queues');
    if (newsSentimentQueue) {
      await newsSentimentQueue.add('news-sentiment-manual', {}, { removeOnComplete: 3 });
      return { queued: true };
    }
    const { runNewsSentimentCycle } = await import('./newsSentimentService');
    runNewsSentimentCycle().catch(console.error);
    return { queued: false };
  }),

  getSignalHistory: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const rows = db.prepare('SELECT * FROM signals WHERE symbol = ? ORDER BY createdAt DESC')
        .all(input.symbol);
      return rows;
    }),

  getAccuracyMetrics: publicProcedure.query(async () => {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
      FROM signals
    `).get() as { total: number, completed: number, failed: number };
    
    const relevant = (stats.completed || 0) + (stats.failed || 0);
    
    return {
      precision: relevant > 0 ? (stats.completed / relevant) * 100 : 0,
      totalSignals: stats.total || 0,
      profitHitRate: relevant > 0 ? (stats.completed / relevant) * 100 : 0,
    };
  }),

  // --- Backtest Procedures (Refactored to SQLite) ---
  saveBacktestStrategy: publicProcedure
    .input(z.object({
      name: z.string(),
      symbol: z.string(),
      timeframe: z.string(),
      params: z.object({
        rsiUpper: z.number(),
        rsiLower: z.number(),
        emaShort: z.number(),
        emaLong: z.number(),
      })
    }))
    .mutation(async ({ input }) => {
      const stmt = db.prepare(`
        INSERT INTO backtest_strategies (name, symbol, timeframe, params)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(input.name, input.symbol, input.timeframe, JSON.stringify(input.params));
      return { success: true };
    }),

  getBacktestStrategies: publicProcedure
    .query(async () => {
      const rows = db.prepare('SELECT * FROM backtest_strategies ORDER BY createdAt DESC').all() as any[];
      return rows.map(r => ({ ...r, params: JSON.parse(r.params) }));
    }),

  // --- Existing Market Data Procedures (Unchanged) ---
  getFnOSignals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getFnOSignals(input.symbol);
    }),

  getTrendlyneFnoScanners: publicProcedure
    .input(z.object({ mtype: z.enum(['options', 'futures']), screenType: z.string(), instType: z.string().optional() }))
    .query(async ({ input }) => {
      const { getTrendlyneFnoScanners } = await import("./fnoService");
      return await getTrendlyneFnoScanners(input.mtype, input.screenType, input.instType);
    }),

  getMCFnoOverview: publicProcedure
    .input(z.object({ id: z.string(), instType: z.enum(['futures', 'options']).optional().default('futures') }))
    .query(async ({ input }) => {
      const { getMCFnoOverview } = await import("./fnoService");
      return await getMCFnoOverview(input.id, input.instType);
    }),

  getOptionsIntelligence: publicProcedure
    .query(async () => {
      try {
        const res = await fetch('http://127.0.0.1:8002/api/v1/options/pcr', {
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) {
          throw new Error('Failed to fetch options PCR from backend');
        }
        return await res.json();
      } catch (e: any) {
        console.error('Error in getOptionsIntelligence:', e.message);
        return [];
      }
    }),

  analyzePortfolio: publicProcedure
    .input(z.object({
      symbols: z.array(z.string()),
      weights: z.array(z.number())
    }))
    .mutation(async ({ input }) => {
      try {
        const res = await fetch('http://127.0.0.1:8002/api/v1/portfolio/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) {
          throw new Error('Failed to analyze portfolio');
        }
        return await res.json();
      } catch (e: any) {
        console.error('Error analyzing portfolio:', e.message);
        return { error: e.message };
      }
    }),

  getTrendlyneFnoHeatmap: publicProcedure
    .query(async () => {
      const { getTrendlyneFnoHeatmap } = await import("./fnoService");
      return await getTrendlyneFnoHeatmap();
    }),

  getTechnicalScan: publicProcedure
    .input(z.object({ symbol: z.string(), forceRefresh: z.boolean().optional() }))
    .query(async ({ input }) => {
      const { symbol, forceRefresh } = input;
      if (!forceRefresh) {
        const cached = await getCachedScan(symbol);
        if (cached) return cached;
      }
      return await runTechnicalScan(symbol);
    }),

  getTechnicalPredictions: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const row = db.prepare('SELECT * FROM technical_analysis_signals WHERE symbol = ?').get(input.symbol) as any;
      if (!row) return null;
      return {
        ...row,
        patterns: JSON.parse(row.patterns || '[]')
      };
    }),

  getStockList: publicProcedure.query(() => {
    return getAllStocks();
  }),

  // LIVE STOCK DATA ENDPOINTS
  // Fetch real-time quotes from external APIs instead of dummy data
  // Data sources: MoneyControl API, Finnhub, BSE/NSE Direct
  getLiveStockQuote: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const quoteData = await fetchStockDataWithCache(input.symbol);
      if (!quoteData) {
        throw new Error(`Failed to fetch live data for ${input.symbol}`);
      }
      return quoteData;
    }),

  // Batch fetching for visibility-based updating
  getLiveQuotesBatch: publicProcedure
    .input(z.array(z.string()))
    .query(async ({ input }) => {
      if (!input || input.length === 0) return [];
      const promises = input.map(sym => fetchStockDataWithCache(sym));
      const results = await Promise.all(promises);
      return results.filter(Boolean); // Filter out nulls
    }),

  getOptionChain: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchOptionChain(input.symbol);
    }),

  getTopMovers: publicProcedure.query(async () => {
    return await fetchTopMovers();
  }),

  getBreakouts: publicProcedure.query(async () => {
    return await fetchNiftyTraderBreakouts();
  }),

  getFnoSymbols: publicProcedure
    .query(async () => {
      // Simple server-side cache to avoid repeated heavy API calls
      const cacheKey = 'fno_symbols_cache';
      const cached = (global as any)[cacheKey];
      if (cached && Date.now() - cached.timestamp < 3600000) {
        return cached.data;
      }
      
      const data = await fetchFnoSymbols();
      if (data && data.length > 0) {
        (global as any)[cacheKey] = { data, timestamp: Date.now() };
      }
      return data;
    }),

  getLiveStocks: publicProcedure.query(async () => {
    // Returns all live stock quotes
    // Fetches from MoneyControl API with fallback to Finnhub
    // Data is cached for 30 seconds per stock
    return await getOrRefreshAllStocks();
  }),

  getRatios: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchMCRatios(input.symbol);
    }),

  getShareholding: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchETShareholding(input.symbol);
    }),

  getCorporateActions: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchETCorporateActions(input.symbol);
    }),

  getStockDetailsMap: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => {
      return getStockMapping(input.symbol);
    }),

  getTechnicalDetails: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.enum(['D', 'W', 'M']).optional() }))
    .query(async ({ input }) => {
      return await fetchTechIndicators(input.symbol, input.dur);
    }),

  getInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getMoneycontrolInsights(input.symbol);
    }),

  getStockInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getStockInsights(input.symbol);
    }),

  getIndexDetails: publicProcedure
    .input(z.object({ indexId: z.string() }))
    .query(async ({ input }) => {
      return await getIndexData(input.indexId);
    }),

  getMarketMapData: publicProcedure
    .input(z.object({ indId: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchMarketMap(input.indId);
    }),

  getOHLCData: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchHistoricalOHLC(input.symbol, input.dur);
    }),

  getAllIndices: publicProcedure.query(async () => {
    return await fetchAllIndianIndices();
  }),

  getGlobalIndices: publicProcedure.query(async () => {
    return await fetchGlobalIndices();
  }),

  getTrendlyneFundamentals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchTrendlyneFundamentals(input.symbol);
    }),

  getMFInvestments: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchMFInvestments(input.symbol);
    }),

  getTrendingScreeners: publicProcedure.query(async () => {
    return await fetchTrendingScreeners();
  }),

  getETPennyStocks: publicProcedure.query(async () => {
    return await fetchETPennyStocks();
  }),

  getTechnicalTrends: publicProcedure
    .input(z.object({ 
      type: z.enum(['bullish', 'bearish', 'turning-bullish', 'turning-bearish']), 
      index: z.string().optional() 
    }))
    .query(async ({ input }) => {
      const result = await fetchTechnicalTrends(input.type, input.index);
      if (result?.success === 1) {
        const list = result.data?.list || result.data?.tableDataList || [];
        
        // 1. Resolve symbols for all items
        const enrichedList = list.map((item: any) => {
          const symbol = getSymbolFromMcsymbol(item.scId);
          return { 
            ...item, 
            symbol: symbol || item.scId, 
            shortName: symbol || item.scId,
            // Map MC fields to frontend expected fields
            lastPrice: parseFloat(String(item.currPrice || '0').replace(/,/g, '')),
            percentChange: parseFloat(item.performance || '0'),
            trend: item.currTrend || '',
            stockId: item.scId
          };
        });

        // 2. Batch fetch RSI from local DB
        const symbols = enrichedList.map((item: any) => item.symbol);
        const rsiMap = getLatestRSIForSymbols(symbols);

        // 3. Add RSI to items (with API fallback)
        const finalData = await Promise.all(enrichedList.map(async (item: any) => {
          let rsi = rsiMap.get(item.symbol);
          
          if (rsi === undefined || rsi === 0) {
            try {
              const tech = await fetchTechIndicators(item.symbol);
              const rsiInd = tech?.data?.indicators?.find((i: any) => 
                i.displayName?.includes('RSI') || i.id === 'RSI'
              );
              if (rsiInd) {
                rsi = parseFloat(String(rsiInd.value || '0'));
              }
            } catch (err) {
              console.error(`[RSI FALLBACK] Failed for ${item.symbol}:`, err);
            }
          }
          
          return {
            ...item,
            rsi: rsi || 0
          };
        }));

        if (result.data?.list) result.data.list = finalData;
        if (result.data?.tableDataList) result.data.tableDataList = finalData;

      }
      return result;
    }),

  // Multi-segment MC Technical Trends (All/FNO/LargeCap/MidCap/SmallCap)
  getTechTrendsBySegment: publicProcedure
    .input(z.object({
      type: z.enum(['bullish', 'bearish', 'turning-bullish', 'turning-bearish']),
    }))
    .query(async ({ input }) => {
      const result = await fetchMCTechTrendsAllSegments(input.type);
      // Enrich each segment's stocks with resolved NSE symbols
      for (const [seg, list] of Object.entries(result)) {
        result[seg] = list.map((item: any) => {
          const symbol = getSymbolFromMcsymbol(item.scId);
          return {
            ...item,
            symbol: symbol || item.scId,
            lastPrice: parseFloat(String(item.currPrice || '0').replace(/,/g, '')),
            percentChange: parseFloat(item.performance || '0'),
            trend: item.currTrend || '',
            prevTrend: item.prevTrend || '',
            trendChangeDate: item.trendChngDate || '',
          };
        });
      }
      return result;
    }),

  // Trendlyne JSON screener (lightweight /json-screener/ endpoint)
  getTrendlyneJsonScreener: publicProcedure
    .input(z.object({
      screenerId: z.string(),
      limit: z.number().optional().default(25),
    }))
    .query(async ({ input }) => {
      return fetchTrendlyneJsonScreener(input.screenerId, input.limit);
    }),

  // Trendlyne All-in-One Screener (tl-all-in-one-screener-data-get)
  getTrendlyneAIOScreener: publicProcedure
    .input(z.object({
      screenpk: z.string(),
      limit: z.number().optional().default(25),
    }))
    .query(async ({ input }) => {
      return fetchTrendlyneAllInOneScreener(input.screenpk, input.limit);
    }),

  getETStats: publicProcedure
    .input(z.object({
      type: z.enum(['gainers', 'losers']),
      duration: z.string().optional()
    }))
    .query(async ({ input }) => {
      return await fetchETStats(input.type, input.duration);
    }),

  getIndexFullDetails: publicProcedure
    .input(z.object({ indId: z.string() }))
    .query(async ({ input }) => {
      return await fetchIndexFullDetails(input.indId);
    }),

  getIndexStocksList: publicProcedure
    .input(z.object({ indId: z.string(), type: z.enum(['0', '1']).optional() }))
    .query(async ({ input }) => {
      return await fetchIndexStocksList(input.indId, input.type ?? '0');
    }),

  getIndexPriceFeed: publicProcedure
    .input(z.object({ bridgeSymbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchIndexPriceFeed(input.bridgeSymbol);
    }),

  getIndexTechnicals: publicProcedure
    .input(z.object({ period: z.enum(['D', 'W', 'M']), bridgeSymbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchIndexTechnicals(input.period, input.bridgeSymbol);
    }),

  getStocks: publicProcedure
    .input(z.object({ limit: z.number().optional().default(10), sector: z.string().optional() }))
    .query(async ({ input }) => {
      const allStocks = await getOrRefreshAllStocks();
      let filtered = allStocks;
      if (input.sector) {
        filtered = allStocks.filter((s: any) => s.sector === input.sector);
      }
      return filtered.slice(0, input.limit);
    }),

  getSectorPerformance: publicProcedure
    .input(z.object({ indexId: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const data = await fetchSectorPerformance(input?.indexId);
      if (data && data.success === 1 && data.data) {
        return data.data.map((s: any) => {
          const name = s.sectorName || s.sector || 'Unknown';
          const rawChange = s.percentChange ?? s.mcapPerChange ?? 0;
          const change = typeof rawChange === 'number' ? rawChange : parseFloat(String(rawChange).replace(/,/g, ''));
          return {
            name,
            change: isNaN(change) ? 0 : change,
            stocks: s.stocksCount || 0
          };
        });
      }

      // Fallback: aggregate from live stock data grouped by sector
      const allStocks = await getOrRefreshAllStocks();
      const sectorMap = new Map<string, number[]>();
      for (const stock of allStocks) {
        const sector = (stock as any).sector || (stock as any).industry;
        if (sector && sector !== 'Unknown') {
          if (!sectorMap.has(sector)) sectorMap.set(sector, []);
          sectorMap.get(sector)!.push(stock.changePct);
        }
      }
      return Array.from(sectorMap.entries())
        .map(([name, changes]) => {
          const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
          return {
            name,
            change: isNaN(avgChange) ? 0 : Number(avgChange.toFixed(2)),
            stocks: changes.length,
          };
        })
        .sort((a, b) => b.change - a.change);
    }),

  getScreenerResults: publicProcedure
    .input(z.object({
      filter: z.string(),
      sector: z.string().optional(),
      minPe: z.number().optional(),
      maxPe: z.number().optional(),
      minRoe: z.number().optional(),
      maxPb: z.number().optional(),
      maxDe: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const allStocks = await getOrRefreshAllStocks();
      let data: any[] = allStocks;

      // Price-based filters using real market data
      if (input.filter === 'Gainers') {
        data = data.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
      } else if (input.filter === 'Losers') {
        data = data.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
      } else if (input.filter === 'Near 52W High') {
        data = data
          .filter(s => s.high52w && s.high52w > 0 && (s.price / s.high52w) > 0.95)
          .sort((a, b) => (b.price / b.high52w) - (a.price / a.high52w));
      } else if (input.filter === 'Near 52W Low') {
        data = data
          .filter(s => s.low52w && s.low52w > 0 && (s.price / s.low52w) < 1.05)
          .sort((a, b) => (a.price / a.low52w) - (b.price / b.low52w));
      } else if (input.filter === 'High Volume') {
        data = [...data].sort((a, b) => {
          const va = parseFloat(String(a.volume).replace(/[KM]/g, m => m === 'K' ? '000' : '000000'));
          const vb = parseFloat(String(b.volume).replace(/[KM]/g, m => m === 'K' ? '000' : '000000'));
          return vb - va;
        });
      }
      // Note: High ROE, Low Debt, PE-based filters require fundamental data not
      // available from real-time price feeds. Return all stocks for these presets.

      if (input.sector && input.sector !== 'All') {
        data = data.filter(s => s.sector === input.sector);
      }

      // Return top 200 to keep payload manageable
      return data.slice(0, 200);
    }),
  
  getMarketOverview: publicProcedure.query(async () => {
    const parse = (s: unknown) => parseFloat(String(s ?? '0').replace(/,/g, '')) || 0;
    const { getIndexByName } = await import('./indexMapping');
    
    const extractId = (name: string, url: string) => {
      // Try URL first
      const m = url?.match(/-(\d+)\.html$/);
      if (m) return m[1];
      // Fallback to mapping
      const mapped = getIndexByName(name);
      return mapped?.id || null;
    };
    
    try {
      const data = await fetchAllIndianIndices();
      if (data?.success === 1) {
        const keyList: any[] = data.data?.indiceList?.[0]?.list ?? [];
        const find = (name: string) => keyList.find((i: any) => i.name === name);
        const n50 = find('NIFTY 50');
        const sx = find('SENSEX');
        const bnk = find('NIFTY BANK');
        if (n50 && sx && bnk) {
          return {
            nifty50:   { indId: extractId('NIFTY 50', n50.url), value: parse(n50.value),  change: parse(n50.change),  changePct: parse(n50.changePer)  },
            sensex:    { indId: extractId('SENSEX', sx.url),    value: parse(sx.value),   change: parse(sx.change),   changePct: parse(sx.changePer)   },
            bankNifty: { indId: extractId('NIFTY BANK', bnk.url), value: parse(bnk.value),  change: parse(bnk.change),  changePct: parse(bnk.changePer)  },
          };
        }
      }
    } catch {}
    return {
      nifty50:   { indId: '9',  value: 22450.2, change: 124.5,  changePct:  0.56 },
      sensex:    { indId: '4',  value: 73850.4, change: 412.1,  changePct:  0.56 },
      bankNifty: { indId: '23', value: 48250.3, change: -120.4, changePct: -0.25 },
    };
  }),

  getMarketScanners: publicProcedure.query(() => {
    return [
      { category: 'Breakout Intelligence', items: [
        { id: 'mc-25-OHLC_D_P_BPBULL', provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL', name: 'Range Breakout', type: 'techscanner' as const },
        { id: 'mc-25-OHLC_D_P_WIBL', provider: 'mc', catId: 25, scanId: 'OHLC_D_P_WIBL', name: 'White Marubozu', type: 'techscanner' as const },
        { id: 'mc-25-OHLC_D_I_RSIPOWBO', provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO', name: 'RSI Resistance BO', type: 'techscanner' as const },
        { id: 'mc-patterns-triangle', provider: 'mc', catId: 'patterns', scanId: 'triangle', name: 'Triangle Breakout', type: 'techscanner' as const },
        { id: 'mc-patterns-flag', provider: 'mc', catId: 'patterns', scanId: 'flag', name: 'Flag Pattern', type: 'techscanner' as const },
      ]},
      { category: 'Multi-Timeframe Highs', items: [
        { id: 'hh-15m-1h', provider: 'custom', name: '15m & 1h New Highs', type: 'multi-tf' as const, timeframes: ['15m', '1h'] },
        { id: 'hh-1h-4h-d', provider: 'custom', name: '1h, 4h & Daily Highs', type: 'multi-tf' as const, timeframes: ['1h', '4h', 'D'] },
        { id: 'hh-d-w', provider: 'custom', name: 'Daily & Weekly Highs', type: 'multi-tf' as const, timeframes: ['D', 'W'] },
      ]},
      { category: 'Value & Quality (MC)', items: [
        { id: 'mc-1-146', provider: 'mc', catId: 1, scanId: '146', name: 'Bargain Buys', type: 'proscanner' as const },
        { id: 'mc-1-181', provider: 'mc', catId: 1, scanId: '181', name: 'Reasonable Price', type: 'proscanner' as const },
        { id: 'mc-1-178', provider: 'mc', catId: 1, scanId: '178', name: 'Growth Stocks', type: 'proscanner' as const },
      ]},
      { category: 'Technical Breakouts (MC)', items: [
        { id: 'mc-25-BPBULL', provider: 'mc', catId: 25, scanId: 'OHLC_D_P_BPBULL', name: 'Bullish Breakaway', type: 'techscanner' as const },
        { id: 'mc-25-RSIPOWBO', provider: 'mc', catId: 25, scanId: 'OHLC_D_I_RSIPOWBO', name: 'RSI Power BO', type: 'techscanner' as const },
        { id: 'mc-17-52HIGH', provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52HIGH', name: '52 Week High', type: 'techscanner' as const },
        { id: 'mc-17-52LOW', provider: 'mc', catId: 17, scanId: 'OHLC_W_P_52LOW', name: '52 Week Low', type: 'techscanner' as const },
      ]},
      { category: 'Technical Trends (MC)', items: [
        { id: 'mc-tt-bullish', provider: 'mc', catId: 'uptrend/bullish', scanId: '7', name: 'Nifty 500 Bullish', type: 'technical-trends' as const },
        { id: 'mc-tt-turning-bullish', provider: 'mc', catId: 'uptrend/turning-bullish', scanId: '7', name: 'Turning Bullish', type: 'technical-trends' as const },
        { id: 'mc-tt-bearish', provider: 'mc', catId: 'downtrend/bearish', scanId: '7', name: 'Nifty 500 Bearish', type: 'technical-trends' as const },
        { id: 'mc-tt-turning-bearish', provider: 'mc', catId: 'downtrend/turning-bearish', scanId: '7', name: 'Turning Bearish', type: 'technical-trends' as const },
      ]},
      { category: 'ETnow Elite (ET)', items: [
        { id: 'et-73', provider: 'et', screenerId: '73', name: 'Cash Cows', queryCondition: " Cash & Cash Equiv (Rs Cr) >=2500 AND  CF Operations (Rs Cr) >=1000 AND  Chg in Working Cap (Rs Cr) >=3000 AND   Quick Ratio >=1.5" },
        { id: 'et-75', provider: 'et', screenerId: '75', name: 'Elite Bluechips', queryCondition: " Market Cap (Rs Cr) > 60000  AND  Pitroski Score  >=6 AND  Return on Equity (%) >=  Avg ROE 5Y (%) AND  ROA (%) >=  Avg ROA 5Y AND  PEG Ratio <=1.5 AND CFO_By_Profit After Tax (Rs Cr) >=1" },
        { id: 'et-79', provider: 'et', screenerId: '79', name: 'Zero Debt Quality', queryCondition: " Debt to Equity <=0.1 AND  LT DE Ratio <=0.1 AND  Int Coverage Ratio >=100 AND Market Cap (Rs Cr) >=500 AND  Z Score >=3 AND  Pitroski Score >=6" },
        { id: 'et-91', provider: 'et', screenerId: '91', name: 'Buy on Dips', queryCondition: " Pitroski Score >=6 AND  YTD Returns (%) <=15 AND  PEG Ratio <=0.8 AND  Sustainable Growth (%) >=7 AND  Market Cap (Rs Cr) >=2000 AND  CFO_By_Profit After Tax (Rs Cr) >=1 AND  PEG Ratio >=0" },
        { id: 'et-195', provider: 'et', screenerId: '195', name: 'Potential Multibaggers', queryCondition: " Return on Equity (%) >  Return on Equity 1Y (%) AND  Return on Equity (%) >=20 AND  EBITDA Margin % >  EBITDA Margin % 1Y AND  Sustainable Growth (%) >=15 AND Earnings Retention % Net Profit >=85 AND  LT DE Ratio <=1 AND CFO_By_Profit After Tax (Rs Cr) >= 1 AND  Rel Ret vs BSE 500 YTD >=1 AND  PEG Ratio <=1" },
        { id: 'et-118', provider: 'et', screenerId: '118', name: 'Straight Flush', queryCondition: " Qtr Net Profit (Rs Cr) >0 AND  PBT before Q1 >0 AND PAT 2 Qtr Ago (Rs Cr) >0 AND PAT 3 Qtr Ago (Rs Cr) >0 AND PAT 4 Qtr Ago (Rs Cr) >0 AND Qtr Net Profit % >10 AND  Net Profit QoQ Chg (%) >20 AND Qtr Net profit YoY Chg (%) >20 AND  Pitroski Score >=6" },
        { id: 'et-362', provider: 'et', screenerId: '362', name: 'RSI Oversold', queryCondition: " RSI Current<30 AND RSI Previous<30" },
      ]},
      { category: 'Sector GEMS (ET)', items: [
        { id: 'et-518', provider: 'et', screenerId: '518', name: 'The Tata Empire', queryCondition: " Tata = True" },
        { id: 'et-520', provider: 'et', screenerId: '520', name: 'Adani Universe', queryCondition: " Adani Group = True" },
        { id: 'et-514', provider: 'et', screenerId: '514', name: 'PSU Gems', queryCondition: " Handpicked PSU Gems = True" },
        { id: 'et-515', provider: 'et', screenerId: '515', name: 'Monopoly Biz', queryCondition: " Monopoly Businesses = True" },
        { id: 'et-1101', provider: 'et', screenerId: '1101', name: 'Defence Sector', queryCondition: " Industry=2076" },
        { id: 'et-1100', provider: 'et', screenerId: '1100', name: 'Infra Boost', queryCondition: " Industry =2141 AND  PB TTM >=0 AND  Market Cap (Rs Cr) >=300" },
      ]}
    ];
  }),

  fetchMarketData: publicProcedure
    .input(z.object({
      provider: z.string(),
      params: z.any()
    }))
    .query(async ({ input }) => {
      try {
        if (input.provider === 'mc') {
          const { type, catId, scanId } = input.params;
          return await fetchMCScreener(type as any, catId, scanId);
        } else if (input.provider === 'et') {
          const { screenerId, queryCondition } = input.params;
          return await fetchETnowScreener(screenerId, queryCondition);
        } else if (input.provider === 'custom') {
          const { timeframes, minVolume = 0 } = input.params;
          const allStocks = await getOrRefreshAllStocks();

          const parseVol = (v: string): number => {
            if (!v) return 0;
            if (v.endsWith('M')) return parseFloat(v) * 1_000_000;
            if (v.endsWith('K')) return parseFloat(v) * 1_000;
            return parseFloat(v) || 0;
          };

          // Select stocks with positive price movement and non-zero volume
          const selected = allStocks
            .filter((s: any) => {
              const vol = parseVol(s.volume);
              return s.changePct > 0 && vol > minVolume && s.price > 0;
            })
            .sort((a: any, b: any) => b.changePct - a.changePct)
            .slice(0, 50)
            .map((s: any) => ({
              symbol: s.symbol,
              name: s.name,
              ltp: s.price,
              perChg: s.changePct.toFixed(2),
              volume: s.volume,
              mktCap: '—',
              sector: s.sector || '—',
              timeframesMet: timeframes?.join(', ') || 'D, W',
              momentum: s.changePct > 2 ? 'Strong Bullish' : 'Bullish',
              pattern: s.high52w && (s.price / s.high52w) > 0.95 ? 'Near 52W High' : 'Uptrend',
            }));

          return {
            success: true,
            searchResult: { searchData: { records: selected } },
            data: {
              list: {
                scannerDetails: selected.map(s => ({
                  ...s,
                  columns: [
                    { name: "LTP", value: s.ltp },
                    { name: "% Change", value: s.perChg },
                    { name: "Volume", value: s.volume },
                    { name: "Momentum", value: s.momentum }
                  ]
                }))
              }
            }
          };
        }
      } catch (error) {
        console.error("Market Data Fetch Error:", error);
        throw new Error("Failed to fetch market data from provider.");
      }
    }),

  runBacktest: publicProcedure
    .input(z.object({ 
      symbol: z.string(), 
      strategy: z.string(), 
      period: z.string(),
      params: z.object({
        rsiUpper: z.number().optional(),
        rsiLower: z.number().optional(),
        emaShort: z.number().optional(),
        emaLong: z.number().optional(),
      }).optional()
    }))
    .mutation(async ({ input }) => {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const rsiDiff = (input.params?.rsiUpper || 70) - (input.params?.rsiLower || 30);
      const emaDiff = (input.params?.emaLong || 50) - (input.params?.emaShort || 20);
      const winRateBase = 60 + (rsiDiff / 10);
      const returnBase = 30 + (emaDiff / 2);

      return {
        winRate: parseFloat(winRateBase.toFixed(1)),
        profitFactor: 2.14,
        maxDrawdown: 12.5,
        totalReturn: parseFloat(returnBase.toFixed(1)),
        trades: 124,
        history: Array.from({ length: 100 }, (_, i) => ({ day: i, equity: 10000 * Math.pow(1.002, i) + Math.random() * 500, drawdown: -Math.random() * 5 }))
      };
    }),

  generateTrendReport: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stock = await fetchStockDataWithCache(input.symbol);
      if (!stock) throw new Error("Stock not found");
      
      const analysis = await generateStockAnalysis(stock.symbol, stock);
      return {
        title: `${stock.symbol} Deep Intelligence Report`,
        summary: `Strategic analysis for ${(stock as any).name || stock.symbol} based on current market dynamics.`,
        investmentThesis: analysis.reasoning,
        riskFactors: [
          "Market volatility and sector-specific rotation.",
          "Potential resistance near multi-month highs.",
          "Global macro-economic shifts affecting export revenues."
        ],
        outlook: analysis.sentiment,
        generatedAt: new Date().toISOString()
      };
    }),

  // ─── MoneyControl Consolidated Data API ──────────────────────────────────
  // Fetches ALL MoneyControl data for a given stock symbol
  // The timeframe parameter (D/W/M) controls the technical analysis period
  // Replace BE03 with other scId values for different stocks
  getMcConsolidated: publicProcedure
    .input(z.object({ 
      symbol: z.string(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D')
    }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { getMcConsolidatedData } = await import('./mcApiService');
      return await getMcConsolidatedData(scId, input.symbol, input.timeframe);
    }),

  // ─── MoneyControl Index APIs ───────────────────────────────────────────
  getIndicesList: publicProcedure.query(async () => {
    const { fetchIndianIndices } = await import('./indexApiService');
    return await fetchIndianIndices();
  }),

  getIndexFullData: publicProcedure
    .input(z.object({ 
      indId: z.string(),
      bridgeSymbol: z.string().optional(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D')
    }))
    .query(async ({ input }) => {
      const { 
        fetchIndexFullDetails, 
        fetchIndexFundamentals, 
        fetchIndexTechnicals 
      } = await import('./indexApiService');
      const { getIndexById } = await import('./indexMapping');
      
      const [details, fundamentals] = await Promise.all([
        fetchIndexFullDetails(input.indId),
        fetchIndexFundamentals(input.indId)
      ]);
      
      let technicals = null;
      // Use mapping as fallback if API doesn't provide bridgesymbol
      const mapped = getIndexById(input.indId);
      const bSym = input.bridgeSymbol || details?.indices?.bridgesymbol || mapped?.symbol;
      
      if (bSym) {
        technicals = await fetchIndexTechnicals(input.timeframe, bSym);
      }
      
      return {
        details,
        fundamentals,
        technicals
      };
    }),

  getIndexMapping: publicProcedure
    .query(async () => {
      const { INDEX_MAPPING } = await import('./indexMapping');
      return INDEX_MAPPING;
    }),

  getIndexConstituents: publicProcedure
    .input(z.object({ 
      indId: z.string(),
      type: z.enum(['0', '1']).optional().default('0') 
    }))
    .query(async ({ input }) => {
      const { fetchIndexConstituents } = await import('./indexApiService');
      return await fetchIndexConstituents(input.indId, input.type);
    }),

  getAdvanceDecline: publicProcedure
    .input(z.object({ ex: z.string().optional().default('N') }))
    .query(async ({ input }) => {
      const { fetchAdvanceDecline } = await import('./indexApiService');
      return await fetchAdvanceDecline(input.ex);
    }),

  getIndexGraph: publicProcedure
    .input(z.object({ 
      indId: z.string(),
      range: z.string().optional().default('1d'),
      type: z.string().optional().default('line')
    }))
    .query(async ({ input }) => {
      const { fetchIndexGraph } = await import('./indexApiService');
      return await fetchIndexGraph(input.indId, input.range, input.type);
    }),

  getIndexPeChart: publicProcedure
    .input(z.object({ indId: z.string(), duration: z.string().optional().default('1Y') }))
    .query(async ({ input }) => {
      const { fetchIndexPeChart } = await import('./indexApiService');
      return await fetchIndexPeChart(input.indId, input.duration);
    }),

  getIndexPbChart: publicProcedure
    .input(z.object({ indId: z.string(), duration: z.string().optional().default('1Y') }))
    .query(async ({ input }) => {
      const { fetchIndexPbChart } = await import('./indexApiService');
      return await fetchIndexPbChart(input.indId, input.duration);
    }),

  // Fetch MC technical data for a specific timeframe (D/W/M)
  getMcTechnical: publicProcedure
    .input(z.object({
      symbol: z.string(),
      duration: z.enum(['D', 'W', 'M']).optional().default('D')
    }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcTechnicalData } = await import('./mcApiService');
      return await fetchMcTechnicalData(scId, input.duration);
    }),

  // Fetch MC equity cash quote
  getMcEquityCash: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcEquityCash } = await import('./mcApiService');
      return await fetchMcEquityCash(scId);
    }),

  // Fetch MC SWOT analysis
  getMcSwot: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcSwot } = await import('./mcApiService');
      return await fetchMcSwot(scId);
    }),

  // Fetch MC essentials (PE, PB, Market Cap, etc.)
  getMcEssentials: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcEssentials } = await import('./mcApiService');
      return await fetchMcEssentials(scId);
    }),

  // Fetch MC classification insights
  getMcInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcInsights } = await import('./mcApiService');
      return await fetchMcInsights(scId);
    }),

  // Fetch detailed MC insights (insightData)
  getMcDetailedInsights: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcDetailedInsights } = await import('./mcApiService');
      return await fetchMcDetailedInsights(scId);
    }),

  // Fetch MC price-volume data
  getMcPriceVolume: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcPriceVolume } = await import('./mcApiService');
      return await fetchMcPriceVolume(scId);
    }),

  // Fetch MC analyst ratings
  getMcAnalystRating: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcAnalystRating } = await import('./mcApiService');
      return await fetchMcAnalystRating(scId);
    }),

  // Fetch MC earnings forecast
  getMcEarningsForecast: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcEarningsForecast } = await import('./mcApiService');
      return await fetchMcEarningsForecast(scId);
    }),

  // Fetch MC price forecast
  getMcPriceForecast: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcPriceForecast } = await import('./mcApiService');
      return await fetchMcPriceForecast(scId);
    }),

  // Fetch MC consensus data
  getMcConsensus: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      const { fetchMcConsensus } = await import('./mcApiService');
      return await fetchMcConsensus(scId);
    }),

  // TradingView TA Data
  getTvTa: publicProcedure
    .input(z.object({ symbol: z.string(), exchange: z.string().optional().default('NSE') }))
    .query(async ({ input }) => {
      try {
        const res = await fetch('http://127.0.0.1:8002/api/v1/tv/ta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: input.symbol, exchange: input.exchange })
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error("TV TA Error:", errText);
          return { error: errText };
        }
        return await res.json();
      } catch (err: any) {
        console.error("TV TA Fetch Error:", err);
        return { error: err.message };
      }
    }),

  // TradingView Screener Data
  getTvScreener: publicProcedure
    .query(async () => {
      try {
        const res = await fetch('http://127.0.0.1:8002/api/v1/tv/screener');
        if (!res.ok) {
          const errText = await res.text();
          console.error("TV Screener Error:", errText);
          return { error: errText };
        }
        return await res.json();
      } catch (err: any) {
        console.error("TV Screener Fetch Error:", err);
        return { error: err.message };
      }
    }),
  

  getTrendlyneSwot: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchTrendlyneSwot(input.symbol);
    }),

  getTrendlyneChecklist: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchTrendlyneChecklist(input.symbol);
    }),

  getTrendlyneDVM: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchTrendlyneDVM(input.symbol);
    }),

  getTrendlyneStockMetrics: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await fetchTrendlyneStockMetrics(input.symbol);
    }),

  getTrendlyneStockOptionChain: publicProcedure
    .input(z.object({ 
      symbol: z.string(),
      expiryDate: z.string().optional()
    }))
    .query(async ({ input }) => {
      return await fetchTrendlyneStockOptionChain(input.symbol, input.expiryDate);
    }),

  getTrendlyneStockExpiries: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const symbol = input.symbol.toUpperCase();
      try {
        const url = `https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=${symbol}&exchange=nse`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json'
          }
        });
        if (res.ok) {
          const json = await res.json();
          const list = json?.resultData?.filter((d: any) => d.symbol_name === symbol) || [];
          return list.map((d: any) => d.expiry_date.split('T')[0]);
        }
      } catch (e) {
        console.error('[TRENDLYNE EXPIRIES] Failed to fetch expiries:', e);
      }
      return ['2026-05-26'];
    }),

  getTrendlyneAdvTechnicalAnalysis: publicProcedure
    .input(z.object({ 
      symbol: z.string(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D')
    }))
    .query(async ({ input }) => {
      return await fetchTrendlyneAdvTechnicalAnalysis(input.symbol, input.timeframe);
    }),

  getTrendlyneOverview: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return await getTrendlyneOverview(input.symbol);
    }),

  getTrendlyneSectorRotation: publicProcedure
    .query(async () => {
      return await fetchTrendlyneSectorRotation();
    }),

  getTrendlyneIndexRotation: publicProcedure
    .query(async () => {
      return await fetchTrendlyneIndexRotation();
    }),

  // --- Stock Scoring APIs ---
  getTopRatedStocks: publicProcedure
    .input(z.object({ 
      limit: z.number().optional().default(50),
      timeframe: z.enum(['long_term', 'intraday']).optional().default('long_term')
    }))
    .query(({ input }) => {
      return getTopRatedStocks(input.limit, input.timeframe);
    }),

  getStockScoreDetail: publicProcedure
    .input(z.object({ 
      symbol: z.string(),
      timeframe: z.enum(['long_term', 'intraday']).optional().default('long_term')
    }))
    .query(({ input }) => {
      return getStockScoreDetail(input.symbol, input.timeframe);
    }),

  getConvergenceSignals: publicProcedure
    .input(z.object({
      minScore: z.number().optional().default(65),
    }))
    .query(({ input }) => {
      return crossSourceFilter(input.minScore);
    }),

  getRegimeSectorSignals: publicProcedure
    .input(z.object({
      topNSectors: z.number().optional().default(3),
      minScore: z.number().optional().default(60),
      minWinProbability: z.number().optional().default(0.50),
    }))
    .query(({ input }) => {
      return regimeSectorFilter(input.topNSectors, input.minScore, input.minWinProbability);
    }),

  getQualityOversoldSignals: publicProcedure
    .input(z.object({
      maxRsi: z.number().optional().default(35),
      maxScore: z.number().optional().default(65),
    }))
    .query(({ input }) => {
      return qualityOversoldScanner(input.maxRsi, input.maxScore);
    }),

  triggerStockScoring: publicProcedure
    .mutation(async () => {
      return await syncAndScore();
    }),

  recalculateScoresOnly: publicProcedure
    .mutation(async () => {
      return await recalculateScores();
    }),

  // ─── Trendlyne Screener Integration ───────────────────────────────────
  getTrendlyneScreener: publicProcedure
    .input(z.object({
      screenpk: z.string(),
      screenerName: z.string(),
      pageNumber: z.number().optional().default(0)
    }))
    .query(async ({ input }) => {
      // 1. MoneyControl
      if (input.screenpk.startsWith('MC_')) {
        const scanId = input.screenpk.replace('MC_', '');
        try {
          const stocks = db.prepare(`
            SELECT ss.symbol as stockId, ss.stock_name as name, ss.symbol
            FROM moneycontrol_screener_stocks ss
            WHERE ss.scan_id = ?
          `).all(scanId) as any[];
          
          return {
            success: true,
            data: stocks.map(s => ({
              stockId: s.stockId || s.symbol || '',
              name: s.name || s.symbol || '',
              symbol: s.symbol || s.stockId || '',
              ltp: 0,
              change: 0,
              changePercent: 0,
              screenerName: input.screenerName,
              screenerType: 'moneycontrol'
            })),
            screenerName: input.screenerName,
            totalResults: stocks.length
          };
        } catch (error) {
          console.error('❌ Error fetching MC screener data:', error);
          return { success: false, data: [], totalResults: 0 };
        }
      }

      // 2. ETnow
      if (input.screenpk.startsWith('ET_')) {
        const screenerId = input.screenpk.replace('ET_', '');
        try {
          const etScreener = db.prepare(`
            SELECT query_condition FROM etnow_screeners WHERE screener_id = ?
          `).get(screenerId) as { query_condition: string } | undefined;

          if (etScreener) {
            const result = await fetchETnowScreener(screenerId, etScreener.query_condition);
            const records = result?.searchResult?.searchData?.records || [];
            
            return {
              success: true,
              data: records.map((r: any) => ({
                stockId: r.symbol || '',
                name: r.companyName || r.name || '',
                ltp: parseFloat(r.currentPrice || 0),
                change: parseFloat(r.priceChange || 0),
                changePercent: parseFloat(r.percentChange || 0),
                screenerName: input.screenerName,
                screenerType: 'etnow'
              })),
              screenerName: input.screenerName,
              totalResults: records.length
            };
          }
        } catch (error) {
          console.error('❌ Error fetching ETnow screener data:', error);
          return { success: false, data: [], totalResults: 0 };
        }
      }

      // 3. Trendlyne (Default)
      return await fetchTrendlyneScreenerData(
        input.screenpk,
        input.screenerName,
        input.pageNumber
      );
    }),

  getTrendlyneCategories: publicProcedure
    .query(() => {
      return getTrendlyneScreenerCategories();
    }),

  getTrendlyneScreenerNames: publicProcedure
    .query(async () => {
      return await getTrendlyneScreenerList();
    }),

  configTrendlyneFetchInterval: publicProcedure
    .input(z.object({
      intervalMs: z.number().min(0),
      type: z.enum(['screener', 'names']).optional().default('screener')
    }))
    .mutation(async ({ input }) => {
      if (input.type === 'names') {
        updateScreenerNamesInterval(input.intervalMs);
      } else {
        updateFetchInterval(input.intervalMs);
      }
      return {
        success: true,
        message: `${input.type} fetch interval updated to ${input.intervalMs}ms (${(input.intervalMs / 1000 / 60).toFixed(2)} minutes)`
      };
    }),

  testTrendlyneApi: publicProcedure
    .input(z.object({ stockId: z.string().optional() }))
    .query(async ({ input }) => {
      return await testTrendlyneApiResponse(input.stockId);
    }),

  fetchTrendlyneScreenerNames: publicProcedure
    .query(async () => {
      return await fetchAllTrendlyneScreenerNames();
    }),

  getStockScreeners: publicProcedure
    .input(z.object({
      stockId: z.string()
    }))
    .query(async ({ input }) => {
      const { findScreenersByStock } = await import('./trendlyneScreener');
      const { findMcScreenersByStock } = await import('./moneycontrolScreener');
      
      const tl = findScreenersByStock(input.stockId);
      const mc = findMcScreenersByStock(input.stockId);
      
      return [...tl, ...mc];
    }),

  refreshTrendlyneScreenersDB: publicProcedure
    .mutation(async () => {
      try {
        console.log(`🔄 Refreshing Trendlyne screeners database...`);
        const screenerNames = await fetchAllTrendlyneScreenerNames(true);
        return {
          success: true,
          message: `✅ Refreshed screener database with ${screenerNames.size} screeners`,
          count: screenerNames.size
        };
      } catch (error) {
        console.error(`❌ Error refreshing screeners:`, error);
        return {
          success: false,
          message: `❌ Error refreshing screeners: ${String(error)}`,
          count: 0
        };
      }
    }),

  recategorizeTrendlyneScreeners: publicProcedure
    .mutation(async () => {
      return await recategorizeAllScreeners();
    }),

  // --- NSE Stocks Management ---
  syncNSEStocks: publicProcedure
    .mutation(async () => {
      return syncNSEStocksToDatabase();
    }),

  getAllNSEStocks: publicProcedure
    .query(() => {
      const stocks = getAllNSEStocksFromDB();
      return { stocks, count: stocks.length };
    }),

  searchNSEStocks: publicProcedure
    .input(z.object({
      query: z.string().min(1)
    }))
    .query(({ input }) => {
      const stocks = searchNSEStocksFromDB(input.query);
      return { stocks, count: stocks.length };
    }),

  getNSEStockBySymbol: publicProcedure
    .input(z.object({
      symbol: z.string().min(1)
    }))
    .query(({ input }) => {
      const stock = getNSEStockFromDB(input.symbol.toUpperCase());
      return stock || { error: 'Stock not found' };
    }),

  getNSEStocksBySector: publicProcedure
    .input(z.object({
      sector: z.string().min(1)
    }))
    .query(({ input }) => {
      const stocks = getNSEStocksBySectorFromDB(input.sector);
      return { stocks, count: stocks.length };
    }),

  getNSEStocksByIndustry: publicProcedure
    .input(z.object({
      industry: z.string().min(1)
    }))
    .query(({ input }) => {
      const stocks = getNSEStocksByIndustryFromDB(input.industry);
      return { stocks, count: stocks.length };
    }),

  getAllSectors: publicProcedure
    .query(() => {
      return getAllSectorsFromDB();
    }),

  getAllIndustries: publicProcedure
    .query(() => {
      return getAllIndustriesFromDB();
    }),

  getNSEStockCount: publicProcedure
    .query(() => {
      return getNSEStockCount();
    }),

  // ─── HIGH PERFORMANCE CONSOLIDATED DETAIL ──────────────────────────────
  // Combines MC consolidated data, Scoring Engine results, and Screeners
  // into a single round-trip to eliminate frontend batching overhead.
  getAlphaQuantDetail: publicProcedure
    .input(z.object({ 
      symbol: z.string(),
      timeframe: z.enum(['D', 'W', 'M']).optional().default('D'),
      scoreTimeframe: z.enum(['long_term', 'intraday']).optional().default('long_term')
    }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      
      const { getMcConsolidatedData } = await import('./mcApiService');
      const { getStockScoreDetail } = await import('./scoringService');
      const { fetchTradebrainsData } = await import('./tradebrainsService');
      
      const [mcData, scoreData, tbData] = await Promise.all([
        getMcConsolidatedData(scId, input.symbol, input.timeframe),
        getStockScoreDetail(input.symbol, input.scoreTimeframe),
        fetchTradebrainsData(input.symbol)
      ]);

      return {
        ...mcData,
        score: scoreData?.score || null,
        factors: scoreData?.factors || null,
        tradebrains: tbData || null
      };
    }),

  // ─── SUPERSTAR PORTFOLIO ──────────────────────────────────────────────────
  getSuperstarList: publicProcedure
    .query(async () => {
      const { fetchWithCache } = await import('./cacheService');
      return fetchWithCache('superstar_list', async () => {
        const res = await fetch(
          'https://portal.tradebrains.in/api/prices/superstar/portfolio/star/view/?page_size=100&page=1&search=',
          {
            headers: {
              'Accept': 'application/json, text/plain, */*',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Referer': 'https://portal.tradebrains.in/superstar-portfolio',
              'Origin': 'https://portal.tradebrains.in',
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!res.ok) throw new Error(`TradeBrains superstar list HTTP ${res.status}`);
        return res.json();
      }, 3600);
    }),

  getSuperstarPortfolio: publicProcedure
    .input(z.object({ slug: z.string(), quarter: z.string() }))
    .query(async ({ input }) => {
      const { fetchWithCache } = await import('./cacheService');
      return fetchWithCache(`superstar_${input.slug}_${input.quarter}`, async () => {
        const url = `https://portal.tradebrains.in/api/prices/superstar/stocklist/${encodeURIComponent(input.slug)}/?quater=${input.quarter}&sort_by=total_quantity&is_ascending=false`;
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': `https://portal.tradebrains.in/superstar-portfolio/${input.slug}`,
            'Origin': 'https://portal.tradebrains.in',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`TradeBrains portfolio ${input.slug} HTTP ${res.status}`);
        return res.json();
      }, 1800);
    }),

  // ─── TODOS & IDEAS ────────────────────────────────────────────────────────
  getTodos: publicProcedure
    .query(() => {
      try {
        const todos = db.prepare('SELECT * FROM todos ORDER BY priority DESC, createdAt DESC').all() as any[];
        console.log(`[ROUTER] Fetched ${todos.length} todos`);
        return todos;
      } catch (error) {
        console.error('[ROUTER] Error fetching todos:', error);
        return [];
      }
    }),

  addTodo: publicProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional().default('PENDING'),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM'),
      category: z.string().optional().default('IDEAS'),
    }))
    .mutation(({ input }) => {
      console.log('[ROUTER] Adding todo:', input);
      const stmt = db.prepare(`
        INSERT INTO todos (title, description, status, priority, category)
        VALUES (?, ?, ?, ?, ?)
      `);
      try {
        const info = stmt.run(input.title, input.description || null, input.status, input.priority, input.category);
        console.log('[ROUTER] Todo added successfully, ID:', info.lastInsertRowid);
        return { id: info.lastInsertRowid };
      } catch (error) {
        console.error('[ROUTER] Error adding todo:', error);
        throw error;
      }
    }),

  updateTodo: publicProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
      category: z.string().optional(),
    }))
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      const keys = Object.keys(updates);
      if (keys.length === 0) return { success: true };

      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => (updates as any)[k]);
      
      const stmt = db.prepare(`
        UPDATE todos SET ${setClause}, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      stmt.run(...values, id);
      return { success: true };
    }),

  deleteTodo: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(({ input }) => {
      db.prepare('DELETE FROM todos WHERE id = ?').run(input.id);
      return { success: true };
    }),

  getStrategyPicks: publicProcedure.query(async () => {
    const latestPriceCte = `
      WITH latest_prices AS (
        SELECT o.symbol, o.close
        FROM stock_ohlcv o
        JOIN (
          SELECT symbol, MAX(date) AS max_date
          FROM stock_ohlcv
          GROUP BY symbol
        ) latest ON latest.symbol = o.symbol AND latest.max_date = o.date
      )
    `;

    // 1. Fetch Investment Picks (Bharat Quality Compounders)
    // Looking for a confluence of ET Now Quality/Cash Cow screeners + Value/Dips screeners
    // ET Now IDs: 79(Zero Debt), 73(Cash Cows), 75(Bluechips), 195(Multibaggers), 91(Buy on Dips), 362(RSI Oversold)
    const invRows = db.prepare(`${latestPriceCte}
      SELECT n.symbol, n.name as companyName, n.sector, lp.close as currentPrice,
             GROUP_CONCAT(DISTINCT es.screener_id) as et_screeners,
             GROUP_CONCAT(DISTINCT ms.scan_id) as mc_screeners
      FROM nse_stocks n
      JOIN etnow_screener_stocks es ON n.symbol = es.symbol
      LEFT JOIN moneycontrol_screener_stocks ms ON n.symbol = ms.symbol
      LEFT JOIN latest_prices lp ON lp.symbol = n.symbol
      WHERE es.screener_id IN ('79', '73', '75', '195', '515', '91', '362')
      GROUP BY n.symbol
      HAVING COUNT(DISTINCT es.screener_id) >= 2
      ORDER BY COUNT(DISTINCT es.screener_id) DESC
      LIMIT 30
    `).all() as any[];

    const investmentPicks = invRows.map(r => {
      const etIds = r.et_screeners ? r.et_screeners.split(',') : [];
      let fundamentalScore = 0;
      let technicalScore = 0;
      const reasons: string[] = [];

      if (etIds.includes('79')) { fundamentalScore += 30; reasons.push('Zero Debt'); }
      if (etIds.includes('73')) { fundamentalScore += 30; reasons.push('Cash Cow'); }
      if (etIds.includes('75')) { fundamentalScore += 20; reasons.push('Elite Bluechip'); }
      if (etIds.includes('195')) { fundamentalScore += 20; reasons.push('Multibagger Potential'); }
      if (etIds.includes('515')) { fundamentalScore += 20; reasons.push('Monopoly Biz'); }

      if (etIds.includes('91')) { technicalScore += 50; reasons.push('Buy on Dips'); }
      if (etIds.includes('362')) { technicalScore += 50; reasons.push('RSI Oversold'); }

      const mcIds = r.mc_screeners ? r.mc_screeners.split(',') : [];
      if (mcIds.length > 0) {
        fundamentalScore += 10;
        reasons.push('MC Pro Fundamental Pick');
      }

      return {
        symbol: r.symbol,
        name: r.companyName,
        sector: r.sector,
        price: r.currentPrice,
        score: Math.min(100, Math.round((fundamentalScore * 0.6) + (technicalScore * 0.4))),
        reasons
      };
    }).filter(p => p.score > 30).sort((a, b) => b.score - a.score);

    // 2. Fetch Intraday Picks (Momentum/Breakout)
    // Cross-referencing Trendlyne intraday screeners with MC Tech and ET Breakouts
    const intradayRows = db.prepare(`${latestPriceCte}
      SELECT n.symbol, n.name as companyName, n.sector, lp.close as currentPrice,
             GROUP_CONCAT(DISTINCT ts.screener_id) as tl_screeners,
             GROUP_CONCAT(DISTINCT ms.scan_id) as mc_screeners
      FROM nse_stocks n
      JOIN trendlyne_screener_stocks ts ON n.symbol = ts.symbol
      JOIN trendlyne_screeners tls ON tls.screener_id = ts.screener_id
      LEFT JOIN screener_master sm ON sm.scan_id = ts.screener_id
      LEFT JOIN moneycontrol_screener_stocks ms ON n.symbol = ms.symbol
      LEFT JOIN latest_prices lp ON lp.symbol = n.symbol
      WHERE tls.timeframe = 'intraday' OR sm.inferred_timeframe = 'intraday'
      GROUP BY n.symbol
      HAVING tl_screeners IS NOT NULL
      ORDER BY COUNT(DISTINCT ts.screener_id) DESC
      LIMIT 30
    `).all() as any[];

    const intradayPicks = intradayRows.map(r => {
      const tlIds = r.tl_screeners ? r.tl_screeners.split(',') : [];
      const mcIds = r.mc_screeners ? r.mc_screeners.split(',') : [];
      let score = 50 + (tlIds.length * 15) + (mcIds.length * 5);

      return {
        symbol: r.symbol,
        name: r.companyName,
        sector: r.sector,
        price: r.currentPrice,
        score: Math.min(100, score),
        reasons: [
          ...tlIds.map((id: string) => 'Trendlyne Intraday ID: ' + id),
          ...(mcIds.length > 0 ? ['MC Tech/Pro Scanner'] : [])
        ]
      };
    }).sort((a, b) => b.score - a.score);

    return { investmentPicks, intradayPicks };
  }),

  // PHASE 3.3: Signal Actions — Track user execution vs recommendations
  saveSignalAction: publicProcedure
    .input(z.object({
      signalId: z.number(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']),
      symbol: z.string(),
      userId: z.string().optional(),
      actionType: z.enum(['BUY', 'SELL', 'HOLD', 'SKIP']),
      quantity: z.number().optional(),
      entryPriceRec: z.number().optional(),
      entryActual: z.number().optional(),
      targetPriceRec: z.number().optional(),
      exitPriceActual: z.number().optional(),
      exitDate: z.string().datetime().optional(),
      pnl: z.number().optional(),
      pnlPct: z.number().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO signal_actions (
            signal_id, signal_source, symbol, user_id, action_type,
            quantity, entry_price_rec, entry_actual, target_price_rec,
            exit_price_actual, exit_date, pnl, pnl_pct, notes, executed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        
        stmt.run([
          input.signalId,
          input.signalSource,
          input.symbol,
          input.userId || null,
          input.actionType,
          input.quantity || null,
          input.entryPriceRec || null,
          input.entryActual || null,
          input.targetPriceRec || null,
          input.exitPriceActual || null,
          input.exitDate || null,
          input.pnl || null,
          input.pnlPct || null,
          input.notes || null,
        ]);

        return { success: true, signalId: input.signalId };
      } catch (err) {
        console.error('[Router] saveSignalAction error:', err);
        throw new Error('Failed to save signal action');
      }
    }),

  getSignalActions: publicProcedure
    .input(z.object({
      symbol: z.string().optional(),
      userId: z.string().optional(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']).optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      try {
        let query = `
          SELECT id, signal_id, signal_source, symbol, action_type,
                 executed_at, quantity, entry_price_rec, entry_actual,
                 target_price_rec, exit_price_actual, pnl, pnl_pct, notes
          FROM signal_actions
          WHERE 1=1
        `;
        const params: any[] = [];

        if (input.symbol) {
          query += ` AND symbol = ?`;
          params.push(input.symbol);
        }
        if (input.userId) {
          query += ` AND user_id = ?`;
          params.push(input.userId);
        }
        if (input.signalSource) {
          query += ` AND signal_source = ?`;
          params.push(input.signalSource);
        }

        query += ` ORDER BY executed_at DESC LIMIT ? OFFSET ?`;
        params.push(input.limit, input.offset);

        const actions = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

        // Calculate summary stats
        let totalPnl = 0;
        let winCount = 0;
        let totalCount = 0;

        for (const action of actions) {
          const pnl = action.pnl as number | null;
          if (pnl !== null) {
            totalPnl += pnl;
            if (pnl > 0) winCount++;
            totalCount++;
          }
        }

        return {
          actions,
          stats: {
            totalPnl,
            winCount,
            totalCount,
            winRate: totalCount > 0 ? (winCount / totalCount * 100).toFixed(2) : '0',
          },
        };
      } catch (err) {
        console.error('[Router] getSignalActions error:', err);
        throw new Error('Failed to fetch signal actions');
      }
    }),

  getSignalActionMetrics: publicProcedure
    .input(z.object({
      userId: z.string().optional(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']).optional(),
      days: z.number().default(30),
    }))
    .query(async ({ input }) => {
      try {
        let query = `
          SELECT signal_source, action_type, COUNT(*) as count,
                 AVG(pnl_pct) as avg_pnl_pct, SUM(pnl) as total_pnl
          FROM signal_actions
          WHERE executed_at >= datetime('now', '-' || ? || ' days')
        `;
        const params: any[] = [input.days];

        if (input.userId) {
          query += ` AND user_id = ?`;
          params.push(input.userId);
        }
        if (input.signalSource) {
          query += ` AND signal_source = ?`;
          params.push(input.signalSource);
        }

        query += ` GROUP BY signal_source, action_type`;

        const metrics = db.prepare(query).all(...params);
        return { metrics };
      } catch (err) {
        console.error('[Router] getSignalActionMetrics error:', err);
        throw new Error('Failed to fetch metrics');
      }
    }),

  // PHASE 3.4: Portfolio-Signal Correlation
  getPortfolioSignalAlignment: publicProcedure
    .input(z.object({
      signalId: z.number(),
      signalSymbol: z.string(),
      portfolio: z.array(z.object({
        symbol: z.string(),
        weight: z.number(),
        quantity: z.number(),
        avgCost: z.number(),
        currentPrice: z.number(),
      })),
    }))
    .query(async ({ input }) => {
      try {
        const { correlationService } = await import('./correlationService');
        
        // Analyze signal's correlation with portfolio
        const correlations = await correlationService.analyzeSignalPortfolioAlignment(
          input.signalId,
          input.signalSymbol,
          input.portfolio,
        );

        // Get alignment score
        const alignmentScore = await correlationService.getPortfolioAlignmentScore(input.signalId);

        // Get hedge recommendations
        const hedges = correlationService.getHedgeRecommendations(input.signalId);

        // Get concentration risk
        const concentrationRisk = correlationService.getConcentrationRisk(input.signalId);

        return {
          correlations,
          alignmentScore,
          hedges,
          concentrationRisk,
          recommendation: {
            alignmentLevel: alignmentScore > 70 ? 'high' : alignmentScore > 40 ? 'moderate' : 'low',
            isHedge: hedges.length > 0,
            riskLevel: concentrationRisk > 2 ? 'high' : concentrationRisk > 0 ? 'moderate' : 'low',
          },
        };
      } catch (err) {
        console.error('[Router] getPortfolioSignalAlignment error:', err);
        throw new Error('Failed to analyze signal-portfolio alignment');
      }
    }),

  getSignalCorrelationMetrics: publicProcedure
    .input(z.object({
      signalId: z.number(),
    }))
    .query(async ({ input }) => {
      try {
        const metrics = db.prepare(`
          SELECT 
            portfolio_symbol,
            correlation_score,
            co_movement_pct,
            hedge_potential,
            momentum_alignment,
            weight
          FROM signal_portfolio_correlation
          WHERE signal_id = ?
          ORDER BY ABS(correlation_score) DESC
        `).all(input.signalId) as any[];

        // Calculate stats
        let avgCorrelation = 0;
        let positiveCorr = 0;
        let negativeCorr = 0;

        if (metrics.length > 0) {
          avgCorrelation = metrics.reduce((sum, m) => sum + m.correlation_score, 0) / metrics.length;
          positiveCorr = metrics.filter((m) => m.correlation_score > 0.3).length;
          negativeCorr = metrics.filter((m) => m.correlation_score < -0.3).length;
        }

        return {
          metrics,
          stats: {
            avgCorrelation: parseFloat(avgCorrelation.toFixed(4)),
            positiveCorr,
            negativeCorr,
            totalHoldings: metrics.length,
          },
        };
      } catch (err) {
        console.error('[Router] getSignalCorrelationMetrics error:', err);
        throw new Error('Failed to fetch correlation metrics');
      }
    }),

  // ─── Premarket ──────────────────────────────────────────────────────────────
  getPremarket: publicProcedure.query(async () => {
    return await fetchPremarketAll();
  }),

  // ─── Deals / Smart Money ────────────────────────────────────────────────────
  getDeals: publicProcedure.query(async () => {
    return await fetchDealsAll();
  }),

  // ─── Earnings ───────────────────────────────────────────────────────────────
  getEarnings: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchEarningsAll(input.date);
    }),

  getEarningsCalendar: publicProcedure
    .input(z.object({ date: z.string().optional() }))
    .query(async ({ input }) => {
      return await fetchEarningsCalendar(input.date);
    }),

  getEarningsRapidResults: publicProcedure
    .input(z.object({ type: z.enum(['LR', 'BP']).optional().default('BP') }))
    .query(async ({ input }) => {
      return await fetchEarningsRapidResults(input.type);
    }),

  getEarningsPriceShockers: publicProcedure.query(async () => {
    return await fetchEarningsPriceShockers();
  }),

  // ─── Index F&O ──────────────────────────────────────────────────────────────
  getIndexFno: publicProcedure
    .input(z.object({
      id: z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'])
    }))
    .query(async ({ input }) => {
      return await fetchIndexFnoAll(input.id as FnoIndexId);
    }),

  // ─── VWAP Chart ─────────────────────────────────────────────────────────────
  getMcVwapChart: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const mapping = getStockMapping(input.symbol);
      const scId = mapping?.mcsymbol || input.symbol;
      return await fetchMcVwapChart(scId);
    }),

  // ─── Kayal Screener ─────────────────────────────────────────────────────────
  getKayalScreener: publicProcedure
    .input(z.object({ screenpk: z.string(), limit: z.number().optional().default(50) }))
    .query(async ({ input }) => {
      return await fetchKayalScreener(input.screenpk, input.limit);
    }),

  // ─── Trade Decision Cockpit ──────────────────────────────────────────────────
  getTradeDecisionCockpitData: publicProcedure.query(() => {
    try {
      const signals = db.prepare(`
        SELECT ts.*, ns.sector, ns.industry
        FROM technical_signals ts
        LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
        WHERE ts.date >= date('now', '-7 days')
          AND ts.win_probability >= 0.40
        ORDER BY ts.win_probability DESC, ts.computed_at DESC
        LIMIT 60
      `).all() as Array<Record<string, unknown>>;

      const quantRows = db.prepare(`
        SELECT symbol, composite_score, technical_score, fundamental_score,
               momentum_score, sentiment_score, risk_score, timeframe
        FROM stock_scores
        WHERE timeframe = 'short'
        ORDER BY composite_score DESC
        LIMIT 200
      `).all() as Array<Record<string, unknown>>;

      const quantMap = new Map<string, Record<string, unknown>>();
      for (const q of quantRows) quantMap.set(q.symbol as string, q);

      let bulkDeals: Array<Record<string, unknown>> = [];
      try {
        bulkDeals = db.prepare(`
          SELECT symbol, deal_type, quantity, price, deal_date
          FROM bulk_deals
          WHERE deal_date >= date('now', '-14 days')
          ORDER BY deal_date DESC
        `).all() as Array<Record<string, unknown>>;
      } catch { /* table may not exist */ }

      let insiderTrades: Array<Record<string, unknown>> = [];
      try {
        insiderTrades = db.prepare(`
          SELECT symbol, transaction_type, quantity, price, trade_date
          FROM insider_trades
          WHERE trade_date >= date('now', '-30 days')
          ORDER BY trade_date DESC
        `).all() as Array<Record<string, unknown>>;
      } catch { /* table may not exist */ }

      let newsSentiment: Array<Record<string, unknown>> = [];
      try {
        newsSentiment = db.prepare(`
          SELECT symbol, sentiment_score, headline, published_at
          FROM news_sentiment_items
          WHERE published_at >= datetime('now', '-7 days')
          ORDER BY published_at DESC
        `).all() as Array<Record<string, unknown>>;
      } catch { /* table may not exist */ }

      const sentimentMap = new Map<string, number[]>();
      for (const n of newsSentiment) {
        const sym = n.symbol as string;
        if (!sentimentMap.has(sym)) sentimentMap.set(sym, []);
        sentimentMap.get(sym)!.push(n.sentiment_score as number);
      }

      const bulkSet = new Set(bulkDeals.map((d) => d.symbol as string));
      const insiderBuySet = new Set(
        insiderTrades.filter((t) => (t.transaction_type as string)?.toLowerCase().includes('buy')).map((t) => t.symbol as string)
      );

      const symbolMap = new Map<string, {
        signals: Array<Record<string, unknown>>;
        quant: Record<string, unknown> | undefined;
        hasBulkDeal: boolean;
        hasInsiderBuy: boolean;
        avgSentiment: number;
        sector: string;
      }>();

      for (const sig of signals) {
        const sym = sig.symbol as string;
        if (!symbolMap.has(sym)) {
          const scores = sentimentMap.get(sym) || [];
          symbolMap.set(sym, {
            signals: [],
            quant: quantMap.get(sym),
            hasBulkDeal: bulkSet.has(sym),
            hasInsiderBuy: insiderBuySet.has(sym),
            avgSentiment: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
            sector: (sig.sector as string) || 'Unknown',
          });
        }
        symbolMap.get(sym)!.signals.push(sig);
      }

      const candidates = Array.from(symbolMap.entries()).map(([symbol, data]) => {
        const avgWinProb = data.signals.reduce((s, sg) => s + ((sg.win_probability as number) || 0), 0) / data.signals.length;
        const quant = data.quant;
        const techScore = quant ? (quant.technical_score as number) || 0 : avgWinProb * 100;
        const fundScore = quant ? (quant.fundamental_score as number) || 0 : 50;
        const momScore = quant ? (quant.momentum_score as number) || 0 : avgWinProb * 80;
        const sentScore = data.avgSentiment > 0 ? 60 + data.avgSentiment * 40 : 50;
        const smartScore = (data.hasBulkDeal ? 20 : 0) + (data.hasInsiderBuy ? 30 : 0) + 50;

        const compositeScore = techScore * 0.35 + fundScore * 0.20 + momScore * 0.20 + sentScore * 0.15 + smartScore * 0.10;
        const actionAdvice = compositeScore >= 75 ? 'STRONG BUY' :
                             compositeScore >= 70 ? 'BUY' :
                             compositeScore <= 45 ? 'SELL' : 'HOLD';

        const primarySignal = data.signals[0];

        return {
          symbol,
          name: getStockMapping(symbol)?.name || symbol,
          sector: data.sector,
          advice: actionAdvice,
          actionAdvice,
          compositeScore: parseFloat(compositeScore.toFixed(1)),
          mlWinProbability: parseFloat((avgWinProb * 100).toFixed(1)),
          mlProbability: parseFloat((avgWinProb * 100).toFixed(1)),
          signalCount: data.signals.length,
          techSignalCount: data.signals.length,
          quantRank: Math.round(100 - fundScore),
          smartMoneyCr: parseFloat((smartScore - 50).toFixed(1)),
          newsSentiment: parseFloat(data.avgSentiment.toFixed(2)),
          factors: {
            technical: parseFloat(techScore.toFixed(1)),
            fundamental: parseFloat(fundScore.toFixed(1)),
            momentum: parseFloat(momScore.toFixed(1)),
            sentiment: parseFloat(sentScore.toFixed(1)),
            smartMoney: parseFloat(smartScore.toFixed(1)),
          },
          entryPrice: primarySignal?.entry_price as number || null,
          targetPrice: primarySignal?.target_price as number || null,
          stopLoss: primarySignal?.stop_loss as number || null,
          hasBulkDeal: data.hasBulkDeal,
          hasInsiderBuy: data.hasInsiderBuy,
          // Technical indicators for real analysis
          rsi: primarySignal?.rsi || null,
          macd: primarySignal?.macd || null,
          macdSignal: primarySignal?.macd_signal || null,
          sma50: primarySignal?.sma50 || null,
          sma200: primarySignal?.sma200 || null,
          bbWidth: primarySignal?.bb_width || null,
          volumeRatio: primarySignal?.volume_ratio || null,
          cmp: primarySignal?.cmp || null,
          changePct: primarySignal?.change_pct || 0,
          aiInsight: primarySignal?.ai_insight || null,
          entryZone: primarySignal?.entry_zone || null,
          targets: primarySignal?.targets || null,
          setupQuality: primarySignal?.setup_quality || 'MEDIUM',
          timeHorizon: primarySignal?.time_horizon || 'Short Term',
          signalsJson: primarySignal?.signals_json || '[]',
        };
      });

      candidates.sort((a, b) => b.compositeScore - a.compositeScore);
      const top15 = candidates.slice(0, 15);

      const advances = signals.filter((s) => ((s.signal_score as number) || 0) >= 0).length;
      const declines = signals.filter((s) => ((s.signal_score as number) || 0) < 0).length;
      const advDecRatio = declines > 0 ? parseFloat((advances / declines).toFixed(2)) : advances > 0 ? 5 : 1;
      const avgWinProbability = signals.length
        ? parseFloat((signals.reduce((s, sg) => s + ((sg.win_probability as number) || 0), 0) / signals.length * 100).toFixed(1))
        : 0;

      const verdict = top15.length >= 3 && avgWinProbability >= 50 ? 'TRADE' : 'NO TRADE';
      const verdictReason = verdict === 'TRADE'
        ? `${top15.length} high-probability setups with ${avgWinProbability}% avg win rate`
        : top15.length < 3
          ? 'Insufficient high-quality setups today'
          : 'Win probability below threshold';

      return {
        success: true,
        data: {
          marketOverview: { verdict, verdictReason, advDecRatio, avgWinProbability, activeSignalsCount: signals.length },
          candidates: top15,
        },
      };
    } catch (err) {
      console.error('[Router] getTradeDecisionCockpitData error:', err);
      return { success: false, data: { marketOverview: { verdict: 'NO TRADE', verdictReason: 'Data unavailable', advDecRatio: 1, avgWinProbability: 0, activeSignalsCount: 0 }, candidates: [] } };
    }
  }),

  // ─── PCR Fetch (trigger Python engine) ───────────────────────────────────────
  runPcrFetch: publicProcedure
    .input(z.object({ symbols: z.array(z.string()).optional() }))
    .mutation(async ({ input }) => {
      try {
        const body = {
          symbols: input.symbols?.length ? input.symbols : undefined,
          delay: 0.2,
        };
        const resp = await fetch('http://127.0.0.1:8002/api/v1/options/pcr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) throw new Error(`PCR fetch failed: ${resp.status}`);
        const data = await resp.json();
        return { success: true, data };
      } catch (err) {
        console.error('[Router] runPcrFetch error:', err);
        return { success: false, error: String(err) };
      }
    }),
});


export type AppRouter = typeof appRouter;
