/**
 * BullMQ queues & workers
 *
 * Two queues:
 *   stock-refresh  ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“ repeatable job every 5 min, refreshes all NSE live prices
 *   ai-signals     ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“ per-stock AI analysis jobs, concurrency 3
 *
 * Both require Redis.  If Redis is unavailable the module exports no-op stubs
 * and the server falls back to the legacy setInterval approach.
 */

import { Queue, Worker, QueueEvents, Job, ConnectionOptions } from 'bullmq';
import { fetchAllLiveStocks } from './liveStockData';
import { cacheSet } from './cacheService';
import { generateStockAnalysis } from '../services/aiService';
import { dbGet, dbAll, dbRun } from './dbAsync';
import { syncAndScore } from './scoringService';
import Redis from 'ioredis';
import { REDIS_BASE } from './redisConfig';
import { CronExpressionParser } from 'cron-parser';
import { runPython } from './pythonRunner';

import { syncNiftyTraderScores, syncTrendlyneScores } from './syncProprietaryScores';
import { syncTrendlyneTechnicals } from './technicalIntelligenceService';
import { syncAllScreenerStocksToDB } from './trendlyneScreener';
import { syncMoneyControlScreeners } from './moneycontrolScreener';
import { runFullFundamentalsSync } from './fundamentalsSyncService';
import { fetchDeliveryMap } from './deliveryFetcher';
import { updateMonitorState } from './monitoringService';
import { getTrendlyneMetricSymbols, enqueueTrendlyneMetricsFetchJobs, runTrendlyneMetricsFetch } from './trendlyneDailyFetchService';
import { isMarketOpen } from './marketStatusService';
import {
  isDormant, shouldStartNewCycle, pickRandomBatch, randomDelayMs, DORMANT_RECHECK_MS,
  getCycleState, startNewCycle, completeCycle, getPendingStocksForCycle, upsertChecklistResult,
} from './trendlyneChecklistCycle';
import { fetchTrendlyneChecklist } from './trendlyneService';

import { pythonApi } from './pythonApi';
import { recordHeartbeat, startHeartbeatMonitor } from './jobHeartbeat';
import { startJobWatchdog, buildDailyDigest } from './jobWatchdog';
import { telegramService } from './telegramService';

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Redis connection shared across all BullMQ objects ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

function makeConnection(isProbe = false): any {
  const base = {
    ...REDIS_BASE,
    connectTimeout: isProbe ? 2000 : 30000,
    keepAlive: 30000,
    noDelay: true,            // disable Nagle — reduces EPIPE risk on burst writes
    showFriendlyErrorStack: false,
  };

  if (isProbe) {
    return {
      ...base,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      autoResubscribe: false,
      retryStrategy: () => null,
    };
  }

  return {
    ...base,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    autoResubscribe: true,
    // Stagger reconnect attempts so all 88 connections don't pile on Redis at once
    retryStrategy: (times) => {
      if (times > 20) return null;
      return Math.min(times * 200, 5000) + Math.floor(Math.random() * 200);
    },
  };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Queue names ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export const QUEUE_STOCK_REFRESH        = 'stock-refresh';
export const QUEUE_AI_SIGNALS           = 'ai-signals';
export const QUEUE_STOCK_SCORING        = 'stock-scoring';
export const QUEUE_MC_SCREENER_SYNC     = 'mc-screener-sync';
export const QUEUE_ETNOW_SCREENER_SYNC  = 'etnow-screener-sync';
export const QUEUE_NSE_SYNC             = 'nse-sync';  // PHASE 2: Weekly NSE master data sync
export const QUEUE_FUNDAMENTALS_SYNC    = 'fundamentals-sync';
export const QUEUE_QUANT_SCORING        = 'quant-scoring';
export const QUEUE_TECHNICAL_SIGNALS    = 'technical-signals';
export const QUEUE_SIGNAL_OUTCOMES      = 'signal-outcomes';
export const QUEUE_NEWS_SENTIMENT       = 'news-sentiment';
export const QUEUE_TRENDLYNE_INTRADAY   = 'trendlyne-intraday';
export const QUEUE_OUTCOME_RESOLVER     = 'outcome-resolver';
export const QUEUE_ML_DAILY_OPS        = 'ml-daily-ops';
export const QUEUE_ML_WEEKLY_RETRAIN   = 'ml-weekly-retrain';
export const QUEUE_INTRADAY_FETCHER    = 'intraday-fetcher';
export const QUEUE_RESEARCH_PREMARKET  = 'research-premarket';
export const QUEUE_RESEARCH_POSTCLOSE  = 'research-postclose';
export const QUEUE_DL_MACRO_FETCH       = 'dl-macro-fetch';
export const QUEUE_DL_FEATURE_REFRESH   = 'dl-feature-refresh';
export const QUEUE_DL_INFERENCE         = 'dl-inference';
export const QUEUE_DL_REGIME_UPDATE     = 'dl-regime-update';
export const QUEUE_DL_RETRAIN_WEEKLY    = 'dl-retrain-weekly';
export const QUEUE_DL_RETRAIN_EMERGENCY = 'dl-retrain-emergency';
export const QUEUE_OHLCV_BACKFILL       = 'ohlcv-backfill';
export const QUEUE_CONFLUENCE_COMPUTE  = 'confluence-compute';
export const QUEUE_CONFLUENCE_OUTCOMES = 'confluence-outcomes';
export const QUEUE_SCREENER_PERFORMANCE = 'screener-performance';
export const QUEUE_AGENT_DATA_SCIENTIST = 'agent-data-scientist';
export const QUEUE_AGENT_STRATEGIST     = 'agent-strategist';
export const QUEUE_AGENT_AUDITOR        = 'agent-auditor';
export const QUEUE_AGENT_OPTIMIZER      = 'agent-optimizer';
export const QUEUE_UNIFIED_RANKER       = 'unified-ranker';
export const QUEUE_COMPANY_PROFILES_SYNC = 'company-profiles-sync';
export const QUEUE_QUANT_EOD_SYNC = 'quant-eod-sync';
export const QUEUE_TRENDLYNE_DAILY_FETCH = 'trendlyne-daily-fetch';
export const QUEUE_TRENDLYNE_MIDWEEK = 'trendlyne-midweek';
export const QUEUE_TRENDLYNE_RATIOS_MONTHLY = 'trendlyne-ratios-monthly';
export const QUEUE_TICKERTAPE_SCORECARD = 'tickertape-scorecard';
export const QUEUE_LIVE_SCREENER_COLLECT = 'live-screener-collect';
export const QUEUE_TRENDLYNE_CHECKLIST_CYCLE = 'trendlyne-checklist-cycle';

const BULK_CACHE_KEY      = 'live-stocks-bulk';
const BULK_TTL_SECONDS    = 5 * 60;
const REFRESH_REPEAT_MS   = BULK_TTL_SECONDS * 1000;

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Module-level handles (null when Redis unavailable) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export let stockRefreshQueue:      Queue | null = null;
export let aiSignalsQueue:         Queue | null = null;
export let stockScoringQueue:      Queue | null = null;
export let mcScreenerSyncQueue:    Queue | null = null;
export let etnowScreenerSyncQueue: Queue | null = null;
export let nseScreenerSyncQueue:   Queue | null = null;  // PHASE 2: NSE master data sync
export let fundamentalsSyncQueue:  Queue | null = null;
export let quantScoringQueue:      Queue | null = null;
export let technicalSignalsQueue:  Queue | null = null;
export let signalOutcomesQueue:    Queue | null = null;
export let newsSentimentQueue:     Queue | null = null;
export let trendlyneIntradayQueue: Queue | null = null;
export let trendlyneDailyFetchQueue: Queue | null = null;
export let trendlyneMidweekQueue: Queue | null = null;
export let trendlyneRatiosMonthlyQueue: Queue | null = null;
export let tickertapeScorecardQueue: Queue | null = null;

let stockWorker:              Worker | null = null;
let signalWorker:             Worker | null = null;
let scoringWorker:            Worker | null = null;
let mcScreenerSyncWorker:     Worker | null = null;
let etnowScreenerSyncWorker:  Worker | null = null;
let nseScreenerSyncWorker:    Worker | null = null;  // PHASE 2: NSE worker
let fundamentalsSyncWorker:   Worker | null = null;
let quantScoringWorker:       Worker | null = null;
let technicalSignalsWorker:   Worker | null = null;
let signalOutcomesWorker:     Worker | null = null;
let newsSentimentWorker:      Worker | null = null;
let trendlyneIntradayWorker:  Worker | null = null;
let trendlyneDailyFetchWorker: Worker | null = null;
let trendlyneMidweekWorker: Worker | null = null;
let trendlyneRatiosMonthlyWorker: Worker | null = null;
let tickertapeScorecardWorker: Worker | null = null;
export let companyProfilesSyncQueue: Queue | null = null;
export let quantEodSyncQueue: Queue | null = null;
export let quantEodSyncWorker: Worker | null = null;
let companyProfilesSyncWorker: Worker | null = null;
export let outcomeResolverQueue: Queue | null = null;
let outcomeResolverWorker: Worker | null = null;
export let mlDailyOpsQueue: Queue | null = null;
let mlDailyOpsWorker: Worker | null = null;
export let mlWeeklyRetrainQueue: Queue | null = null;
let mlWeeklyRetrainWorker: Worker | null = null;
export let intradayFetcherQueue: Queue | null = null;
let intradayFetcherWorker: Worker | null = null;
export let researchPremarketQueue: Queue | null = null;
export let researchPostcloseQueue: Queue | null = null;
let researchPremarketWorker: Worker | null = null;
let researchPostcloseWorker: Worker | null = null;
export let dlMacroFetchQueue:       Queue | null = null;
export let dlFeatureRefreshQueue:   Queue | null = null;
export let dlInferenceQueue:        Queue | null = null;
export let dlRegimeUpdateQueue:     Queue | null = null;
export let dlRetrainWeeklyQueue:    Queue | null = null;
export let dlRetrainEmergencyQueue: Queue | null = null;

let dlMacroFetchWorker:       Worker | null = null;
let dlFeatureRefreshWorker:   Worker | null = null;
let dlInferenceWorker:        Worker | null = null;
let dlRegimeUpdateWorker:     Worker | null = null;
let dlRetrainWeeklyWorker:    Worker | null = null;
let dlRetrainEmergencyWorker: Worker | null = null;

export let ohlcvBackfillQueue: Queue | null = null;
let ohlcvBackfillWorker:       Worker | null = null;

export let confluenceComputeQueue:  Queue | null = null;
export let confluenceOutcomesQueue: Queue | null = null;
let confluenceComputeWorker:  Worker | null = null;
let confluenceOutcomesWorker: Worker | null = null;
let confluenceFallbackTimer:  ReturnType<typeof setInterval> | null = null;
export let liveScreenerCollectQueue: Queue | null = null;
let liveScreenerCollectWorker: Worker | null = null;
let liveScreenerFallbackTimer: ReturnType<typeof setInterval> | null = null;

export let screenerPerfQueue: Queue | null = null;
let screenerPerfWorker: Worker | null = null;
export let agentDataScientistQueue: Queue | null = null;
export let agentStrategistQueue:    Queue | null = null;
export let agentAuditorQueue:       Queue | null = null;
export let agentOptimizerQueue:     Queue | null = null;
let agentDataScientistWorker: Worker | null = null;
let agentStrategistWorker:    Worker | null = null;
let agentAuditorWorker:       Worker | null = null;
let agentOptimizerWorker:     Worker | null = null;
export let unifiedRankerQueue: Queue | null = null;
export let unifiedRankerWorker: Worker | null = null;
let trendlyneChecklistCycleQueue: Queue | null = null;
let trendlyneChecklistCycleWorker: Worker | null = null;


// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Confluence compute processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processConfluenceCompute(_job: Job): Promise<{ computed: number; elite: number; strong: number }> {
  const { computeConfluenceSignals, runMLProbabilityOverlay } = await import('./confluenceEngine');
  const result = await computeConfluenceSignals();
  runMLProbabilityOverlay().catch((err: any) =>
    console.warn('[CONFLUENCE] ML overlay failed (non-blocking):', err?.message ?? err)
  );
  return result;
}

async function processConfluenceOutcomes(_job: Job): Promise<void> {
  await Promise.all([
    runPython('confluence_outcome_tracker.py', [], 120_000),
    runPython('confluence_ml_engine.py', ['--train'], 120_000),
  ]);
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Stock-refresh worker processor (PHASE 1: Now persists OHLCV) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processStockRefresh(_job: Job): Promise<{ count: number; persisted: number }> {
  const { fetchAndPersistOHLCVData } = await import('./liveStockData');
  const result = await fetchAndPersistOHLCVData();
  return result;
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ AI-signals worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processAISignal(job: Job): Promise<void> {
  const { symbol, stockData } = job.data as { symbol: string; stockData: Record<string, unknown> };

  const analysis = await generateStockAnalysis(symbol, stockData);

  // Actionability gate: only persist conviction BUY/SELL signals above the confidence
  // floor. Drops HOLD and sub-threshold noise so the DB matches what the UI surfaces and
  // the backtester sees clean, actionable data. (See docs/.../ai-signal-gate-design.md)
  const { gateAISignal, getAISignalMinConfidence, upsertUnifiedSignal, checkSurveillanceGate } = await import('./signals');
  const threshold = await getAISignalMinConfidence();
  const gate = gateAISignal(analysis as any, threshold);
  if (!gate.persist) {
    await job.updateProgress(100);
    return;
  }

  const survGate = await checkSurveillanceGate(symbol);
  if (survGate) {
    await job.updateProgress(100);
    return;
  }

  const now = new Date().toISOString();

  // Write to unified_signals so outcome resolver and reward engine can track AI signal performance
  await upsertUnifiedSignal('AI', {
    symbol,
    signalDate: now.split('T')[0],
    signalType: gate.signalType,
    entryPrice: analysis.entry ?? null,
    targetPrice: analysis.target ?? null,
    stopLoss: analysis.stopLoss ?? null,
    confidenceScore: analysis.confidence ?? null,
    reasoning: analysis.reasoning ?? null,
    generatedAt: now,
  });

  // Broadcast via WebSocket so the frontend gets a real-time alert
  try {
    const { wsSignalService } = await import('./websocketService');
    wsSignalService.broadcastNewSignal({
      type: 'new_signal',
      symbol,
      timestamp: now,
      source: 'AI',
      generatedAt: now,
      signal: {
        signalType: gate.signalType,
        entryPrice: analysis.entry ?? null,
        targetPrice: analysis.target ?? null,
        stopLoss: analysis.stopLoss ?? null,
        confidence: analysis.confidence ?? null,
        reasoning: analysis.reasoning ?? null,
      },
    });
  } catch {
    // WebSocket is best-effort
  }

  // Update job progress so the frontend can display it
  await job.updateProgress(100);
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Stock-scoring worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processStockScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled stock scoring...');
  const result = await syncAndScore();
  if (!result.success) throw new Error(`Stock scoring failed: ${result.message}`);
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ MC screener sync worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processMcScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled MoneyControl screener sync...');
  const { syncMoneyControlScreeners } = await import('./moneycontrolScreener');
  await syncMoneyControlScreeners();
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ETNow screener sync worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processEtnowScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled ETNow screener sync...');
  const { syncETnowScreeners } = await import('./etnowScreenerSync');
  await syncETnowScreeners();
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ NSE-sync worker processor (PHASE 2: Weekly NSE master data sync) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processNSESync(_job: Job): Promise<{ success: boolean; stockCount: number }> {
  console.log('[QUEUE] Starting NSE master data sync...');
  try {
    const { syncNSEStocksToDatabase } = await import('./nseService');
    const result = await syncNSEStocksToDatabase();
    const stockCount = (result?.inserted || 0) + (result?.updated || 0);
    console.log(`[QUEUE] NSE sync completed, ${stockCount} stocks updated`);
    // Backfill canonical nse_stocks.sector from already-resolved confluence data, then
    // propagate to historical signal tables. Keeps sector segmentation healthy over time.
    await runPython('backfill_sectors.py', [], 120_000)
      .catch(err => console.warn('[QUEUE] sector backfill failed (non-blocking):', (err as Error).message));
    // Index membership flags (Nifty50/100/200/Midcap150/Smallcap250) — passive ETF flow signal.
    await runPython('index_membership_fetcher.py', [], 60_000)
      .catch(err => console.warn('[QUEUE] index_membership_fetcher failed (non-blocking):', (err as Error).message));
    return { success: true, stockCount };
  } catch (err: any) {
    console.error('[QUEUE] NSE sync failed:', err.message);
    throw err;
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Fundamentals-sync worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processFundamentalsSync(job: Job): Promise<{ success: boolean }> {
  const phase2Only = job.data?.phase2Only === true;
  console.log(`[QUEUE] Starting fundamentals sync (phase2Only=${phase2Only})...`);
  const { runFullFundamentalsSync } = await import('./fundamentalsSyncService');
  await runFullFundamentalsSync(phase2Only);
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Quant-scoring worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processQuantScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting quant strategy scoring...');
  const { runQuantScoring } = await import('./quantScoringService');
  await runQuantScoring();
  return { success: true };
}

/**
 * Resolve outcomes at the given horizon. Prefer the in-process Python API (port 8002),
 * but if it is unreachable fall back to spawning outcome_resolver.py directly — the
 * resolver is self-contained (connects straight to SQLite), so resolution must NOT
 * silently no-op just because the AlphaQuant service happens to be down.
 */
async function resolveOutcomesResilient(horizon: number): Promise<void> {
  try {
    await pythonApi.resolveOutcomes(horizon);
  } catch (e) {
    console.warn(`[API] resolve-outcomes(${horizon}) failed, falling back to runPython:`, (e as Error).message);
    await runPython('outcome_resolver.py', ['--horizon', String(horizon)], 180_000)
      .catch(err => console.error(`[QUEUE] outcome_resolver.py fallback(${horizon}) failed:`, (err as Error).message));
  }
}

async function processOutcomeResolver(_job: Job): Promise<{ success: boolean }> {
  // Flag bad-print OHLCV bars first so outcome labels skip them (ohlcv_quality.is_suspect).
  await runPython('ohlcv_quality.py', ['--no-ingest'], 180_000)
    .catch(e => console.warn('[QUEUE] ohlcv_quality flag failed:', (e as Error).message));

  await resolveOutcomesResilient(1);
  await resolveOutcomesResilient(5);
  await resolveOutcomesResilient(15);

  // Now a windowed batch-resolve (was per-row N+1, routinely blew the old 180s
  // timeout on any real backlog) — give it real headroom.
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(err => console.error('[QUEUE] live_screener_resolver.py failed:', err.message));

  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ML daily ops worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processLiveScreenerCollect(_job: Job): Promise<void> {
  if (!(await isMarketOpen())) {
    console.log('[QUEUE] live-screener-collect skipped — outside NSE market hours');
    return;
  }
  const { runLiveScreenerCollection } = await import('./liveScreenerCollector');
  await runLiveScreenerCollection();
}

async function processIntradayFetcher(_job: Job): Promise<void> {
  // Fetches 15m bars for all 2328 NSE stocks (last 24h) — ~4 min per run.
  await runPython('intraday_fetcher.py', ['--lookback-days', '1'], 600_000)
    .catch(e => console.warn('[QUEUE] intraday_fetcher failed:', (e as Error).message));
}

async function processMlDailyOps(_job: Job): Promise<{ success: boolean }> {
  // Point-in-time fundamentals snapshot first — builds the as-of trail load_training_data joins.
  await runPython('fundamentals_snapshot.py', [], 90_000)
    .catch(e => console.warn('[QUEUE] fundamentals_snapshot failed:', (e as Error).message));

  // analyst_estimates_snapshot moved to weekly retrain (2328 stocks × 3 calls × 0.4s = ~47 min)

  // Surveillance gate: ASM/GSM flags → nse_stocks and technical_signals.asm_flag/gsm_stage.
  await runPython('asm_gsm_fetcher.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] asm_gsm_fetcher failed:', (e as Error).message));
  await runPython('fii_dii_fetcher.py', [], 90_000).catch(() => {});
  await runPython('pcr_fetcher.py', ['--gex'], 90_000).catch(() => {});
  await runPython('moneycontrol_fetcher.py', [], 300_000).catch(e => {
    console.warn('[QUEUE] moneycontrol_fetcher failed:', (e as Error).message);
  });
  // iv_features reads the ATM IV that pcr_fetcher just wrote to stock_options_oi → technical_signals.iv_rank.
  await runPython('iv_features.py', [], 90_000)
    .catch(e => console.warn('[QUEUE] iv_features failed:', (e as Error).message));
  await runPython('institutional_quant_engine.py', [], 120_000).catch(() => {});
  await runPython('finbert_scorer.py', ['--days', '1'], 180_000).catch(() => {});

  // Flag bad-print OHLCV bars first so outcome labels skip them (ohlcv_quality.is_suspect).
  await runPython('ohlcv_quality.py', ['--no-ingest'], 180_000)
    .catch(e => console.warn('[QUEUE] ohlcv_quality flag failed:', (e as Error).message));

  // Cross-sectional relative strength from (cleaned) OHLCV → technical_signals.rs_rank_21d/63d.
  await runPython('relative_strength.py', [], 180_000)
    .catch(e => console.warn('[QUEUE] relative_strength failed:', (e as Error).message));

  // Market breadth internals (% above 200DMA, A/D ratio, 20d highs, 52w net highs/lows) from stock_ohlcv.
  await runPython('market_breadth.py', ['--days', '420'], 120_000)
    .catch(e => console.warn('[QUEUE] market_breadth failed:', (e as Error).message));

  // Rolling 90d insider buy/sell ratio from insider_trades → technical_signals.insider_buy_pct_90d.
  await runPython('insider_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] insider_features failed:', (e as Error).message));

  // Intraday microstructure: opening-range break, VWAP deviation, first-hour vol share.
  // Runs post-close so the full session (9:15–15:30 IST) is in intraday_ohlcv.
  await runPython('intraday_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] intraday_features failed:', (e as Error).message));

  // Anchored VWAP deviation (20-day rolling anchor from stock_ohlcv) → technical_signals.avwap_deviation_pct.
  await runPython('avwap_features.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] avwap_features failed:', (e as Error).message));

  // OI net-change delta (day-over-day total OI % change from stock_options_oi) → oi_net_change_pct.
  // Depends on pcr_fetcher.py having run earlier in this same daily ops cycle.
  await runPython('oi_delta_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] oi_delta_features failed:', (e as Error).message));

  // F&O rollover % and cost of carry from NSE bhavcopies → fno_rollover → technical_signals.
  await runPython('fno_rollover_fetcher.py', ['--days', '1'], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] fno_rollover_fetcher failed:', (e as Error).message));

  // Cash market delivery % from NSE MTO DAT → stock_delivery_volume → technical_signals.
  await runPython('delivery_volume_fetcher.py', ['--days', '1'], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] delivery_volume_fetcher failed:', (e as Error).message));

  // Block deals from NSE live API → stock_block_deal_daily → technical_signals.
  await runPython('block_deal_fetcher.py', ['--days', '1'], 60_000)
    .catch(e => console.warn('[QUEUE] block_deal_fetcher failed:', (e as Error).message));

  // MC pricefeed: IND_PE, CAGR 3/5y, consensus PE/PB, 200DMA distance, delivery avg, 52w position.
  // 2328 stocks × 0.35s = ~14 min
  await runPython('mc_pricefeed_fetcher.py', [], 25 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_pricefeed_fetcher failed:', (e as Error).message));

  // MC chart patterns: professional pattern detection with target price, stop-loss, direction.
  // 2328 stocks × 0.35s = ~14 min
  await runPython('mc_chart_patterns_fetcher.py', [], 25 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_chart_patterns_fetcher failed:', (e as Error).message));

  // NiftyTrader F&O dashboard: max_pain per stock + directional OI flow (calls vs puts Δoi)
  // for all 147 F&O stocks in a single API call — daily because max pain shifts each session.
  await runPython('nt_dashboard_fetcher.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] nt_dashboard_fetcher failed:', (e as Error).message));

  // NiftyTrader intraday PCR time series for major indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY).
  await runPython('nt_pcr_ts_fetcher.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] nt_pcr_ts_fetcher failed:', (e as Error).message));

  // NiftyTrader EOD strike-wise OI snapshot — feeds index_max_pain + nt_index_oi_eod.
  await runPython('nt_oi_snapshot_fetcher.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] nt_oi_snapshot_fetcher failed:', (e as Error).message));

  // India VIX + GIFT NIFTY intraday values + EOD close → macro_asset_prices + nt_index_pcr_ts.
  await runPython('nt_vix_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] nt_vix_fetcher failed:', (e as Error).message));

  // NiftyTrader per-strike OI change (buildup/unwinding) for index options.
  await runPython('nt_change_oi_fetcher.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] nt_change_oi_fetcher failed:', (e as Error).message));

  // SmartOptions Greek-enriched option chain for all F&O stocks (Delta/Gamma/Theta/Vega/IV).
  await runPython('so_option_chain_fetcher.py', ['--delay', '0.3'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] so_option_chain_fetcher failed:', (e as Error).message));

  // Earnings beat features (reads stock_earnings_beats, refreshed weekly by earnings_surprise_fetcher).
  // Writes eps_beat_last_q / eps_beat_streak_4q / eps_miss_streak_4q → technical_signals.
  await runPython('earnings_beat_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] earnings_beat_features failed:', (e as Error).message));

  // Sector-global benchmark correlation (requires macro_asset_prices from global_macro_fetcher).
  await runPython('sector_global_corr.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] sector_global_corr failed:', (e as Error).message));

  // Historical Volatility (HV10/20/30/60d + IV-HV ratio) purely from stock_ohlcv — no new feed.
  await runPython('hv_features.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] hv_features failed:', (e as Error).message));

  // Analyst estimate revision drift (EPS + price-target 3m change) from analyst_estimates_history.
  await runPython('analyst_revision.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] analyst_revision failed:', (e as Error).message));

  // Commodity/FX sensitivity: 90d rolling corr of each stock vs CRUDE/GOLD/DXY/SP500.
  // Requires macro_asset_prices to be populated (global_macro_fetcher runs at session start).
  await runPython('commodity_sensitivity.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] commodity_sensitivity failed:', (e as Error).message));

  // Earnings calendar + PEAD categories + price shockers + sector earnings + market breadth.
  await runPython('mc_earnings_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_earnings_fetcher failed:', (e as Error).message));

  // Broker research recommendations: named broker BUY/SELL events → mc_broker_reco + technical_signals.
  await runPython('mc_broker_reco_fetcher.py', ['--days', '7'], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_broker_reco_fetcher failed:', (e as Error).message));

  // Economic calendar: upcoming high-impact macro events → eco_calendar + macro_asset_prices.
  await runPython('mc_eco_calendar_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] mc_eco_calendar_fetcher failed:', (e as Error).message));

  // Corporate action calendar: ex-dividend dates + board meeting dates → corporate_actions + technical_signals.
  // Prevents false STOP_LOSS signals on ex-div days; adds pre-earnings drift feature.
  await runPython('mc_corporate_calendar_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] mc_corporate_calendar_fetcher failed:', (e as Error).message));

  // Screener features: stamp per-stock screener ML features into technical_signals
  // (runs after screener sync so appearances are current)
  await runPython('screener_features_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_features_fetcher failed:', (e as Error).message));

  // Sector screener rotation: aggregate bull/bear signals by sector
  await runPython('screener_sector_rotation.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_sector_rotation failed:', (e as Error).message));

  // Screener surfacing alerts: new screener entries → unified_signals
  await runPython('screener_signal_generator.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_signal_generator failed:', (e as Error).message));

  // Per-stock option chain: expected move + GEX proxy + BS-derived ATM IV → stock_option_features + stock_options_oi + technical_signals.
  await runPython('stock_option_chain_fetcher.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] stock_option_chain_fetcher failed:', (e as Error).message));
  // Re-run iv_features after stock chains so per-stock iv_rank reflects BS-computed ATM IV (not just index IV from pcr_fetcher).
  await runPython('iv_features.py', [], 90_000)
    .catch(e => console.warn('[QUEUE] iv_features (stock IV pass) failed:', (e as Error).message));

  // EPS surprise streak: beat/miss history from MC actual-estimate API → eps_surprise_history + technical_signals.
  await runPython('eps_surprise_fetcher.py', [], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] eps_surprise_fetcher failed:', (e as Error).message));

  // financial_ratios_fetcher + working_capital_fetcher moved to weekly retrain
  // (3058 stocks × 4-5 calls = 61-102 min each; data changes quarterly not daily)

  // Delivery % trend + bulk/block deals + short interest proxy → technical_signals.
  await runPython('delivery_trend_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] delivery_trend_fetcher failed:', (e as Error).message));

  // Promoter insider transactions (90d rolling) from NSE → insider_transactions + technical_signals.
  await runPython('insider_transactions_fetcher.py', [], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] insider_transactions_fetcher failed:', (e as Error).message));

  // Credit rating events (upgrades/downgrades) from BSE → credit_rating_events + technical_signals.
  await runPython('credit_rating_fetcher.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] credit_rating_fetcher failed:', (e as Error).message));

  // MF sector AUM flow from AMFI monthly disclosures → mf_sector_allocation + technical_signals.
  await runPython('mf_sector_flow_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] mf_sector_flow_fetcher failed:', (e as Error).message));

  // India macro indicators: PMI, GST, IIP, auto sales, RBI rate → macro_asset_prices.
  await runPython('india_macro_fetcher.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] india_macro_fetcher failed:', (e as Error).message));

  // Index PE/PB/EPS → index_valuation (MoneyControl + Trendlyne, last 30 days).
  // ~35 of the ~91 indices now fall back to a second Trendlyne round-trip per index because
  // MC's graph endpoint returns corrupted data for most sector sub-indices — a full run takes
  // 6-7 minutes, well past the old 3-minute budget.
  await runPython('nifty_pe_fetcher.py', ['--days', '30'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] nifty_pe_fetcher failed:', (e as Error).message));

  // Index OHLC history from MoneyControl → stock_ohlcv (covers SENSEX + indices missing from Yahoo).
  await runPython('mc_index_ohlc_fetcher.py', ['--range', '5d'], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_index_ohlc_fetcher failed:', (e as Error).message));

  // NSE/BSE advance-decline raw counts → mc_advance_decline + market_breadth.adv_decline_ratio.
  await runPython('mc_advance_decline_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] mc_advance_decline_fetcher failed:', (e as Error).message));

  // Index options OI by strike → index_option_oi + index_max_pain (Nifty + BankNifty).
  await runPython('mc_index_oi_fetcher.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_index_oi_fetcher failed:', (e as Error).message));

  // BSE event classifier: news_articles → event_signal_score in technical_signals.
  await runPython('bse_event_classifier.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] bse_event_classifier failed:', (e as Error).message));

  // Backfill technical features (RSI/MACD/ADX from stock_ohlcv) for any outcome that
  // still lacks a ts row — keeps ML training coverage high as new signals resolve.
  await runPython('backfill_technical_features.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] backfill_technical_features failed:', (e as Error).message));

  // PEAD model: eps_growth_yoy + volume + RS → pead_score in technical_signals.
  await runPython('pead_model.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] pead_model failed:', (e as Error).message));

  await resolveOutcomesResilient(1);
  await resolveOutcomesResilient(5);
  await resolveOutcomesResilient(15);

  // Compute excursion path labels for all resolved entries:
  await runPython('exit_labeler.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] exit_labeler failed:', (e as Error).message));

  // Now a windowed batch-resolve (was per-row N+1, routinely blew the old 180s
  // timeout on any real backlog) — give it real headroom.
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(err => console.error('[QUEUE] live_screener_resolver.py failed:', err.message));

  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);

  await runPython('online_learner.py', ['--window', '180'], 120_000).catch(() => {});

  // Warm-start LGBM ensemble on the last 3 days of newly-resolved outcomes (+20 boost rounds).
  // Runs after online_learner so SGD priors are already updated; keeps ensemble fresh daily
  // without the cost of a full weekly retrain.
  await runPython('ml_ensemble.py', ['--incremental', '--incr-days', '3'], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] ml_ensemble incremental failed:', (e as Error).message));

  await pythonApi.scorePending().catch(e => console.warn('[API] score-pending:', (e as Error).message));

  // Isotonic-recalibrate win_probability against realized WIN/LOSS so sizing/gating use
  // honest probabilities (the ensemble stack is overconfident). Runs after outcomes resolve.
  await runPython('ml_calibration.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] ml_calibration failed:', (e as Error).message));

  // PSI-based feature drift check — writes drift_score to dl_model_performance so
  // scoring_engine applies a win_probability haircut when distributions shift.
  await runPython('drift_detector.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] drift_detector failed:', (e as Error).message));

  await runPython('cs_ranker.py', ['--score'], 120_000)
    .catch(e => console.warn('[QUEUE] cs_ranker score failed:', (e as Error).message));

  await runPython('reward_engine.py');
  // --update only recomputes Q-values for existing rl_episodes rows; nothing creates NEW
  // rows day-to-day (log_episode() is unused dead code) — --backfill is what actually
  // inserts episodes from newly-resolved signal_outcomes. A short lookback keeps this a
  // cheap daily top-up instead of re-scanning the full history (default 180d) every run.
  await runPython('rl_agent.py', ['--backfill', '--lookback', '20'], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] rl_agent backfill failed:', (e as Error).message));
  await runPython('rl_agent.py', ['--update']);

  const { computeSignalTypeStats } = await import('./technicalSignalsService');
  await computeSignalTypeStats().catch(e => console.warn('[QUEUE] computeSignalTypeStats failed:', (e as Error).message));

  return { success: true };
}

// ── Trendlyne checklist cycle processor (self-rescheduling, random interval) ──

async function processTrendlyneChecklistCycle(_job: Job): Promise<void> {
  const queue = trendlyneChecklistCycleQueue!;
  let nextDelayMs = randomDelayMs(15, 45);
  try {
    const now = Date.now();
    let { cycleStartedAt, cycleCompletedAt } = await getCycleState();

    if (isDormant(now, cycleCompletedAt)) {
      nextDelayMs = DORMANT_RECHECK_MS;
      return;
    }

    if (shouldStartNewCycle(cycleStartedAt, cycleCompletedAt, now)) {
      await startNewCycle(now);
      cycleStartedAt = now;
    }

    const pending = await getPendingStocksForCycle(cycleStartedAt!);

    if (pending.length === 0) {
      await completeCycle(now);
      nextDelayMs = DORMANT_RECHECK_MS;
      return;
    }

    const batch = pickRandomBatch(pending, 10, 15);
    for (const stock of batch) {
      try {
        const result = await fetchTrendlyneChecklist(stock.tlid);
        if (result) {
          await upsertChecklistResult(stock.symbol, result, Date.now());
        }
      } catch (e: any) {
        console.warn(`[TRENDLYNE-CHECKLIST] Failed for ${stock.symbol}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }

    console.log(`[TRENDLYNE-CHECKLIST] Processed ${batch.length} stocks this run.`);
  } finally {
    await queue.add('checklist-cycle-tick', {}, { delay: nextDelayMs, removeOnComplete: 3, removeOnFail: 3 });
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Research report processor functions ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processResearchPremarket(_job: Job): Promise<{ success: boolean }> {
  const { generateDailyReport } = await import('./researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'PRE_MARKET');
  return { success: true };
}

async function processResearchPostclose(_job: Job): Promise<{ success: boolean }> {
  const { generateDailyReport } = await import('./researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'POST_CLOSE');
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Python runner ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processDLPython(script: string, args: string[] = [], timeoutMs = 6 * 60 * 60_000): Promise<{ success: boolean }> {
  await runPython(script, args, timeoutMs);
  return { success: true };
}

async function processMlWeeklyRetrain(_job: Job): Promise<{ success: boolean }> {
  // Keep index_provider_map in sync with live provider index lists.
  await runPython('sync_mc_index_map.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] sync_mc_index_map failed:', (e as Error).message));
  await runPython('sync_tl_index_map.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] sync_tl_index_map failed:', (e as Error).message));
  await runPython('sync_nt_fno_symbols.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] sync_nt_fno_symbols failed:', (e as Error).message));
  // Refresh earnings beat/miss history (quarterly data, no need to run daily).
  await runPython('earnings_surprise_fetcher.py', [], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] earnings_surprise_fetcher failed:', (e as Error).message));
  // MF holdings: AMFI monthly disclosures — weekly fetch is sufficient.
  await runPython('mf_holdings_fetcher.py', [], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] mf_holdings_fetcher failed:', (e as Error).message));
  // Trendlyne EPS/DivYield series + DVM scores — 2 calls/stock (PE/PB dropped: MC's daily
  // fetch already covers them, fed into the same history tables — see mc_pricefeed_fetcher.py).
  // 3058 stocks × 2 API calls × 0.5s = ~51 min
  await runPython('trendlyne_fundamentals_fetcher.py', [], 70 * 60_000)
    .catch(e => console.warn('[QUEUE] trendlyne_fundamentals_fetcher failed:', (e as Error).message));
  // Analyst consensus + price targets — 2328 stocks × 3 calls × 0.4s = ~47 min (quarterly data)
  await runPython('analyst_estimates_snapshot.py', [], 70 * 60_000)
    .catch(e => console.warn('[QUEUE] analyst_estimates_snapshot failed:', (e as Error).message));
  // trendlyne_adv_tech_fetcher.py + trendlyne_price_analysis_fetcher.py moved to the
  // trendlyne-midweek queue (Tuesday) to de-conflict from this Sunday batch.
  // trendlyne_overview_fetcher.py moved into company-profiles-sync (dedupes the
  // overview-second-part call both used to make independently).
  // financial_ratios_fetcher.py + working_capital_fetcher.py moved to the
  // trendlyne-ratios-monthly queue (rewritten against ET_Stats — see Tasks 5-6).
  await runPython('outcome_resolver.py', ['--horizon', '5']);
  await runPython('outcome_resolver.py', ['--horizon', '15']);
  // Run exit labeler to resolve excursions
  await runPython('exit_labeler.py', [], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] exit_labeler failed:', (e as Error).message));
  // Retrain the exit policy models
  await runPython('exit_policy.py', ['--train'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] exit_policy training failed:', (e as Error).message));
  // --tune runs Optuna hyperparameter search (this is what took the model from AUC 0.70 to
  // 0.757 in the first place) — without it, every scheduled retrain silently falls back to
  // untuned defaults, which measured ~0.20 AUC worse on held-out test in one observed run.
  await runPython('ml_ensemble.py', ['--train', '--tune', '--score'], 90 * 60_000);
  await runPython('cs_ranker.py', ['--train', '--score'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] cs_ranker retrain failed:', (e as Error).message));
  await runPython('strategy_optimizer.py', [], 30 * 60_000).catch(() => {});
  await runPython('backtester.py', ['--start', '2023-01-01'], 30 * 60_000).catch(() => {});
  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);
  return { success: true };
}

async function processScreenerPerf(_job: Job): Promise<void> {
  // 1. Sync newly discovered Trendlyne screener PKs. "known" mode only re-fetches PKs
  // missing from the DB, but with ~612 known PKs and a 0.4s rate limit that can still
  // run 20+ minutes in practice — the old 10-min timeout routinely SIGTERM'd it mid-run
  // (execFile kills before any stderr flushes, logged as an opaque "Command failed").
  await runPython('trendlyne_screener_discovery.py', [], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] trendlyne_screener_discovery failed:', (e as Error).message));

  // 2. Bulk-enrich signal_keywords + screener_url; INSERT 858 missing catalog entries; fix sector_theme bias
  await runPython('screener_catalog_enricher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_catalog_enricher failed:', (e as Error).message));

  // 2b. Backfill OHLCV for any symbols that appeared in screeners but are missing from stock_ohlcv
  await runPython('screener_ohlcv_backfill.py', [], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_ohlcv_backfill failed:', (e as Error).message));

  // 3. Compute performance metrics for all screeners (K_PRIOR adaptive; phase_e updates confidence)
  await runPython('screener_performance.py', [], 15 * 60_000);

  // 4. Stamp per-stock screener ML features into technical_signals
  await runPython('screener_features_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_features_fetcher failed:', (e as Error).message));

  // 5. Aggregate sector screener rotation signals
  await runPython('screener_sector_rotation.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_sector_rotation failed:', (e as Error).message));

  // 6. Generate screener surfacing alerts → unified_signals
  await runPython('screener_signal_generator.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_signal_generator failed:', (e as Error).message));

  // 7. Resolve live screener outcomes (needs ohlcv data to be fresh first)
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] live_screener_resolver failed:', (e as Error).message));

  try {
    const { classifyAllScreeners } = await import('./screenerClassifier');
    await classifyAllScreeners();
  } catch (e: unknown) {
    console.error('[QUEUE] screener classification failed:', (e as Error).message);
  }
}

async function processAgentDataScientist(_job: Job): Promise<{ success: boolean; grade?: string }> {
  await runPython('agents/data_scientist_agent.py', [], 10 * 60_000);
  const row = await dbGet<{ quality_grade: string }>(
    'SELECT quality_grade FROM agent_data_scientist_reports ORDER BY created_at DESC LIMIT 1'
  );
  return { success: true, grade: row?.quality_grade };
}

async function processAgentStrategist(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/strategist_agent.py', [], 15 * 60_000);

  const highPicks = await dbAll<any>(`
    SELECT symbol, timeframe, entry_zone_low, entry_zone_high,
           stop_loss, target_1, target_2, target_3, composite_score, narrative
    FROM agent_strategy_picks
    WHERE date(run_date) = date('now') AND conviction = 'HIGH'
    ORDER BY composite_score DESC
  `);

  if (highPicks.length > 0) {
    try {
      const { TelegramNotificationService } = await import('./telegramService');
      const tg = new TelegramNotificationService();
      for (const p of highPicks) {
        const firstSentence = (p.narrative as string || '').split('.')[0];
        await tg.sendMarkdownMessage(
          `Ã°Å¸Å½Â¯ *STRATEGY ALERT Ã¢â‚¬â€ ${(p.timeframe as string).toUpperCase()}*\n` +
          `*${p.symbol}* | Entry: Ã¢â€šÂ¹${p.entry_zone_low}Ã¢â‚¬â€œ${p.entry_zone_high} | SL: Ã¢â€šÂ¹${p.stop_loss}\n` +
          `T1: Ã¢â€šÂ¹${p.target_1} | T2: Ã¢â€šÂ¹${p.target_2} | T3: Ã¢â€šÂ¹${p.target_3}\n` +
          `Conviction: HIGH | Score: ${Number(p.composite_score).toFixed(0)}\n` +
          `${firstSentence}.`
        );
      }
    } catch (err: unknown) {
      console.warn('[QUEUE] Strategist Telegram alert failed:', (err as Error).message);
    }
  }
  return { success: true };
}

async function processAgentAuditor(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/auditor_agent.py', [], 15 * 60_000);
  return { success: true };
}

async function processAgentOptimizer(_job: Job): Promise<{ success: boolean }> {
  await runPython('agents/optimizer_agent.py', [], 20 * 60_000);

  const latest = await dbGet<any>(
    'SELECT weights_changed, full_optimizer_triggered, baseline_win_rate, new_win_rate, narrative ' +
    'FROM agent_optimizer_reports ORDER BY created_at DESC LIMIT 1'
  );

  if (latest && (latest.weights_changed || latest.full_optimizer_triggered)) {
    try {
      const { TelegramNotificationService } = await import('./telegramService');
      const tg = new TelegramNotificationService();
      const firstSentence = (latest.narrative as string || '').split('.')[0];
      await tg.sendMarkdownMessage(
        `Ã¢Å¡â„¢Ã¯Â¸Â *OPTIMIZER ALERT*\n` +
        `Win rate: ${Number(latest.baseline_win_rate).toFixed(0)}% Ã¢â€ â€™ ${Number(latest.new_win_rate).toFixed(0)}%\n` +
        `Full optimizer: ${latest.full_optimizer_triggered ? 'YES Ã°Å¸â€â€ž' : 'NO'}\n` +
        `${firstSentence}.`
      );
    } catch (err: unknown) {
      console.warn('[QUEUE] Optimizer Telegram alert failed:', (err as Error).message);
    }
  }
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Initialise queues & workers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬


async function processQuantEodSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] quant-eod-sync starting...');
  try {
    console.log('[QUANT EOD] 1. Syncing NiftyTrader & Trendlyne Scores');
    await syncNiftyTraderScores();
    await syncTrendlyneScores();
    
    console.log('[QUANT EOD] 1.5. Syncing Trendlyne Technical Snapshots');
    await syncTrendlyneTechnicals();
    
    console.log('[QUANT EOD] 2. Syncing Trendlyne Screeners');
    await syncAllScreenerStocksToDB();
    
    console.log('[QUANT EOD] 3. Syncing MoneyControl Screeners');
    await syncMoneyControlScreeners();

    console.log('[QUANT EOD] 3b. Syncing ETNow Screeners');
    const { syncETnowScreeners } = await import('./etnowScreenerSync');
    await syncETnowScreeners().catch((e: any) => console.error('[QUANT EOD] ETNow sync failed:', e.message));

    console.log('[QUANT EOD] 4. Syncing Point-in-time Fundamentals');
    await runFullFundamentalsSync();
    
    console.log('[QUANT EOD] 5. Syncing Delivery Data for Today');
    const today = new Date().toISOString().split('T')[0];
    await fetchDeliveryMap(today);
    
    console.log('[QUANT EOD] 6. Fetching PCR & Max Pain');
    await runPython('pcr_fetcher.py', ['--gex'], 90_000).catch(() => {});
    
    updateMonitorState('quant-eod-sync', 'success');
    console.log('[QUEUE] quant-eod-sync completed successfully');
    return { success: true };
  } catch (err: any) {
    updateMonitorState('quant-eod-sync', 'failed', err.message);
    console.error('[QUEUE] quant-eod-sync failed:', err.message);
    throw err;
  }
}


async function addJobWithCatchup(
  queue: Queue,
  jobName: string,
  data: any,
  opts: any = {}
) {
  if (opts.repeat && (opts.repeat.pattern || opts.repeat.cron) && !opts.repeat.tz) {
    opts.repeat.tz = 'Etc/UTC';
  }

  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.id === opts.jobId || r.name === jobName) {
      await queue.removeRepeatableByKey(r.key);
    }
  }

  await queue.add(jobName, data, opts);

  if (!opts.repeat || (!opts.repeat.pattern && !opts.repeat.every && !opts.repeat.cron)) {
    return;
  }

  try {
    const jobs = await queue.getJobs(['completed', 'failed'], 0, 1, false);
    const lastJob = jobs.length > 0 ? jobs[0] : null;
    const lastRunTime = lastJob?.timestamp || null;

    if (lastRunTime) {
      const now = Date.now();
      let missed = false;

      if (opts.repeat.pattern || opts.repeat.cron) {
        const pattern = opts.repeat.pattern || opts.repeat.cron;
        const parserOpts: any = { currentDate: new Date(now) };
        if (opts.repeat.tz) {
          parserOpts.tz = opts.repeat.tz;
        } else {
          parserOpts.utc = true;
        }
        const interval = CronExpressionParser.parse(pattern, parserOpts);
        const prevExpected = interval.prev().getTime();
        
        if (lastRunTime < prevExpected && prevExpected < now) {
          missed = true;
        }
      } else if (opts.repeat.every) {
        if (now - lastRunTime > opts.repeat.every) {
          missed = true;
        }
      }

      if (missed) {
        console.log(`[QUEUE] Job ${jobName} in ${queue.name} missed its scheduled run. Executing catch-up...`);
        const catchupOpts = { ...opts };
        delete catchupOpts.repeat;
        catchupOpts.jobId = `${opts.jobId || jobName}-catchup-${now}`;
        await queue.add(jobName, { ...data, isCatchup: true }, catchupOpts);
      }
    }
  } catch (err) {
    console.warn(`[QUEUE] Failed to determine catch-up for ${jobName}:`, err);
  }
}

export async function initQueues(): Promise<boolean> {
  // Suppress BullMQ's per-queue/worker Redis version warnings (Redis 5 works fine here)
  const _origWarn = console.warn.bind(console);
  console.warn = (...args: any[]) => {
    if (typeof args[0] === 'string' && args[0].includes('minimum Redis version')) return;
    _origWarn(...args);
  };

  // 1. Fail-fast probe to see if Redis is even there
  const probeConnection = makeConnection(true);
  const probe = new Redis({ ...(probeConnection as any), lazyConnect: true });
  probe.on('error', () => {}); // silence ioredis default stderr output during probe

  try {
    await probe.connect();
    // Proactively fix the MISCONF RDB snapshot error to prevent BullMQ/Node from crashing
    try {
      await probe.config('SET', 'stop-writes-on-bgsave-error', 'no');
      console.log('[QUEUE] Disabled stop-writes-on-bgsave-error in Redis to prevent MISCONF crashes.');
    } catch (cfgErr: any) {
      console.warn('[QUEUE] Could not update Redis config:', cfgErr.message);
    }
    await probe.quit();
    console.log('[QUEUE] Redis connection probe successful');
  } catch (err: any) {
    try { probe.disconnect(true); } catch (err: unknown) { console.warn('[QUEUE] probe disconnect failed:', (err as Error).message); }
    console.warn = _origWarn;
    console.warn('[QUEUE] Redis unavailable, disabling BullMQ:', err.message);
    return false;
  }

  // 2. Initialise resilient queues & workers
  const connection = makeConnection(false);
  try {
    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Stock refresh queue (PHASE 1 FIX: Resume daily OHLCV sync) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    stockRefreshQueue = new Queue(QUEUE_STOCK_REFRESH, { connection });

    // Remove any stale repeatable job
    const repeatables = await stockRefreshQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await stockRefreshQueue.removeRepeatableByKey(r.key);
    }
    
    // Daily sync after market close (4 PM IST = 10:30 AM UTC)
    // This ensures OHLCV data is persisted for backtesting
    await addJobWithCatchup(stockRefreshQueue, 
      'refresh-all-daily',
      {},
      {
        repeat: { pattern: '30 10 * * 1-5' },  // 10:30 AM UTC = 4:00 PM IST, weekdays only
        jobId: 'refresh-all-daily-repeatable',
        removeOnComplete: { age: 86400 },   // Keep completed jobs for 1 day
        removeOnFail: { age: 86400, count: 100 },  // Keep failed jobs for 1 day, max 100
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );

    stockWorker = new Worker(
      QUEUE_STOCK_REFRESH,
      processStockRefresh,
      { 
        connection, 
        concurrency: 1,
        lockDuration: 600000, // 10 minutes (Ollama can be very slow)
        lockRenewTime: 120000, // 2 minutes
      },
    );

    stockWorker.on('completed', (job, result) => {
      console.log(`[QUEUE] stock-refresh completed: ${result.count} stocks`);
      recordHeartbeat('stock-refresh', 'success');
    });
    stockWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] stock-refresh failed:`, err.message);
      recordHeartbeat('stock-refresh', 'failed', err?.message);
    });
    stockWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] stock-refresh error:', err.message);
    });

    // Trigger an immediate first refresh (Paused)
    // await addJobWithCatchup(stockRefreshQueue, 'refresh-all', {}, { removeOnComplete: 1 });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ AI signals queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    aiSignalsQueue = new Queue(QUEUE_AI_SIGNALS, { connection });

    signalWorker = new Worker(
      QUEUE_AI_SIGNALS,
      processAISignal,
      {
        connection,
        concurrency: 1,           // Reduced to 1 to prevent CPU thrashing during local Ollama inference
        lockDuration: 1200000,    // 20 minutes (Windows/Ollama can be extremely slow)
        lockRenewTime: 300000,   // 5 minutes renewal
        stalledInterval: 600000, // 10 minutes (Don't check for stalls too frequently)
        maxStalledCount: 2,      // Fewer stalls allowed to trigger fail-fast
        limiter: {
          max: 2,                 // Further reduced to prevent concurrent inference overhead
          duration: 10_000,        
        },
      },
    );

    signalWorker.on('completed', (job) => {
      console.log(`[QUEUE] ai-signals job ${job?.data?.symbol} completed successfully`);
      recordHeartbeat('ai-signals', 'success');
    });

    signalWorker.on('failed', (job, err) => {
      console.warn(`[QUEUE] ai-signals job ${job?.data?.symbol} failed:`, err.message);
      recordHeartbeat('ai-signals', 'failed', err.message);
    });

    signalWorker.on('stalled', (jobId) => {
      console.warn(`[QUEUE] ai-signals job ${jobId} stalled! This usually means the process crashed or the lock expired.`);
    });

    console.log('[QUEUE] BullMQ initialised (stock-refresh + ai-signals)');

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Stock scoring queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    stockScoringQueue = new Queue(QUEUE_STOCK_SCORING, { connection });

    // Repeat every 24 hours
    const scoringRepeatables = await stockScoringQueue.getRepeatableJobs();
    for (const r of scoringRepeatables) {
      await stockScoringQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(stockScoringQueue, 
      'score-all',
      {},
      {
        repeat: { pattern: '0 13 * * 1-5' }, // 6:30 PM IST (13:00 UTC), Mon-Fri after market close
        jobId: 'score-all-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    scoringWorker = new Worker(
      QUEUE_STOCK_SCORING,
      processStockScoring,
      { 
        connection, 
        concurrency: 1,
        lockDuration: 600000, // 10 minutes for heavy scoring sync
      },
    );

    scoringWorker.on('completed', (job) => {
      console.log(`[QUEUE] stock-scoring completed`);
      recordHeartbeat('stock-scoring', 'success');
    });
    scoringWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] stock-scoring failed:`, err.message);
      recordHeartbeat('stock-scoring', 'failed', err?.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ MC screener sync queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    mcScreenerSyncQueue = new Queue(QUEUE_MC_SCREENER_SYNC, { connection });

    // Once daily at 11 PM IST (17:30 UTC) on weekdays — after quant-eod-sync (6 PM IST)
    const mcRepeatables = await mcScreenerSyncQueue.getRepeatableJobs();
    for (const r of mcRepeatables) {
      await mcScreenerSyncQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(mcScreenerSyncQueue,
      'mc-sync',
      {},
      {
        repeat: { pattern: '30 17 * * 1-5' }, // 11 PM IST weekdays
        jobId: 'mc-sync-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    mcScreenerSyncWorker = new Worker(
      QUEUE_MC_SCREENER_SYNC,
      processMcScreenerSync,
      { 
        connection, 
        concurrency: 1,
        lockDuration: 60000,
        lockRenewTime: 20000,
      },
    );

    mcScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] mc-screener-sync completed`);
      recordHeartbeat('mc-screener-sync', 'success');
    });
    mcScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] mc-screener-sync failed:`, err.message);
      recordHeartbeat('mc-screener-sync', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ETNow screener sync queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    etnowScreenerSyncQueue = new Queue(QUEUE_ETNOW_SCREENER_SYNC, { connection });

    // Once daily at 11:30 PM IST (18:00 UTC) on weekdays — staggered after mc-sync
    const etnowRepeatables = await etnowScreenerSyncQueue.getRepeatableJobs();
    for (const r of etnowRepeatables) {
      await etnowScreenerSyncQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(etnowScreenerSyncQueue,
      'etnow-sync',
      {},
      {
        repeat: { pattern: '0 18 * * 1-5' }, // 11:30 PM IST weekdays
        jobId: 'etnow-sync-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    etnowScreenerSyncWorker = new Worker(
      QUEUE_ETNOW_SCREENER_SYNC,
      processEtnowScreenerSync,
      {
        connection,
        concurrency: 1,
        // Syncs ~1,300 screeners sequentially (fetch + 800ms rate-limit delay each) —
        // real runtime is ~35-60 min. The old 60s lockDuration made BullMQ think the
        // job died mid-run every cycle (repeated "could not renew lock" errors).
        lockDuration: 90 * 60 * 1000,   // 90 min
        lockRenewTime: 15 * 60 * 1000,  // 15 min
      },
    );

    etnowScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] etnow-screener-sync completed`);
      recordHeartbeat('etnow-screener-sync', 'success');
    });
    etnowScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] etnow-screener-sync failed:`, err.message);
      recordHeartbeat('etnow-screener-sync', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ NSE sync queue (PHASE 2: Weekly master data update) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    nseScreenerSyncQueue = new Queue(QUEUE_NSE_SYNC, { connection });

    // Remove any stale repeatable job
    const nseRepeatables = await nseScreenerSyncQueue.getRepeatableJobs();
    for (const r of nseRepeatables) {
      await nseScreenerSyncQueue.removeRepeatableByKey(r.key);
    }

    // Repeat weekly on Sunday at 2 AM UTC (7:30 AM IST) for low load time
    await addJobWithCatchup(nseScreenerSyncQueue, 
      'nse-sync-weekly',
      {},
      {
        repeat: { pattern: '0 2 * * 0' },  // Weekly Sunday 2 AM UTC
        jobId: 'nse-sync-weekly-repeatable',
        removeOnComplete: { age: 86400 },   // Keep for 1 day
        removeOnFail: { age: 604800 },      // Keep failures for 7 days
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );

    nseScreenerSyncWorker = new Worker(
      QUEUE_NSE_SYNC,
      processNSESync,
      { 
        connection, 
        concurrency: 1,
        lockDuration: 180000,  // 3 minutes for NSE API calls
      },
    );

    nseScreenerSyncWorker.on('completed', (job) => {
      const result = job.returnvalue as any;
      console.log(`[QUEUE] nse-sync completed (${result?.stockCount || 0} stocks)`);
      recordHeartbeat('nse-sync', 'success');
    });
    nseScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] nse-sync failed:`, err.message);
      recordHeartbeat('nse-sync', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Fundamentals sync queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    fundamentalsSyncQueue = new Queue(QUEUE_FUNDAMENTALS_SYNC, { connection });

    // Weekly repeatable job (Phase 1 + Phase 2 every 7 days)
    const fundRepeatables = await fundamentalsSyncQueue.getRepeatableJobs();
    for (const r of fundRepeatables) {
      await fundamentalsSyncQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(fundamentalsSyncQueue, 
      'sync-fundamentals-weekly',
      { phase2Only: false },
      {
        repeat: { pattern: '0 22 * * 0' }, // Sunday 3:30 AM IST (22:00 UTC Saturday night)
        jobId: 'fundamentals-sync-weekly',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    fundamentalsSyncWorker = new Worker(
      QUEUE_FUNDAMENTALS_SYNC,
      processFundamentalsSync,
      {
        connection,
        concurrency: 1,
        lockDuration: 30 * 60 * 1000,  // 30 min ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Phase 2 deep sync is slow
        lockRenewTime: 5 * 60 * 1000,
      },
    );

    fundamentalsSyncWorker.on('completed', (_job) => {
      console.log('[QUEUE] fundamentals-sync completed');
      recordHeartbeat('fundamentals-sync', 'success');
    });
    fundamentalsSyncWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] fundamentals-sync failed:', err.message);
      recordHeartbeat('fundamentals-sync', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Quant scoring queue (daily) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    quantScoringQueue = new Queue(QUEUE_QUANT_SCORING, { connection });

    const quantRepeatables = await quantScoringQueue.getRepeatableJobs();
    for (const r of quantRepeatables) {
      await quantScoringQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(quantScoringQueue, 
      'quant-score-daily',
      {},
      {
        repeat: { pattern: '30 13 * * 1-5' }, // 7:00 PM IST (13:30 UTC), Mon-Fri after stock scoring
        jobId: 'quant-scoring-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    quantScoringWorker = new Worker(
      QUEUE_QUANT_SCORING,
      processQuantScoring,
      {
        connection,
        concurrency: 1,
        lockDuration: 10 * 60 * 1000, // 10 min ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pure in-process computation
        lockRenewTime: 2 * 60 * 1000,
      },
    );

    quantScoringWorker.on('completed', (_job) => {
      console.log('[QUEUE] quant-scoring completed');
      recordHeartbeat('quant-scoring', 'success');
    });
    quantScoringWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] quant-scoring failed:', err.message);
      recordHeartbeat('quant-scoring', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Technical signals queue (every 30 minutes) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    technicalSignalsQueue = new Queue(QUEUE_TECHNICAL_SIGNALS, { connection });

    const tsRepeatables = await technicalSignalsQueue.getRepeatableJobs();
    for (const r of tsRepeatables) {
      await technicalSignalsQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(technicalSignalsQueue, 
      'technical-signals-daily',
      {},
      {
        repeat: { pattern: '*/30 * * * *' }, // Run every 30 minutes
        jobId: 'technical-signals-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    technicalSignalsWorker = new Worker(
      QUEUE_TECHNICAL_SIGNALS,
      async (_job: Job) => {
        const { runTechnicalSignalScan } = await import('./technicalSignalsService');
        await runTechnicalSignalScan();
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 15 * 60 * 1000, // 15 min
        lockRenewTime: 3 * 60 * 1000,
      },
    );

    technicalSignalsWorker.on('completed', (_job) => {
      console.log('[QUEUE] technical-signals completed');
      updateMonitorState('technical-scan', 'success');
    });
    technicalSignalsWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] technical-signals failed:', err.message);
      updateMonitorState('technical-scan', 'failed', err.message);
    });
    technicalSignalsWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] technical-signals error:', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Signal outcomes queue (daily, resolves 5D + 15D win rates) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    signalOutcomesQueue = new Queue(QUEUE_SIGNAL_OUTCOMES, { connection });

    const outRepeatables = await signalOutcomesQueue.getRepeatableJobs();
    for (const r of outRepeatables) {
      await signalOutcomesQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(signalOutcomesQueue, 
      'signal-outcomes-daily',
      {},
      {
        repeat: { pattern: '30 3 * * 1-5' }, // 9:00 AM IST, MonÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“Fri (30 min after signals)
        jobId: 'signal-outcomes-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    signalOutcomesWorker = new Worker(
      QUEUE_SIGNAL_OUTCOMES,
      async (_job: Job) => {
        const { computeSignalOutcomes } = await import('./signalOutcomesService');
        await computeSignalOutcomes(5);
        await computeSignalOutcomes(15);
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 5 * 60 * 1000,
        lockRenewTime: 60 * 1000,
      },
    );

    signalOutcomesWorker.on('completed', (_job) => {
      console.log('[QUEUE] signal-outcomes completed');
      recordHeartbeat('signal-outcomes', 'success');
    });
    signalOutcomesWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] signal-outcomes failed:', err.message);
      recordHeartbeat('signal-outcomes', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ News sentiment queue (every 30 seconds) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    newsSentimentQueue = new Queue(QUEUE_NEWS_SENTIMENT, { connection });

    const newsRepeatables = await newsSentimentQueue.getRepeatableJobs();
    for (const r of newsRepeatables) {
      await newsSentimentQueue.removeRepeatableByKey(r.key);
    }
    await Promise.all([
      addJobWithCatchup(newsSentimentQueue,
        'news-sentiment-refresh',
        {},
        {
          // 15 min: RSS feeds lag ~15-30 min, so a tighter cadence just re-fetches
          // identical articles across 23 sources (wasted requests + block risk).
          repeat: { every: 15 * 60 * 1000 },
          jobId: 'news-sentiment-repeatable',
          removeOnComplete: 5,
          removeOnFail: 3,
        },
      ),
      // Per-company Google News (free, per-stock density) — slower cadence, polite to Google.
      addJobWithCatchup(newsSentimentQueue,
        'company-news-refresh',
        {},
        {
          repeat: { every: 6 * 60 * 60 * 1000 }, // every 6 hours
          jobId: 'company-news-repeatable',
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      ),
      // BSE corporate announcements (per-stock, high-signal events) — hourly captures
      // intraday + after-close filings without hammering the endpoint.
      addJobWithCatchup(newsSentimentQueue,
        'bse-announcements-refresh',
        {},
        {
          repeat: { every: 60 * 60 * 1000 }, // every hour
          jobId: 'bse-announcements-repeatable',
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      ),
    ]);

    newsSentimentWorker = new Worker(
      QUEUE_NEWS_SENTIMENT,
      async (job: Job) => {
        const svc = await import('./newsSentimentService');
        if (job.name === 'company-news-refresh') {
          await svc.runCompanyNewsCycle();
        } else if (job.name === 'bse-announcements-refresh') {
          await svc.runBseAnnouncementsCycle();
        } else {
          await svc.runNewsSentimentCycle();
        }
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 5 * 60 * 1000,
        lockRenewTime: 60 * 1000,
      },
    );

    newsSentimentWorker.on('completed', (_job) => {
      console.log('[QUEUE] news-sentiment completed');
      recordHeartbeat('news-sentiment', 'success');
    });
    newsSentimentWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] news-sentiment failed:', err.message);
      recordHeartbeat('news-sentiment', 'failed', err?.message);
    });
    newsSentimentWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] news-sentiment error:', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Trendlyne intraday queue (every 5 min) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    trendlyneIntradayQueue = new Queue(QUEUE_TRENDLYNE_INTRADAY, { connection });

    const tlRepeatables = await trendlyneIntradayQueue.getRepeatableJobs();
    for (const r of tlRepeatables) {
      await trendlyneIntradayQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(trendlyneIntradayQueue, 
      'trendlyne-intraday-scan',
      {},
      {
        repeat: { every: 15 * 60 * 1000 }, // 15 minutes
        jobId: 'trendlyne-intraday-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    trendlyneIntradayWorker = new Worker(
      QUEUE_TRENDLYNE_INTRADAY,
      async (_job: Job) => {
        if (!(await isMarketOpen())) {
          console.log('[QUEUE] intraday-scan skipped — outside NSE market hours');
          return;
        }
        console.log('[QUEUE] Starting scheduled 15-min intraday screener scan...');
        const { runIntradayScreenerScan } = await import('./trendlyneScreener');
        await runIntradayScreenerScan();
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 8 * 60 * 1000,
      },
    );

    trendlyneIntradayWorker.on('completed', (_job) => {
      console.log('[QUEUE] trendlyne-intraday completed');
      recordHeartbeat('trendlyne-intraday', 'success');
    });
    trendlyneIntradayWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-intraday failed:', err.message);
      recordHeartbeat('trendlyne-intraday', 'failed', err.message);
    });
    trendlyneIntradayWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] trendlyne-intraday error:', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Outcome resolver queue (daily at 9:30 AM IST = 04:00 UTC, weekdays) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    outcomeResolverQueue = new Queue(QUEUE_OUTCOME_RESOLVER, { connection });

    const orRepeatables = await outcomeResolverQueue.getRepeatableJobs();
    for (const r of orRepeatables) {
      await outcomeResolverQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(outcomeResolverQueue, 
      'outcome-resolver-daily',
      {},
      {
        repeat: { pattern: '0 4 * * 1-5' },
        jobId: 'outcome-resolver-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    outcomeResolverWorker = new Worker(
      QUEUE_OUTCOME_RESOLVER,
      processOutcomeResolver,
      {
        connection,
        concurrency: 1,
        lockDuration: 10 * 60 * 1000,
        lockRenewTime: 2 * 60 * 1000,
      },
    );

    outcomeResolverWorker.on('completed', (_job) => {
      console.log('[QUEUE] outcome-resolver completed');
      recordHeartbeat('outcome-resolver', 'success');
      updateMonitorState('outcome-resolver-5d', 'success');
      updateMonitorState('outcome-resolver-15d', 'success');
      updateMonitorState('performance-tracker', 'success');
    });
    outcomeResolverWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] outcome-resolver failed:', err.message);
      recordHeartbeat('outcome-resolver', 'failed', err?.message);
      updateMonitorState('outcome-resolver-5d', 'failed', err.message);
      updateMonitorState('outcome-resolver-15d', 'failed', err.message);
      updateMonitorState('performance-tracker', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ML daily ops queue (5:00 PM IST = 11:30 UTC, weekdays) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    mlDailyOpsQueue = new Queue(QUEUE_ML_DAILY_OPS, { connection });

    const mlRepeatables = await mlDailyOpsQueue.getRepeatableJobs();
    for (const r of mlRepeatables) {
      await mlDailyOpsQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(mlDailyOpsQueue, 
      'ml-daily-ops',
      {},
      {
        repeat: { pattern: '30 11 * * 1-5' },
        jobId: 'ml-daily-ops',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    mlDailyOpsWorker = new Worker(
      QUEUE_ML_DAILY_OPS,
      processMlDailyOps,
      {
        connection,
        concurrency: 1,
        // lockDuration short so stalled jobs re-queue fast on server restart.
        // Scripts use ON CONFLICT DO UPDATE so re-running from start is safe.
        lockDuration: 30 * 60 * 1000,  // 30 min — stall detected quickly on PM2 restart
        lockRenewTime: 5 * 60 * 1000,
      },
    );

    mlDailyOpsWorker.on('completed', (_job) => {
      console.log('[QUEUE] ml-daily-ops completed');
      recordHeartbeat('ml-daily-ops', 'success');
      updateMonitorState('fii-dii-fetcher', 'success');
      updateMonitorState('finbert-scorer', 'success');
      updateMonitorState('outcome-resolver-5d', 'success');
      updateMonitorState('outcome-resolver-15d', 'success');
      updateMonitorState('performance-tracker', 'success');
      updateMonitorState('ml-ensemble-score', 'success');
      updateMonitorState('ml-ensemble-incremental', 'success');
      updateMonitorState('drift-detector', 'success');
      updateMonitorState('reward-engine', 'success');
      updateMonitorState('rl-agent-update', 'success');
      updateMonitorState('signal-type-stats', 'success');
    });
    mlDailyOpsWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] ml-daily-ops failed:', err.message);
      recordHeartbeat('ml-daily-ops', 'failed', err?.message);
      updateMonitorState('ml-ensemble-score', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ML weekly retrain + optimize (Sunday 6 PM IST = 12:30 UTC) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    mlWeeklyRetrainQueue = new Queue(QUEUE_ML_WEEKLY_RETRAIN, { connection });
    const mlWkRep = await mlWeeklyRetrainQueue.getRepeatableJobs();
    for (const r of mlWkRep) await mlWeeklyRetrainQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(mlWeeklyRetrainQueue, 'ml-weekly-retrain', {}, {
      repeat: { pattern: '30 12 * * 0' },
      jobId: 'ml-weekly-retrain',
      removeOnComplete: 2, removeOnFail: 3,
    });
    mlWeeklyRetrainWorker = new Worker(QUEUE_ML_WEEKLY_RETRAIN, processMlWeeklyRetrain, { connection, concurrency: 1, lockDuration: 30 * 60 * 1000, lockRenewTime: 5 * 60 * 1000 });
    mlWeeklyRetrainWorker.on('completed', () => {
      console.log('[QUEUE] ml-weekly-retrain done');
      updateMonitorState('ml-ensemble-train', 'success');
      updateMonitorState('strategy-optimizer', 'success');
    });
    mlWeeklyRetrainWorker.on('failed', (_, err) => {
      console.error('[QUEUE] ml-weekly-retrain failed:', err.message);
      updateMonitorState('ml-ensemble-train', 'failed', err.message);
      updateMonitorState('strategy-optimizer', 'failed', err.message);
    });

    // ── Intraday fetcher (every 30 min, 8:30 AM - 4:00 PM IST = 3:00-10:30 UTC, weekdays)
    intradayFetcherQueue = new Queue(QUEUE_INTRADAY_FETCHER, { connection });
    const intradayRep = await intradayFetcherQueue.getRepeatableJobs();
    for (const r of intradayRep) await intradayFetcherQueue.removeRepeatableByKey(r.key);
    await intradayFetcherQueue.add('intraday-fetcher', {}, {
      repeat: { pattern: '*/30 3-10 * * 1-5', tz: 'Etc/UTC' },
      jobId: 'intraday-fetcher',
      removeOnComplete: 5,
      removeOnFail: 3,
    });
    intradayFetcherWorker = new Worker(
      QUEUE_INTRADAY_FETCHER,
      processIntradayFetcher,
      { connection, concurrency: 1, lockDuration: 10 * 60 * 1000, lockRenewTime: 2 * 60 * 1000 },
    );
    intradayFetcherWorker.on('completed', () => {
      console.log('[QUEUE] intraday-fetcher completed');
      recordHeartbeat('intraday-fetcher', 'success');
    });
    intradayFetcherWorker.on('failed', (_, err) => {
      console.error('[QUEUE] intraday-fetcher failed:', err.message);
      recordHeartbeat('intraday-fetcher', 'failed', err?.message);
    });

    // ── Live Screener paced collector (every 15 min during market hours: 3:30-10:00 UTC = 9:00-15:30 IST)
    liveScreenerCollectQueue = new Queue(QUEUE_LIVE_SCREENER_COLLECT, { connection });
    const lsRepeatables = await liveScreenerCollectQueue.getRepeatableJobs();
    for (const r of lsRepeatables) await liveScreenerCollectQueue.removeRepeatableByKey(r.key);
    await liveScreenerCollectQueue.add('live-screener-collect', {}, {
      repeat: { pattern: '*/15 3-10 * * 1-5', tz: 'Etc/UTC' },
      jobId: 'live-screener-collect-repeatable',
      removeOnComplete: 5,
      removeOnFail: 3,
    });
    liveScreenerCollectWorker = new Worker(
      QUEUE_LIVE_SCREENER_COLLECT,
      processLiveScreenerCollect,
      { connection, concurrency: 1, lockDuration: 8 * 60 * 1000 }
    );
    liveScreenerCollectWorker.on('completed', () => {
      console.log('[QUEUE] live-screener-collect completed');
      recordHeartbeat('live-screener-collect', 'success');
    });
    liveScreenerCollectWorker.on('failed', (_, err) => {
      console.error('[QUEUE] live-screener-collect failed:', err.message);
      recordHeartbeat('live-screener-collect', 'failed', err.message);
    });


    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Research report queues ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    researchPremarketQueue = new Queue(QUEUE_RESEARCH_PREMARKET, { connection });
    const premarketRep = await researchPremarketQueue.getRepeatableJobs();
    for (const r of premarketRep) await researchPremarketQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(researchPremarketQueue, 'research-premarket-daily', {}, {
      repeat: { pattern: '0 3 * * 1-5' },
      jobId: 'research-premarket-repeatable',
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
    researchPremarketWorker = new Worker(QUEUE_RESEARCH_PREMARKET, processResearchPremarket,
      { connection, concurrency: 1, lockDuration: 15 * 60 * 1000 });
    researchPremarketWorker.on('completed', () => {
      console.log('[QUEUE] research-premarket done');
      recordHeartbeat('research-premarket', 'success');
    });
    researchPremarketWorker.on('failed', (_, err) => {
      console.error('[QUEUE] research-premarket failed:', err.message);
      recordHeartbeat('research-premarket', 'failed', err.message);
    });

    researchPostcloseQueue = new Queue(QUEUE_RESEARCH_POSTCLOSE, { connection });
    const postcloseRep = await researchPostcloseQueue.getRepeatableJobs();
    for (const r of postcloseRep) await researchPostcloseQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(researchPostcloseQueue, 'research-postclose-daily', {}, {
      repeat: { pattern: '45 10 * * 1-5' },
      jobId: 'research-postclose-repeatable',
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
    researchPostcloseWorker = new Worker(QUEUE_RESEARCH_POSTCLOSE, processResearchPostclose,
      { connection, concurrency: 1, lockDuration: 15 * 60 * 1000 });
    researchPostcloseWorker.on('completed', () => {
      console.log('[QUEUE] research-postclose done');
      recordHeartbeat('research-postclose', 'success');
    });
    researchPostcloseWorker.on('failed', (_, err) => {
      console.error('[QUEUE] research-postclose failed:', err.message);
      recordHeartbeat('research-postclose', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Macro Fetch (8:00 AM IST = 2:30 AM UTC, weekdays) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlMacroFetchQueue = new Queue(QUEUE_DL_MACRO_FETCH, { connection });
    const dlMacroRep = await dlMacroFetchQueue.getRepeatableJobs();
    for (const r of dlMacroRep) await dlMacroFetchQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(dlMacroFetchQueue, 'dl-macro-daily', {}, {
      repeat: { pattern: '30 2 * * 1-5' },
      jobId: 'dl-macro-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlMacroFetchWorker = new Worker(QUEUE_DL_MACRO_FETCH,
      async () => {
        await processDLPython('global_macro_fetcher.py');
        // MC global: 15 indices (Nikkei/HangSeng/KOSPI/etc) + currencies + ADRs + commodities → mc_global_snapshot + macro_asset_prices.
        await runPython('mc_global_macro_fetcher.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] mc_global_macro_fetcher failed:', (e as Error).message));
        // Sector-global correlation depends on macro_asset_prices populated above.
        await runPython('sector_global_corr.py', [], 3 * 60_000)
          .catch(e => console.warn('[QUEUE] sector_global_corr failed:', (e as Error).message));
        // Bond yields (India G-Sec + US/UK/DE 10yr) are now fetched inside global_macro_fetcher.py.
      },
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 });
    dlMacroFetchWorker.on('completed', () => {
      console.log('[QUEUE] dl-macro-fetch done');
      recordHeartbeat('dl-macro-fetch', 'success');
    });

    // ── Pre-open snapshot (3:40 AM UTC = 9:10 AM IST, weekdays) ──────────────────────────
    // GIFT Nifty level + Asia sentiment + global risk score captured before Indian market opens.
    const QUEUE_PREOPEN = 'preopen-snapshot';
    const preopenQueue = new Queue(QUEUE_PREOPEN, { connection });
    const preopenRep = await preopenQueue.getRepeatableJobs();
    for (const r of preopenRep) await preopenQueue.removeRepeatableByKey(r.key);
    await preopenQueue.add('preopen-daily', {}, {
      repeat: { pattern: '40 3 * * 1-5' },
      jobId: 'preopen-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    new Worker(QUEUE_PREOPEN,
      async () => {
        await runPython('preopen_fetcher.py', [], 60_000)
          .then(() => recordHeartbeat('preopen-snapshot', 'success'))
          .catch(e => {
            console.warn('[QUEUE] preopen_fetcher failed:', (e as Error).message);
            recordHeartbeat('preopen-snapshot', 'failed', (e as Error).message);
          });

        console.log('[QUEUE] Running early_hours_predictor...');
        await runPython('early_hours_predictor.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] early_hours_predictor failed:', (e as Error).message));
      },
      { connection, concurrency: 1 });
    console.log('[QUEUE] Pre-open snapshot scheduled at 9:10 AM IST (weekdays)');
    dlMacroFetchWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-macro-fetch failed:', err.message);
      recordHeartbeat('dl-macro-fetch', 'failed', err.message);
    });

    // ── Intraday regime refresh: VIX + USDINR + Nifty basis every 15 min (9:15–15:30 IST) ──
    const QUEUE_REGIME = 'market-regime-refresh';
    const regimeQueue = new Queue(QUEUE_REGIME, { connection });
    const regimeRep = await regimeQueue.getRepeatableJobs();
    for (const r of regimeRep) await regimeQueue.removeRepeatableByKey(r.key);
    await regimeQueue.add('regime-intraday', {}, {
      repeat: { pattern: '*/15 3-10 * * 1-5' },  // 3:45–10:00 UTC = 9:15–15:30 IST
      jobId: 'regime-intraday',
      removeOnComplete: 3, removeOnFail: 3,
    });
    new Worker(QUEUE_REGIME,
      async () => {
        await runPython('market_regime_fetcher.py', [], 60_000)
          .then(() => recordHeartbeat('market-regime-refresh', 'success'))
          .catch(e => {
            console.warn('[QUEUE] market_regime_fetcher failed:', (e as Error).message);
            recordHeartbeat('market-regime-refresh', 'failed', (e as Error).message);
          });
      },
      // Default lockDuration (30s) is shorter than runPython's own 60s process timeout,
      // and runPython can additionally block well past that waiting for a free slot in
      // its shared 5-concurrent-subprocess semaphore during busy periods — causing BullMQ
      // to consider the job stalled and repeatedly fail to renew a lock that's already
      // been reassigned. Match the generous lockDuration convention used by sibling workers.
      { connection, concurrency: 1, lockDuration: 5 * 60_000 });
    console.log('[QUEUE] Market regime refresh scheduled every 15 min during market hours');

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Feature Refresh (3:30 PM IST = 10:00 AM UTC, weekdays) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlFeatureRefreshQueue = new Queue(QUEUE_DL_FEATURE_REFRESH, { connection });
    const dlFeatRep = await dlFeatureRefreshQueue.getRepeatableJobs();
    for (const r of dlFeatRep) await dlFeatureRefreshQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(dlFeatureRefreshQueue, 'dl-feature-daily', {}, {
      repeat: { pattern: '0 10 * * 1-5' },
      jobId: 'dl-feature-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlFeatureRefreshWorker = new Worker(QUEUE_DL_FEATURE_REFRESH,
      async () => processDLPython('feature_engineering.py'),
      { connection, concurrency: 1, lockDuration: 60 * 60 * 1000, lockRenewTime: 10 * 60 * 1000 });
    dlFeatureRefreshWorker.on('completed', () => {
      console.log('[QUEUE] dl-feature-refresh done');
      recordHeartbeat('dl-feature-refresh', 'success');
    });
    dlFeatureRefreshWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-feature-refresh failed:', err.message);
      recordHeartbeat('dl-feature-refresh', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Inference (4:30 PM IST = 11:00 AM UTC, weekdays) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlInferenceQueue = new Queue(QUEUE_DL_INFERENCE, { connection });
    const dlInfRep = await dlInferenceQueue.getRepeatableJobs();
    for (const r of dlInfRep) await dlInferenceQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(dlInferenceQueue, 'dl-infer-daily', {}, {
      repeat: { pattern: '0 17 * * 1-5' },  // 10:30 PM IST — low-load window after all market jobs
      jobId: 'dl-infer-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlInferenceWorker = new Worker(QUEUE_DL_INFERENCE,
      async () => processDLPython('dl_engine.py', ['--mode', 'infer']),
      { connection, concurrency: 1, lockDuration: 30 * 60 * 1000, lockRenewTime: 5 * 60 * 1000 });
    dlInferenceWorker.on('completed', () => {
      console.log('[QUEUE] dl-inference done');
      updateMonitorState('dl-engine-infer', 'success');
    });
    dlInferenceWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-inference failed:', err.message);
      updateMonitorState('dl-engine-infer', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Regime Update (4:45 PM IST = 11:15 AM UTC, weekdays) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlRegimeUpdateQueue = new Queue(QUEUE_DL_REGIME_UPDATE, { connection });
    const dlRegRep = await dlRegimeUpdateQueue.getRepeatableJobs();
    for (const r of dlRegRep) await dlRegimeUpdateQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(dlRegimeUpdateQueue, 'dl-regime-daily', {}, {
      repeat: { pattern: '15 11 * * 1-5' },
      jobId: 'dl-regime-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlRegimeUpdateWorker = new Worker(QUEUE_DL_REGIME_UPDATE,
      async () => processDLPython('regime_detector.py', ['--mode', 'update']),
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 });
    dlRegimeUpdateWorker.on('completed', () => {
      console.log('[QUEUE] dl-regime-update done');
      updateMonitorState('regime-detector', 'success');
    });
    dlRegimeUpdateWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-regime-update failed:', err.message);
      updateMonitorState('regime-detector', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Weekly Retrain (Sunday 11:00 PM IST = Sun 17:30 UTC) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlRetrainWeeklyQueue = new Queue(QUEUE_DL_RETRAIN_WEEKLY, { connection });
    const dlWkRep = await dlRetrainWeeklyQueue.getRepeatableJobs();
    for (const r of dlWkRep) await dlRetrainWeeklyQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(dlRetrainWeeklyQueue, 'dl-retrain-weekly', {}, {
      repeat: { pattern: '30 17 * * 0' },
      jobId: 'dl-retrain-weekly',
      removeOnComplete: 2, removeOnFail: 3,
    });
    dlRetrainWeeklyWorker = new Worker(QUEUE_DL_RETRAIN_WEEKLY,
      async (_job: Job) => {
        const trigger = _job.data?.trigger || 'scheduled';
        return processDLPython('dl_trainer.py', ['--trigger', trigger]);
      },
      { connection, concurrency: 1, lockDuration: 6 * 60 * 60 * 1000, lockRenewTime: 30 * 60 * 1000 });
    dlRetrainWeeklyWorker.on('completed', () => {
      console.log('[QUEUE] dl-retrain-weekly done');
      updateMonitorState('dl-trainer', 'success');
    });
    dlRetrainWeeklyWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-retrain-weekly failed:', err.message);
      updateMonitorState('dl-trainer', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Emergency Retrain (on-demand, triggered by drift detector) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlRetrainEmergencyQueue = new Queue(QUEUE_DL_RETRAIN_EMERGENCY, { connection });
    dlRetrainEmergencyWorker = new Worker(QUEUE_DL_RETRAIN_EMERGENCY,
      async () => processDLPython('dl_trainer.py', ['--trigger', 'drift']),
      { connection, concurrency: 1, lockDuration: 6 * 60 * 60 * 1000, lockRenewTime: 30 * 60 * 1000 });
    dlRetrainEmergencyWorker.on('completed', () => {
      console.log('[QUEUE] dl-retrain-emergency done');
      recordHeartbeat('dl-retrain-emergency', 'success');
    });
    dlRetrainEmergencyWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-retrain-emergency failed:', err.message);
      recordHeartbeat('dl-retrain-emergency', 'failed', err.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ OHLCV Backfill ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    // Worker handles both one-time full backfill and recurring weekly gap-fill
    ohlcvBackfillQueue = new Queue(QUEUE_OHLCV_BACKFILL, { connection });
    ohlcvBackfillWorker = new Worker(QUEUE_OHLCV_BACKFILL,
      async (job: Job) => {
        const mode = (job.data?.mode as string) || 'gap-fill';
        const lookback = (job.data?.lookback as number) || 30;
        return processDLPython('backfill_ohlcv.py', ['--mode', mode, '--lookback', String(lookback)]);
      },
      { connection, concurrency: 1, lockDuration: 3 * 60 * 60 * 1000, lockRenewTime: 15 * 60 * 1000 });
    ohlcvBackfillWorker.on('completed', (job) => {
      console.log(`[QUEUE] ohlcv-backfill (${job.data?.mode}) done`);
      updateMonitorState('ohlcv-backfill', 'success');
    });
    ohlcvBackfillWorker.on('failed', (_, err) => {
      console.error('[QUEUE] ohlcv-backfill failed:', err.message);
      updateMonitorState('ohlcv-backfill', 'failed', err.message);
    });

    // Weekly gap-fill: Saturday 2:00 AM IST = Friday 20:30 UTC
    // Daily gap-fill: weekdays 4:15 PM IST = 10:45 UTC (after market close, lookback 3 days)
    const ohlcvRep = await ohlcvBackfillQueue.getRepeatableJobs();
    for (const r of ohlcvRep) await ohlcvBackfillQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(ohlcvBackfillQueue, 'ohlcv-gap-fill-weekly', { mode: 'gap-fill', lookback: 30 }, {
      repeat: { pattern: '30 20 * * 5' },
      jobId: 'ohlcv-gap-fill-weekly',
      removeOnComplete: 2, removeOnFail: 3,
    });
    await addJobWithCatchup(ohlcvBackfillQueue, 'ohlcv-gap-fill-daily', { mode: 'gap-fill', lookback: 3 }, {
      repeat: { pattern: '45 10 * * 1-5' },
      jobId: 'ohlcv-gap-fill-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });

    // Startup check: if stock_ohlcv has fewer than 1000 rows trigger full backfill once
    const ohlcvCount = ((await dbGet<any>('SELECT COUNT(*) as c FROM stock_ohlcv'))?.c) ?? 0;
    if (ohlcvCount < 1000) {
      console.log(`[QUEUE] stock_ohlcv sparse (${ohlcvCount} rows) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â queuing full backfill`);
      await addJobWithCatchup(ohlcvBackfillQueue, 'ohlcv-full-backfill-startup', { mode: 'full' }, {
        jobId: 'ohlcv-full-backfill-startup',
        removeOnComplete: 1, removeOnFail: 3,
      });
    } else {
      // Always ensure NIFTY50 index history is present
      const niftyCount = ((await dbGet<any>("SELECT COUNT(*) as c FROM stock_ohlcv WHERE symbol='NIFTY50'"))?.c) ?? 0;
      if (niftyCount === 0) {
        console.log('[QUEUE] NIFTY50 missing from stock_ohlcv ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â queuing index backfill');
        await addJobWithCatchup(ohlcvBackfillQueue, 'ohlcv-indices-startup', { mode: 'indices' }, {
          jobId: 'ohlcv-indices-startup',
          removeOnComplete: 1, removeOnFail: 3,
        });
      }
    }

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Confluence Compute Queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    confluenceComputeQueue = new Queue(QUEUE_CONFLUENCE_COMPUTE, { connection: makeConnection() });
    confluenceComputeWorker = new Worker(
      QUEUE_CONFLUENCE_COMPUTE,
      processConfluenceCompute,
      { connection: makeConnection(), concurrency: 1 }
    );
    confluenceComputeWorker.on('completed', () => {
      recordHeartbeat('confluence-compute', 'success');
    });
    confluenceComputeWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} job failed:`, err.message);
      recordHeartbeat('confluence-compute', 'failed', err.message);
    });
    confluenceComputeWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} error:`, err.message);
    });
    await addJobWithCatchup(confluenceComputeQueue, 
      'confluence-compute',
      {},
      { repeat: { every: 30 * 60 * 1000 }, removeOnComplete: 3, removeOnFail: 3 }
    );

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Confluence Outcomes Queue ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    confluenceOutcomesQueue = new Queue(QUEUE_CONFLUENCE_OUTCOMES, { connection: makeConnection() });
    confluenceOutcomesWorker = new Worker(
      QUEUE_CONFLUENCE_OUTCOMES,
      processConfluenceOutcomes,
      { connection: makeConnection(), concurrency: 1 }
    );
    confluenceOutcomesWorker.on('completed', () => {
      recordHeartbeat('confluence-outcomes', 'success');
    });
    confluenceOutcomesWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_OUTCOMES} job failed:`, err.message);
      recordHeartbeat('confluence-outcomes', 'failed', err.message);
    });
    await addJobWithCatchup(confluenceOutcomesQueue,
      'confluence-outcomes-daily',
      {},
      { repeat: { pattern: '30 17 * * 1-5' }, removeOnComplete: 3, removeOnFail: 3 }  // 11:00 PM IST — after dl-inference
    );
    console.log('[QUEUE] confluence-compute (every 30 min) + confluence-outcomes (daily) registered');

    // Ã¢â€â‚¬Ã¢â€â‚¬ Screener performance queue (daily 6 PM IST = 12:30 UTC, weekdays) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    screenerPerfQueue = new Queue(QUEUE_SCREENER_PERFORMANCE, { connection });

    const screenerPerfRepeatables = await screenerPerfQueue.getRepeatableJobs();
    for (const r of screenerPerfRepeatables) {
      await screenerPerfQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(screenerPerfQueue, 
      'screener-performance-daily',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 },
        jobId: 'screener-performance-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    screenerPerfWorker = new Worker(
      QUEUE_SCREENER_PERFORMANCE,
      processScreenerPerf,
      { connection, concurrency: 1, lockDuration: 20 * 60 * 1000, lockRenewTime: 5 * 60 * 1000 },
    );

    screenerPerfWorker.on('completed', () => {
      console.log('[QUEUE] screener-performance completed');
      updateMonitorState('screener-performance', 'success');
    });
    screenerPerfWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] screener-performance failed:', err.message);
      updateMonitorState('screener-performance', 'failed', err.message);
    });
    screenerPerfWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] screener-performance error:', err.message);
    });

    console.log('[QUEUE] screener-performance (daily 6PM IST weekdays) registered');

    // Ã¢â€â‚¬Ã¢â€â‚¬ Agent: Data Scientist (07:00 IST = 01:30 UTC, weekdays) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    agentDataScientistQueue = new Queue(QUEUE_AGENT_DATA_SCIENTIST, { connection });
    const adsRep = await agentDataScientistQueue.getRepeatableJobs();
    for (const r of adsRep) await agentDataScientistQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(agentDataScientistQueue, 'agent-ds-daily', {}, {
      repeat: { pattern: '30 1 * * 1-5' },
      jobId: 'agent-ds-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentDataScientistWorker = new Worker(QUEUE_AGENT_DATA_SCIENTIST,
      processAgentDataScientist, { connection, concurrency: 1, lockDuration: 10 * 60_000 });
    agentDataScientistWorker.on('completed', (_, r: any) => {
      console.log('[QUEUE] agent-ds done, grade=', r?.grade);
      recordHeartbeat('agent-data-scientist', 'success');
    });
    agentDataScientistWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-ds failed:', e.message);
      recordHeartbeat('agent-data-scientist', 'failed', e.message);
    });

    // Ã¢â€â‚¬Ã¢â€â‚¬ Agent: Strategist (08:30 IST = 03:00 UTC, weekdays) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    agentStrategistQueue = new Queue(QUEUE_AGENT_STRATEGIST, { connection });
    const asRep = await agentStrategistQueue.getRepeatableJobs();
    for (const r of asRep) await agentStrategistQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(agentStrategistQueue, 'agent-strat-daily', {}, {
      repeat: { pattern: '0 3 * * 1-5' },
      jobId: 'agent-strat-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentStrategistWorker = new Worker(QUEUE_AGENT_STRATEGIST,
      processAgentStrategist, { connection, concurrency: 1, lockDuration: 15 * 60_000 });
    agentStrategistWorker.on('completed', () => {
      console.log('[QUEUE] agent-strategist done');
      recordHeartbeat('agent-strategist', 'success');
    });
    agentStrategistWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-strategist failed:', e.message);
      recordHeartbeat('agent-strategist', 'failed', e.message);
    });

    // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Company Profiles & AI Analysis Sync queue (Weekly) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

    // ----------------------------------------------------
    // End Of Day Quant Sync queue (Daily 12:30 UTC / 18:00 IST)
    // ----------------------------------------------------
    quantEodSyncQueue = new Queue(QUEUE_QUANT_EOD_SYNC, { connection });

    const qeRepeatables = await quantEodSyncQueue.getRepeatableJobs();
    for (const r of qeRepeatables) {
      await quantEodSyncQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(quantEodSyncQueue, 
      'sync-quant-eod',
      {},
      {
        repeat: { pattern: '30 12 * * 1-5' },
        jobId: 'quant-eod-sync-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    quantEodSyncWorker = new Worker(
      QUEUE_QUANT_EOD_SYNC,
      processQuantEodSync,
      { connection, concurrency: 1, lockDuration: 120 * 60_000 }
    );
    quantEodSyncWorker.on('completed', () => console.log('[QUEUE] quant-eod-sync done'));
    quantEodSyncWorker.on('failed', (_, e) => console.error('[QUEUE] quant-eod-sync failed:', e.message));

    trendlyneDailyFetchQueue = new Queue(QUEUE_TRENDLYNE_DAILY_FETCH, { connection });

    const dailyFetchRepeatables = await trendlyneDailyFetchQueue.getRepeatableJobs();
    for (const r of dailyFetchRepeatables) {
      await trendlyneDailyFetchQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(trendlyneDailyFetchQueue,
      'trendlyne-daily-fetch',
      {},
      {
        repeat: { pattern: '30 4 * * 1-5' },
        jobId: 'trendlyne-daily-fetch-daily',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    trendlyneDailyFetchWorker = new Worker(
      QUEUE_TRENDLYNE_DAILY_FETCH,
      async (job: Job) => {
        if (!job.data || !job.data.symbol) {
          const symbols = getTrendlyneMetricSymbols();
          await enqueueTrendlyneMetricsFetchJobs(trendlyneDailyFetchQueue!, symbols, 12);
          return;
        }
        await runTrendlyneMetricsFetch(job.data.symbol);
      },
      { connection, concurrency: 2, lockDuration: 30 * 60_000 }
    );

    trendlyneDailyFetchWorker.on('completed', () => console.log('[QUEUE] trendlyne-daily-fetch completed'));
    trendlyneDailyFetchWorker.on('failed', (_, e) => console.error('[QUEUE] trendlyne-daily-fetch failed:', e.message));

    companyProfilesSyncQueue = new Queue(QUEUE_COMPANY_PROFILES_SYNC, { connection });

    const cpRepeatables = await companyProfilesSyncQueue.getRepeatableJobs();
    for (const r of cpRepeatables) {
      await companyProfilesSyncQueue.removeRepeatableByKey(r.key);
    }
    await addJobWithCatchup(companyProfilesSyncQueue, 
      'sync-company-profiles',
      {},
      {
        repeat: { pattern: '0 4 * * 0' }, // Sunday 4:00 AM UTC
        jobId: 'company-profiles-sync-weekly',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    companyProfilesSyncWorker = new Worker(
      QUEUE_COMPANY_PROFILES_SYNC,
      async (_job: Job) => {
        // Bi-weekly: check job_heartbeat for the last successful run and skip if it was
        // less than 12 days ago (company descriptions/financials barely change week to
        // week — this used to run weekly for no benefit).
        const last = await dbGet(
          `SELECT last_success_at FROM job_heartbeat WHERE job_name = 'company-profiles-sync'`,
        ) as { last_success_at: number | null } | undefined;
        const twelveDaysMs = 12 * 24 * 60 * 60 * 1000;
        if (last?.last_success_at && Date.now() - Number(last.last_success_at) < twelveDaysMs) {
          console.log('[QUEUE] company-profiles-sync: ran within the last 12 days, skipping');
          return;
        }
        const { syncAndAnalyzeCompanyProfiles } = await import('./companyProfileSyncService');
        await syncAndAnalyzeCompanyProfiles();
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 60 * 60 * 1000, // 1 hour
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    companyProfilesSyncWorker.on('completed', (_job) => {
      console.log('[QUEUE] company-profiles-sync completed');
      updateMonitorState('company-profiles-sync', 'success');
    });
    companyProfilesSyncWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] company-profiles-sync failed:', err.message);
      updateMonitorState('company-profiles-sync', 'failed', err.message);
    });

    // ── Trendlyne midweek batch ──
    // Trendlyne midweek batch: adv-tech + price analysis (moved off Sunday to
    // de-conflict from the main ml-weekly-retrain batch).
    trendlyneMidweekQueue = new Queue(QUEUE_TRENDLYNE_MIDWEEK, { connection });
    const tmwRep = await trendlyneMidweekQueue.getRepeatableJobs();
    for (const r of tmwRep) await trendlyneMidweekQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(trendlyneMidweekQueue,
      'trendlyne-midweek-batch',
      {},
      {
        repeat: { pattern: '30 12 * * 2' }, // Tuesday 12:30 UTC (6:00 PM IST)
        jobId: 'trendlyne-midweek-weekly',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    trendlyneMidweekWorker = new Worker(
      QUEUE_TRENDLYNE_MIDWEEK,
      async (_job: Job) => {
        await runPython('trendlyne_adv_tech_fetcher.py', [], 40 * 60_000)
          .catch(e => console.warn('[QUEUE] trendlyne_adv_tech_fetcher failed:', (e as Error).message));
        await runPython('trendlyne_price_analysis_fetcher.py', [], 40 * 60_000)
          .catch(e => console.warn('[QUEUE] trendlyne_price_analysis_fetcher failed:', (e as Error).message));
        return { success: true };
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 90 * 60 * 1000,
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    trendlyneMidweekWorker.on('completed', () => {
      console.log('[QUEUE] trendlyne-midweek completed');
      updateMonitorState('trendlyne-midweek', 'success');
    });
    trendlyneMidweekWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-midweek failed:', err.message);
      updateMonitorState('trendlyne-midweek', 'failed', err.message);
    });

    // ── Trendlyne ratios (monthly) ──
    // Trendlyne ratios (monthly): financial_ratios + working_capital, now via
    // ET_Stats (Trendlyne's own params for this are confirmed dead — see Tasks 5-6).
    // Fires the Sunday cron every week but only actually runs on the first Sunday of
    // the month (day-of-month <= 7) — cron's day-of-month/day-of-week fields are OR'd,
    // not AND'd, by the underlying cron-parser, so "first Sunday" needs an in-handler
    // guard rather than a single cron expression.
    trendlyneRatiosMonthlyQueue = new Queue(QUEUE_TRENDLYNE_RATIOS_MONTHLY, { connection });
    const trmRep = await trendlyneRatiosMonthlyQueue.getRepeatableJobs();
    for (const r of trmRep) await trendlyneRatiosMonthlyQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(trendlyneRatiosMonthlyQueue,
      'trendlyne-ratios-monthly-check',
      {},
      {
        repeat: { pattern: '30 12 * * 0' }, // every Sunday 12:30 UTC; handler no-ops unless day <= 7
        jobId: 'trendlyne-ratios-monthly-weekly-check',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    trendlyneRatiosMonthlyWorker = new Worker(
      QUEUE_TRENDLYNE_RATIOS_MONTHLY,
      async (_job: Job) => {
        if (new Date().getUTCDate() > 7) {
          console.log('[QUEUE] trendlyne-ratios-monthly: not the first Sunday of the month, skipping');
          return { success: true, skipped: true };
        }
        await runPython('financial_ratios_fetcher.py', [], 30 * 60_000)
          .catch(e => console.warn('[QUEUE] financial_ratios_fetcher failed:', (e as Error).message));
        await runPython('working_capital_fetcher.py', [], 30 * 60_000)
          .catch(e => console.warn('[QUEUE] working_capital_fetcher failed:', (e as Error).message));
        return { success: true };
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 60 * 60 * 1000,
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    trendlyneRatiosMonthlyWorker.on('completed', () => {
      console.log('[QUEUE] trendlyne-ratios-monthly completed');
      updateMonitorState('trendlyne-ratios-monthly', 'success');
    });
    trendlyneRatiosMonthlyWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-ratios-monthly failed:', err.message);
      updateMonitorState('trendlyne-ratios-monthly', 'failed', err.message);
    });

    // ── Tickertape scorecard: ordinal category tags (Performance/Valuation/
    // Growth/Profitability) — supplementary signal, weekly is sufficient. ──
    tickertapeScorecardQueue = new Queue(QUEUE_TICKERTAPE_SCORECARD, { connection });
    const ttscRep = await tickertapeScorecardQueue.getRepeatableJobs();
    for (const r of ttscRep) await tickertapeScorecardQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(tickertapeScorecardQueue,
      'tickertape-scorecard-weekly',
      {},
      {
        repeat: { pattern: '0 13 * * 6' }, // Saturday 1:00 PM UTC
        jobId: 'tickertape-scorecard-weekly',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    tickertapeScorecardWorker = new Worker(
      QUEUE_TICKERTAPE_SCORECARD,
      async (_job: Job) => {
        await runPython('tickertape_scorecard_fetcher.py', [], 60 * 60_000)
          .catch(e => console.warn('[QUEUE] tickertape_scorecard_fetcher failed:', (e as Error).message));
        return { success: true };
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 90 * 60 * 1000,
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    tickertapeScorecardWorker.on('completed', () => {
      console.log('[QUEUE] tickertape-scorecard completed');
      updateMonitorState('tickertape-scorecard', 'success');
    });
    tickertapeScorecardWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] tickertape-scorecard failed:', err.message);
      updateMonitorState('tickertape-scorecard', 'failed', err.message);
    });

    // ── Agent: Auditor (16:30 IST = 11:00 UTC, weekdays) ──
    agentAuditorQueue = new Queue(QUEUE_AGENT_AUDITOR, { connection });
    const aaRep = await agentAuditorQueue.getRepeatableJobs();
    for (const r of aaRep) await agentAuditorQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(agentAuditorQueue, 'agent-audit-daily', {}, {
      repeat: { pattern: '0 11 * * 1-5' },
      jobId: 'agent-audit-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentAuditorWorker = new Worker(QUEUE_AGENT_AUDITOR,
      processAgentAuditor, { connection, concurrency: 1, lockDuration: 15 * 60_000 });
    agentAuditorWorker.on('completed', () => {
      console.log('[QUEUE] agent-auditor done');
      recordHeartbeat('agent-auditor', 'success');
    });
    agentAuditorWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-auditor failed:', e.message);
      recordHeartbeat('agent-auditor', 'failed', e.message);
    });

    // Ã¢â€â‚¬Ã¢â€â‚¬ Agent: Optimizer (17:30 IST = 12:00 UTC, weekdays) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    agentOptimizerQueue = new Queue(QUEUE_AGENT_OPTIMIZER, { connection });
    const aoRep = await agentOptimizerQueue.getRepeatableJobs();
    for (const r of aoRep) await agentOptimizerQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(agentOptimizerQueue, 'agent-optim-daily', {}, {
      repeat: { pattern: '0 12 * * 1-5' },
      jobId: 'agent-optim-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    agentOptimizerWorker = new Worker(QUEUE_AGENT_OPTIMIZER,
      processAgentOptimizer, { connection, concurrency: 1, lockDuration: 20 * 60_000 });
    agentOptimizerWorker.on('completed', () => {
      console.log('[QUEUE] agent-optimizer done');
      recordHeartbeat('agent-optimizer', 'success');
    });
    agentOptimizerWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-optimizer failed:', e.message);
      recordHeartbeat('agent-optimizer', 'failed', e.message);
    });

    // Ã¢â€â‚¬Ã¢â€â‚¬ Unified Ranker Ã¢â‚¬â€ daily at 15:45 IST (10:15 UTC) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    unifiedRankerQueue = new Queue(QUEUE_UNIFIED_RANKER, { connection });
    const unifiedRankerWorkerInstance = new Worker(
      QUEUE_UNIFIED_RANKER,
      async () => {
        console.log('[QUEUE] unified-ranker starting...');
        await runPython('unified_ranker.py', [], 5 * 60_000);
      },
      { connection, concurrency: 1 },
    );
    unifiedRankerWorker = unifiedRankerWorkerInstance;

    const staleUR = await unifiedRankerQueue.getRepeatableJobs();
    for (const r of staleUR) await unifiedRankerQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(unifiedRankerQueue, 
      'unified-ranker-daily',
      {},
      {
        repeat:  { pattern: '15 10 * * 1-5' },
        jobId:   'unified-ranker-daily-repeatable',
        attempts: 2,
        backoff:  { type: 'fixed', delay: 60_000 },
      },
    );
    unifiedRankerWorkerInstance.on('completed', () => {
      console.log('[QUEUE] unified-ranker done');
      recordHeartbeat('unified-ranker', 'success');
    });
    unifiedRankerWorkerInstance.on('failed', (_, err) => {
      console.error('[QUEUE] unified-ranker failed:', err.message);
      recordHeartbeat('unified-ranker', 'failed', err.message);
    });

    // ── Daily job-health digest — 9:00 PM IST (15:30 UTC), every day ──────────────
    const QUEUE_JOB_DIGEST = 'job-digest';
    const jobDigestQueue = new Queue(QUEUE_JOB_DIGEST, { connection });
    const jobDigestWorker = new Worker(
      QUEUE_JOB_DIGEST,
      async () => {
        const digest = await buildDailyDigest();
        await telegramService.sendMarkdownMessage(digest);
      },
      { connection, concurrency: 1 },
    );
    jobDigestWorker.on('completed', () => console.log('[QUEUE] job-digest sent'));
    jobDigestWorker.on('failed', (_, err) => console.error('[QUEUE] job-digest failed:', err.message));

    const digestRepeatables = await jobDigestQueue.getRepeatableJobs();
    for (const r of digestRepeatables) await jobDigestQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(jobDigestQueue, 'job-digest-daily', {}, {
      repeat: { pattern: '30 15 * * *' }, // 9:00 PM IST daily, all 7 days
      jobId: 'job-digest-daily-repeatable',
      removeOnComplete: 3,
      removeOnFail: 3,
    });

    // ── Trendlyne Checklist Cycle (self-rescheduling, random interval) ──────────
    trendlyneChecklistCycleQueue = new Queue(QUEUE_TRENDLYNE_CHECKLIST_CYCLE, { connection });
    trendlyneChecklistCycleWorker = new Worker(
      QUEUE_TRENDLYNE_CHECKLIST_CYCLE,
      processTrendlyneChecklistCycle,
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 },
    );
    trendlyneChecklistCycleWorker.on('completed', () => {
      recordHeartbeat('trendlyne-checklist-cycle', 'success');
    });
    trendlyneChecklistCycleWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-checklist-cycle failed:', err.message);
      recordHeartbeat('trendlyne-checklist-cycle', 'failed', err.message);
    });

    // Only kick off the self-rescheduling chain if one isn't already pending —
    // otherwise every dev restart (tsx watch) spawns a duplicate chain.
    const pendingChecklistJobs =
      (await trendlyneChecklistCycleQueue.getWaitingCount()) +
      (await trendlyneChecklistCycleQueue.getDelayedCount()) +
      (await trendlyneChecklistCycleQueue.getActiveCount());
    if (pendingChecklistJobs === 0) {
      await trendlyneChecklistCycleQueue.add('checklist-cycle-tick', {}, { delay: 60_000, removeOnComplete: 3, removeOnFail: 3 });
    }
    console.log('[QUEUE] Trendlyne checklist cycle scheduled (random 15-45 min intervals)');

    console.warn = _origWarn;
    startHeartbeatMonitor();
    startJobWatchdog();
    console.log('[QUEUE] BullMQ initialised (stock-refresh + ai-signals)');
    return true;
  } catch (err: any) {
    console.warn = _origWarn;
    console.warn('[QUEUE] BullMQ unavailable (Redis down?) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â falling back to setInterval:', err.message);
    stockRefreshQueue = null;
    aiSignalsQueue    = null;
    stockScoringQueue = null;
    trendlyneIntradayQueue = null;

    // Confluence compute fallback: run every 30 min when Redis is unavailable
    if (!confluenceFallbackTimer) {
      const runConfluenceFallback = async () => {
        try {
          const { computeConfluenceSignals } = await import('./confluenceEngine');
          await computeConfluenceSignals();
          console.log('[QUEUE-FALLBACK] confluence-compute completed');
        } catch (e: any) {
          console.warn('[QUEUE-FALLBACK] confluence-compute failed:', e.message);
        }
      };
      runConfluenceFallback(); // run immediately on startup
      confluenceFallbackTimer = setInterval(runConfluenceFallback, 30 * 60 * 1000);
      console.log('[QUEUE-FALLBACK] confluence-compute setInterval started (every 30 min)');
    }

    if (!liveScreenerFallbackTimer) {
      const runLiveScreenerFallback = async () => {
        try {
          if (!(await isMarketOpen())) return;
          const { runLiveScreenerCollection } = await import('./liveScreenerCollector');
          await runLiveScreenerCollection();
          console.log('[QUEUE-FALLBACK] live-screener-collect completed');
        } catch (e: any) {
          console.warn('[QUEUE-FALLBACK] live-screener-collect failed:', e.message);
        }
      };
      runLiveScreenerFallback(); // run immediately on startup if appropriate
      liveScreenerFallbackTimer = setInterval(runLiveScreenerFallback, 15 * 60 * 1000);
      console.log('[QUEUE-FALLBACK] live-screener-collect setInterval started (every 15 min)');
    }

    return false;
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Graceful shutdown ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export async function shutdownQueues(): Promise<void> {
  await Promise.allSettled([
    stockWorker?.close(),
    signalWorker?.close(),
    scoringWorker?.close(),
    mcScreenerSyncWorker?.close(),
    etnowScreenerSyncWorker?.close(),
    fundamentalsSyncWorker?.close(),
    quantScoringWorker?.close(),
    stockRefreshQueue?.close(),
    aiSignalsQueue?.close(),
    stockScoringQueue?.close(),
    mcScreenerSyncQueue?.close(),
    etnowScreenerSyncQueue?.close(),
    fundamentalsSyncQueue?.close(),
    quantScoringQueue?.close(),
    technicalSignalsWorker?.close(),
    technicalSignalsQueue?.close(),
    signalOutcomesWorker?.close(),
    signalOutcomesQueue?.close(),
    newsSentimentWorker?.close(),
    newsSentimentQueue?.close(),
    trendlyneIntradayWorker?.close(),
    trendlyneIntradayQueue?.close(),
    trendlyneDailyFetchWorker?.close(),
    trendlyneDailyFetchQueue?.close(),
    outcomeResolverWorker?.close(),
    outcomeResolverQueue?.close(),
    mlDailyOpsWorker?.close(),
    mlDailyOpsQueue?.close(),
    researchPremarketWorker?.close(),
    researchPremarketQueue?.close(),
    researchPostcloseWorker?.close(),
    researchPostcloseQueue?.close(),
    dlMacroFetchWorker?.close(),
    dlMacroFetchQueue?.close(),
    dlFeatureRefreshWorker?.close(),
    dlFeatureRefreshQueue?.close(),
    dlInferenceWorker?.close(),
    dlInferenceQueue?.close(),
    dlRegimeUpdateWorker?.close(),
    dlRegimeUpdateQueue?.close(),
    dlRetrainWeeklyWorker?.close(),
    dlRetrainWeeklyQueue?.close(),
    dlRetrainEmergencyWorker?.close(),
    dlRetrainEmergencyQueue?.close(),
    ohlcvBackfillWorker?.close(),
    ohlcvBackfillQueue?.close(),
    confluenceComputeWorker?.close(),
    confluenceOutcomesWorker?.close(),
    confluenceComputeQueue?.close(),
    confluenceOutcomesQueue?.close(),
    Promise.resolve(confluenceFallbackTimer ? clearInterval(confluenceFallbackTimer) : undefined),
    agentDataScientistWorker?.close(),
    agentStrategistWorker?.close(),
    agentAuditorWorker?.close(),
    agentOptimizerWorker?.close(),
    agentDataScientistQueue?.close(),
    agentStrategistQueue?.close(),
    agentAuditorQueue?.close(),
    agentOptimizerQueue?.close(),
    unifiedRankerWorker?.close(),
    unifiedRankerQueue?.close(),
    liveScreenerCollectWorker?.close(),
    liveScreenerCollectQueue?.close(),
    trendlyneChecklistCycleWorker?.close(),
    trendlyneChecklistCycleQueue?.close(),
    Promise.resolve(liveScreenerFallbackTimer ? clearInterval(liveScreenerFallbackTimer) : undefined),
  ]);
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Enqueue AI-signals for an array of stocks ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export interface EnqueueResult {
  queued: number;
  skipped: number;
  queueAvailable: boolean;
}

export async function enqueueAISignals(
  stocks: { symbol: string; stockData: Record<string, unknown> }[],
): Promise<EnqueueResult> {
  if (!aiSignalsQueue) {
    return { queued: 0, skipped: stocks.length, queueAvailable: false };
  }

  // Deduplicate: skip symbols that already have an active/waiting job today
  const waiting  = await aiSignalsQueue.getWaiting();
  const active   = await aiSignalsQueue.getActive();
  const existing = new Set([...waiting, ...active].map(j => j.data?.symbol as string));

  const toAdd = stocks.filter(s => !existing.has(s.symbol));

  if (toAdd.length > 0) {
    await aiSignalsQueue.addBulk(
      toAdd.map(s => ({
        name: 'analyze-stock',
        data: s,
        opts: {
          jobId: `signal-${s.symbol}-${new Date().toDateString()}`,
          removeOnComplete: 100,
          removeOnFail: 20,
          attempts: 2,
          backoff: { type: 'exponential' as const, delay: 5_000 },
        },
      })),
    );
  }

  return {
    queued:         toAdd.length,
    skipped:        stocks.length - toAdd.length,
    queueAvailable: true,
  };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Queue stats ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export interface QueueStats {
  waiting:  number;
  active:   number;
  completed: number;
  failed:   number;
  total:    number;
  available: boolean;
}

export async function getAIQueueStats(): Promise<QueueStats> {
  if (!aiSignalsQueue) {
    return { waiting: 0, active: 0, completed: 0, failed: 0, total: 0, available: false };
  }
  const counts = await aiSignalsQueue.getJobCounts(
    'waiting', 'active', 'completed', 'failed',
  );
  const waiting   = counts.waiting   ?? 0;
  const active    = counts.active    ?? 0;
  const completed = counts.completed ?? 0;
  const failed    = counts.failed    ?? 0;
  return {
    waiting,
    active,
    completed,
    failed,
    total:    waiting + active + completed + failed,
    available: true,
  };
}



