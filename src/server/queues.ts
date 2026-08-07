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
import Redis from 'ioredis';
import { REDIS_BASE } from './redisConfig';
import { runPython } from './pythonRunner';
import { registerScreenerJobs } from './jobs/screeners.jobs';
import { addJobWithCatchup } from './jobs/registerJob';
import { registerAgentJobs } from './jobs/agents.jobs';
import { registerOperationsJobs, resolveOutcomesResilient } from './jobs/operations.jobs';
import { registerSyncJobs } from './jobs/sync.jobs';
import { registerDlJobs, processDLPython } from './jobs/dl.jobs';
import { registerTrendlyneWeeklyJobs } from './jobs/trendlyneWeekly.jobs';
import { registerConfluenceJobs } from './jobs/confluence.jobs';
import { registerDigestJobs } from './jobs/digests.jobs';
import { alphaQuant } from './alphaQuantClient';

import { syncNiftyTraderScores, syncTrendlyneScores } from './syncProprietaryScores';
import { syncTrendlyneTechnicals } from './technicalIntelligenceService';
import { fetchDeliveryMap } from './deliveryFetcher';
import { updateMonitorState } from './monitoringService';
import { StepTracker } from './jobSteps';
import { updateTrailingStops } from './trailingStopUpdater';
import { getTrendlyneMetricSymbols, enqueueTrendlyneMetricsFetchJobs, runTrendlyneMetricsFetch } from './trendlyneDailyFetchService';
import { isMarketOpen, isTradingHolidayToday } from './marketStatusService';
import {
  isDormant, shouldStartNewCycle, pickRandomBatch, randomDelayMs, DORMANT_RECHECK_MS,
  getCycleState, startNewCycle, completeCycle, getPendingStocksForCycle, upsertChecklistResult,
  markChecklistAttempted,
} from './trendlyneChecklistCycle';
import { fetchTrendlyneChecklist } from './trendlyneService';

import { pythonApi } from './pythonApi';
import { recordHeartbeat, startHeartbeatMonitor } from './jobHeartbeat';
import { startJobWatchdog, buildDailyDigest } from './jobWatchdog';
import { telegramService, sanitizeMarkdown } from './telegramService';

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Redis connection shared across all BullMQ objects ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

export function makeConnection(isProbe = false): any {
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
export const QUEUE_WALK_FORWARD_OPTIMIZE = 'walk-forward-optimize';
export { QUEUE_STOCK_SCORING, QUEUE_MC_SCREENER_SYNC, QUEUE_ETNOW_SCREENER_SYNC, QUEUE_ET_MARKETSTATS_SYNC, QUEUE_FUNDAMENTALS_SYNC, QUEUE_QUANT_SCORING } from './jobs/screeners.jobs';
export const QUEUE_TECHNICAL_SIGNALS    = 'technical-signals';
export const QUEUE_SIGNAL_OUTCOMES      = 'signal-outcomes';
export const QUEUE_NEWS_SENTIMENT       = 'news-sentiment';
export const QUEUE_TRENDLYNE_INTRADAY   = 'trendlyne-intraday';
export const QUEUE_ML_DAILY_OPS        = 'ml-daily-ops';
export const QUEUE_ML_WEEKLY_RETRAIN   = 'ml-weekly-retrain';
export const QUEUE_INTRADAY_FETCHER    = 'intraday-fetcher';
export { QUEUE_RESEARCH_PREMARKET, QUEUE_RESEARCH_POSTCLOSE, QUEUE_OUTCOME_RESOLVER } from './jobs/operations.jobs';
export { QUEUE_SCREENER_PERFORMANCE, QUEUE_COMPANY_PROFILES_SYNC, QUEUE_TICKERTAPE_SCORECARD } from './jobs/sync.jobs';
export { QUEUE_NSE_SYNC } from './jobs/sync.jobs';
export { QUEUE_DL_MACRO_FETCH, QUEUE_DL_FEATURE_REFRESH, QUEUE_DL_INFERENCE, QUEUE_DL_REGIME_UPDATE, QUEUE_DL_RETRAIN_WEEKLY } from './jobs/dl.jobs';
export { QUEUE_TRENDLYNE_MIDWEEK, QUEUE_TRENDLYNE_RATIOS_MONTHLY } from './jobs/trendlyneWeekly.jobs';
export { QUEUE_CONFLUENCE_COMPUTE, QUEUE_CONFLUENCE_OUTCOMES } from './jobs/confluence.jobs';
export { QUEUE_JOB_DIGEST, QUEUE_RECOMMENDATIONS_DIGEST } from './jobs/digests.jobs';
export const QUEUE_DL_RETRAIN_EMERGENCY = 'dl-retrain-emergency';
export const QUEUE_OHLCV_BACKFILL       = 'ohlcv-backfill';
export const QUEUE_UNIFIED_RANKER       = 'unified-ranker';
export { QUEUE_AGENT_DATA_SCIENTIST, QUEUE_AGENT_STRATEGIST, QUEUE_AGENT_AUDITOR, QUEUE_AGENT_OPTIMIZER } from './jobs/agents.jobs';
export const QUEUE_QUANT_EOD_SYNC = 'quant-eod-sync';
export const QUEUE_TRENDLYNE_DAILY_FETCH = 'trendlyne-daily-fetch';
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
export let etMarketstatsSyncQueue: Queue | null = null;
export let trendlyneScreenerSyncQueue: Queue | null = null;
export let nseScreenerSyncQueue:   Queue | null = null;  // PHASE 2: NSE master data sync
export let fundamentalsSyncQueue:  Queue | null = null;
export let quantScoringQueue:      Queue | null = null;
export let walkForwardOptimizeQueue: Queue | null = null;
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
let etMarketstatsSyncWorker:  Worker | null = null;
let trendlyneScreenerSyncWorker: Worker | null = null;
let nseScreenerSyncWorker:    Worker | null = null;  // PHASE 2: NSE worker
let fundamentalsSyncWorker:   Worker | null = null;
let quantScoringWorker:       Worker | null = null;
let walkForwardOptimizeWorker: Worker | null = null;
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


// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Stock-refresh worker processor (PHASE 1: Now persists OHLCV) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processStockRefresh(_job: Job): Promise<{ count: number; persisted: number }> {
  const { fetchAndPersistOHLCVData } = await import('./liveStockData');
  const result = await fetchAndPersistOHLCVData();
  await checkPriceAlerts().catch(e => console.error('[QUEUE] checkPriceAlerts failed:', (e as Error).message));
  return result;
}

// Evaluates ACTIVE price_alerts against the just-refreshed live prices and pushes a broadcastAlert
// (sse.ts) for each threshold crossed — the piece that was missing: the SSE pipe + AlertsToast UI
// already existed end-to-end, nothing ever called broadcastAlert().
async function checkPriceAlerts(): Promise<void> {
  const active = await dbAll<{ id: number; userId: string; symbol: string; condition: string; thresholdPrice: number }>(
    `SELECT id, "userId", symbol, condition, "thresholdPrice" FROM price_alerts WHERE status = 'ACTIVE'`
  );
  if (active.length === 0) return;

  const symbols = new Set(active.map(a => a.symbol));
  const { getOrRefreshAllStocks } = await import('./liveStockData');
  const stocks = await getOrRefreshAllStocks();
  const priceBySymbol = new Map<string, number>();
  for (const s of stocks as any[]) {
    if (symbols.has(s.symbol)) priceBySymbol.set(s.symbol, s.price);
  }

  const { broadcastAlert } = await import('./sse');
  for (const alert of active) {
    const price = priceBySymbol.get(alert.symbol);
    if (price === undefined || !Number.isFinite(price)) continue;
    const crossed = alert.condition === 'ABOVE' ? price >= alert.thresholdPrice : price <= alert.thresholdPrice;
    if (!crossed) continue;

    await dbRun(
      `UPDATE price_alerts SET status = 'TRIGGERED', "triggeredAt" = now(), "triggeredPrice" = ? WHERE id = ? AND status = 'ACTIVE'`,
      [price, alert.id]
    );
    broadcastAlert({
      id: `price-alert-${alert.id}`,
      type: 'SUCCESS',
      title: `${alert.symbol} ${alert.condition === 'ABOVE' ? 'crossed above' : 'fell below'} ₹${alert.thresholdPrice}`,
      message: `Now ₹${price.toFixed(2)}`,
      userId: alert.userId,
    });
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ AI-signals worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processAISignal(job: Job): Promise<void> {
  const { symbol, stockData } = job.data as { symbol: string; stockData: Record<string, unknown> };

  const { gateAISignal, getAISignalMinConfidence, gateOnQuant, getAISignalMinWinProb,
          upsertUnifiedSignal, checkSurveillanceGate } = await import('./signals');

  // Cheap DB-only gates FIRST, before spending an Ollama/Gemini call. Both of these are
  // independent of the LLM's output, so if either would reject the signal there is no reason
  // to generate one at all — this is what actually cuts inference volume/cost, not the
  // after-the-fact gates below.
  const survGate = await checkSurveillanceGate(symbol);
  if (survGate) {
    await job.updateProgress(100);
    return;
  }

  // LLM demotion: the LLM proposes a direction, but the quant model decides actionability.
  // The LLM's self-confidence is uncorrelated with realized outcomes, so emission is gated on
  // the stock's win_probability — the scoring engine only writes one for stocks it endorsed —
  // not the LLM's confidence. No quant endorsement ⇒ the LLM signal is not persisted.
  // Reads calibrated_win_probability (COALESCE to raw) — was reading raw unconditionally,
  // inconsistent with scoring_engine.py/unified_ranker sizing, which already prefer the
  // regime-fair calibrated value (2026-07-18 gating follow-up).
  const wpRow = await dbGet<{ win_probability: number | null }>(
    "SELECT COALESCE(calibrated_win_probability, win_probability) AS win_probability FROM technical_signals WHERE symbol = ? AND win_probability IS NOT NULL ORDER BY date DESC LIMIT 1",
    [symbol],
  );
  const winProb = wpRow?.win_probability ?? null;
  const qgate = gateOnQuant(winProb, await getAISignalMinWinProb());
  if (!qgate.persist) {
    await job.updateProgress(100);
    return;
  }

  const analysis = await generateStockAnalysis(symbol, stockData);

  // Actionability gate: only persist conviction BUY/SELL signals above the confidence
  // floor. Drops HOLD and sub-threshold noise so the DB matches what the UI surfaces and
  // the backtester sees clean, actionable data. (See docs/.../ai-signal-gate-design.md)
  const threshold = await getAISignalMinConfidence();
  const gate = gateAISignal(analysis as any, threshold);
  if (!gate.persist) {
    await job.updateProgress(100);
    return;
  }

  const now = new Date().toISOString();

  // Override the LLM's hallucinated price levels with ATR-grounded barriers (2.5×/1.5×
  // ATR, clamped) anchored to the model's entry. The LLM has no sense of a stock's
  // realized range, which made ~76% of AI signals expire NEUTRAL (target unreachable)
  // while stops still fired. Fall back to the LLM levels only if history is too thin
  // to compute an ATR.
  const { getAtrBarriers } = await import('./atrBarriers');
  const direction = gate.signalType === 'SELL' ? 'short' : 'long';
  const barriers = await getAtrBarriers(symbol, analysis.entry ?? null, direction);
  const entryPrice = barriers?.entryPrice ?? analysis.entry ?? null;
  const targetPrice = barriers?.targetPrice ?? analysis.target ?? null;
  const stopLoss = barriers?.stopLoss ?? analysis.stopLoss ?? null;

  // Write to unified_signals so outcome resolver and reward engine can track AI signal performance.
  // Demotion: confidence_score/quant_score now carry the quant win_probability (outcome-correlated),
  // and the LLM's text is stored as ai_reasoning (narrative) rather than as the signal's authority.
  const quantConfidence = Math.round(winProb! * 100);
  await upsertUnifiedSignal('AI', {
    symbol,
    signalDate: now.split('T')[0],
    signalType: gate.signalType,
    entryPrice,
    targetPrice,
    stopLoss,
    confidenceScore: quantConfidence,
    quantScore: quantConfidence,
    reasoning: analysis.reasoning ?? null,
    aiReasoning: analysis.reasoning ?? null,
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
        entryPrice,
        targetPrice,
        stopLoss,
        confidence: quantConfidence,
        reasoning: analysis.reasoning ?? null,
      },
    });
  } catch {
    // WebSocket is best-effort
  }

  // Update job progress so the frontend can display it
  await job.updateProgress(100);
}

// ── Walk-forward-optimize worker processor ─────────────────────────────────
// On-demand (user-triggered), not a daily batch job — data comes straight from
// job.data (the request the tRPC mutation enqueued) and is forwarded to the
// AlphaQuant FastAPI service, which does the actual DE search + simulation.
async function processWalkForwardOptimize(job: Job): Promise<any> {
  console.log(`[QUEUE] Starting walk-forward optimize (${job.data?.start}→${job.data?.end})...`);
  return alphaQuant.walkForwardOptimize(job.data);
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ML daily ops worker processor ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processLiveScreenerCollect(_job: Job): Promise<void> {
  if (!(await isMarketOpen())) {
    console.log('[QUEUE] live-screener-collect skipped — outside NSE market hours');
    return;
  }
  const { runLiveScreenerCollection } = await import('./liveScreenerCollector');
  await runLiveScreenerCollection();

  // Score this cycle's matches against the currently-active ML model right after
  // collecting them, so the Intraday Edge tab's ml_win_probability is fresh every 15 min.
  // No-ops quietly (prints, doesn't throw) until live_screener_ml_ranker.py --train has
  // produced a first model.
  await runPython('live_screener_ml_ranker.py', ['--score'], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] live_screener_ml_ranker --score failed:', (e as Error).message));
}

async function processIntradayFetcher(_job: Job): Promise<void> {
  // Cron is weekday+time only, so it still fires on a trading holiday — guard on the
  // holiday-aware live status so intraday fetches no-op on holidays/off-hours.
  if (!(await isMarketOpen())) {
    console.log('[QUEUE] intraday-fetcher skipped — outside NSE market hours (weekend/holiday)');
    return;
  }
  // Fetches 15m bars for all 2328 NSE stocks (last 24h) — ~4 min per run.
  await runPython('intraday_fetcher.py', ['--lookback-days', '1'], 600_000)
    .catch(e => console.warn('[QUEUE] intraday_fetcher failed:', (e as Error).message));
}

/**
 * Overall execution budget for a heavy processor.
 *
 * Per-step runPython timeouts don't bound the job as a whole: a step that hangs in TS
 * (network sync, DB lock wait) never returns, the processor promise never settles, and the
 * concurrency-1 slot is held forever — every later run queues behind it. Losing the race
 * rejects the processor so BullMQ frees the slot and fails the job instead of wedging.
 *
 * Caveat: this cannot cancel the work already in flight. Any in-flight HTTP/DB call or
 * Python child keeps running to its own timeout; we only stop waiting on it. Budget must
 * stay under the worker's lockDuration so the timeout fires before stall-detection does.
 */
function withJobTimeout<T>(name: string, budgetMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${name} exceeded its ${Math.round(budgetMs / 60_000)}min execution budget — failing the job to free the worker slot`)),
      budgetMs,
    );
  });
  return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function processMlDailyOps(_job: Job): Promise<{ success: boolean }> {
  // Dashboard-visible sub-tasks are wrapped in T.run(...) so their monitor state reflects the
  // ACTUAL step outcome (T.finish() at the end). Steps not tracked here stay best-effort with a
  // console.warn — they aren't individually dashboarded, so they can't create a false-healthy signal.
  const T = new StepTracker('ml-daily-ops');
  // FULL-UNIVERSE feature grid FIRST: the signal scan only writes technical_signals rows
  // for stocks that produced a tradable pattern (14-800/day), so most of the universe had
  // no feature row on most days — starving the ensemble/ranker of a complete cross-section.
  // This guarantees a row for every liquid stock on the latest session BEFORE the enrichment
  // engines below run, so RS/HV/aVWAP/etc. fill the whole grid, not just the signal subset.
  await runPython('backfill_technical_features.py', ['--full-today'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] technical grid-ensurer failed:', (e as Error).message));

  // Forward-capture alt-data: MoneyControl breakout-pattern flags + technical rating onto
  // today's full grid (can't be backfilled — captured daily to accumulate for a future
  // richer breakout model). Runs after the grid-ensurer so it writes onto full-universe rows.
  await runPython('mc_techscanner_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_techscanner failed:', (e as Error).message));

  // Fetch extra alt-data from Indiatimes, MarketsMojo, and Trading80.
  await runPython('extra_endpoints_fetcher.py', [], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] extra_endpoints_fetcher failed:', (e as Error).message));

  // Superstar-investor conviction tracking (InvestSights) — per-stock entry/exit/increase/
  // decrease by named investors, closing the gap the 2026-08-03 urls.txt field analysis
  // flagged as this platform's top new-data opportunity. ~60 sequential per-investor requests;
  // 5 min budget is generous headroom over the measured sub-minute runtime.
  await runPython('investsights_investor_activity_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] investsights_investor_activity_fetcher failed:', (e as Error).message));

  // Point-in-time fundamentals snapshot — builds the as-of trail load_training_data joins.
  // Runs in ~2s solo but its DELETE+INSERT…SELECT on fundamentals_history can block far longer on
  // Postgres lock/CPU contention during the startup catch-up burst (was tripping the old 90s budget
  // with a bare SIGTERM). 3 min matches the sibling steps and clears the transient contention window.
  // 6 min: DELETE+INSERT on fundamentals_history can block under Postgres lock/CPU contention;
  // 3 min was clipping on the 2nd daily-ops run (observed 2026-07-14 07:54 under load).
  await runPython('fundamentals_snapshot.py', [], 360_000)
    .catch(e => console.warn('[QUEUE] fundamentals_snapshot failed:', (e as Error).message));

  // Same rationale as fundamentals_snapshot above: stock_factor_breakdown is current-state-only
  // (overwritten in place), so this is the only way a future regime-conditional backtest of
  // unified_ranker's REGIME_CAT_TILT will ever have history to fit against.
  await runPython('factor_breakdown_snapshot.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] factor_breakdown_snapshot failed:', (e as Error).message));

  // analyst_estimates_snapshot moved to weekly retrain (2328 stocks × 3 calls × 0.4s = ~47 min)

  // Surveillance gate: ASM/GSM flags → nse_stocks and technical_signals.asm_flag/gsm_stage.
  await runPython('asm_gsm_fetcher.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] asm_gsm_fetcher failed:', (e as Error).message));

  // Trailing chandelier stop ratchet for live ACTIVE positions (Finding #29, 2026-07-28
  // full-stack audit) -- the correct trailing-stop formula already proven in
  // exit_labeler.py/outcome_resolver.py for offline backtest grading had never been applied
  // to actual open positions before this. TS function, runs in-process (no runPython needed).
  await updateTrailingStops()
    .catch(e => console.warn('[QUEUE] trailing stop updater failed:', (e as Error).message));
  await T.run('fii-dii-fetcher', () => runPython('fii_dii_fetcher.py', [], 90_000));
  // Deep-history top-up (endpoint-corpus audit §5-1). One call returns all 2,584 daily rows
  // back to 2016 in ~3s, so backfill and daily top-up are the same operation -- there is no
  // separate backfill mode to schedule. Runs AFTER fii_dii_fetcher deliberately: it only ever
  // fills NULLs, so today's authoritative NSE row is already in place and wins. Tolerated
  // (.catch) rather than fatal -- this is a supplementary third-party source, and an outage
  // must not fail the whole daily ML chain the way the drift-detector timeout did.
  await T.run('fii-dii-history', () => runPython('fii_dii_history_fetcher.py', [], 120_000))
    .catch(e => console.warn('[QUEUE] fii_dii_history_fetcher failed (daily ops continues):', (e as Error).message));
  // Bulk/block deals carrying pctTransacted (% of float) -- the cross-sectionally comparable
  // deal-size field NSE's own feed does not provide (endpoint-corpus audit §5-2). 5 pages of
  // 200 covers several days of deals, so a missed run self-heals on the next one.
  // --insider also lands the feed's insider filings in insider_trades WITH pct_transacted,
  // which NSE's PIT feed does not carry -- insider_features.py's ratio is near-binary, so
  // materiality (a 70%-of-float promoter exit vs a 0.01% one) is the missing dimension.
  await T.run('tickertape-deals', () => runPython('tickertape_deals_fetcher.py', ['--pages', '5', '--insider'], 180_000))
    .catch(e => console.warn('[QUEUE] tickertape_deals_fetcher failed (daily ops continues):', (e as Error).message));
  await runPython('pcr_fetcher.py', ['--gex'], 90_000)
    .catch(e => console.warn('[QUEUE] pcr_fetcher failed:', (e as Error).message));
  // Per-symbol PCR/max-pain/ATM-IV for the DEFAULT_SYMBOLS large-cap set -> stock_options_oi +
  // historical_fno_sentiment. Every OTHER pcr_fetcher.py call site in this file passes --gex
  // (index-level dealer GEX only, writes macro_asset_prices) -- this was the only call that
  // still ran the default per-symbol path, and it was removed at some point without anyone
  // noticing historical_fno_sentiment had no other writer left: found 2026-08-03 via the new
  // data-quality sweep (11+ days stale, `stock_options_oi` masked the gap since so_option_chain_
  // fetcher.py/stock_option_chain_fetcher.py independently keep IT fresh). 20 symbols at NiftyTrader's
  // own 1.5s delay is ~30s, cheap enough for the daily chain.
  await runPython('pcr_fetcher.py', [], 90_000)
    .catch(e => console.warn('[QUEUE] pcr_fetcher (per-symbol) failed:', (e as Error).message));
  // Parallel batch — safe to overlap: disjoint target tables (mc_* vs unified_signals vs
  // news_sentiment_items), no shared rows, no advisory locks, and distinct resources
  // (MoneyControl network vs DB-compute vs GPU/FinBERT). The 5-min MC scrape now runs
  // concurrently with the technical engine + news sentiment instead of after them. pythonRunner
  // caps global Python concurrency at 5, so this can't oversubscribe the box.
  //
  // institutional_quant_engine.py used to run here, writing quant_scores via a full
  // DELETE+re-INSERT — but quantScoringService.ts's own upsert runs 3.5h later (11 PM IST,
  // quant-scoring queue) and writes the identical column set, so this engine's nightly writes
  // were always clobbered same-night before anything could read them. Retired as an automatic
  // writer (2026-08); still reachable on-demand via mcpServer.ts's run_analytical_engine tool,
  // now upsert-safe (see institutional_quant_engine.py's _save()) so an on-demand run can't
  // null out quantScoringService's/multi_factor_scorer.py's columns either.
  //
  // technical_analysis_engine.py (trend/RSI/MACD/Bollinger/patterns -> unified_signals,
  // signal_source='technical') takes the vacated slot — it had never run on any schedule before
  // this fix, only reachable via the same MCP tool, so signal_source='technical' rows were
  // stale indefinitely between manual triggers.
  await Promise.allSettled([
    runPython('moneycontrol_fetcher.py', [], 900_000)
      .catch(e => console.warn('[QUEUE] moneycontrol_fetcher failed:', (e as Error).message)),
    runPython('technical_analysis_engine.py', [], 120_000)
      .catch(e => console.warn('[QUEUE] technical_analysis_engine failed:', (e as Error).message)),
    T.run('finbert-scorer', () => runPython('finbert_scorer.py', ['--days', '1'], 180_000)),
  ]);
  // iv_features reads the ATM IV that pcr_fetcher just wrote to stock_options_oi → technical_signals.iv_rank.
  // Kept serial: it writes technical_signals, which several later steps also update — avoids row-lock churn.
  await runPython('iv_features.py', ['--date', 'today'], 300_000)
    .catch(e => console.warn('[QUEUE] iv_features failed:', (e as Error).message));

  // NSE full bhavcopy -> nse_universe_history: the exchange's own record of what actually
  // traded each day, i.e. the POINT-IN-TIME universe. Every other price path here iterates
  // the current nse_stocks master, so anything delisted before today was never fetched --
  // 2,436 of 2,450 symbols in 5.5y of stock_ohlcv are still trading and exactly ONE stopped
  // >12 months ago. Measured against 66 monthly bhavcopies: 1,450 of 3,860 securities that
  // really traded (37.6%) have no stock_ohlcv history at all, and they are systematically
  // the ones that died. Runs before the quality/feature steps so today's row is available.
  await T.run('nse-bhavcopy-fetcher', () => runPython('nse_bhavcopy_fetcher.py', [], 10 * 60_000));

  // Flag bad-print OHLCV bars first so outcome labels skip them (ohlcv_quality.is_suspect).
  await runPython('ohlcv_quality.py', ['--no-ingest'], 600_000)
    .catch(e => console.warn('[QUEUE] ohlcv_quality flag failed:', (e as Error).message));

  // Cross-sectional relative strength from (cleaned) OHLCV → technical_signals.rs_rank_21d/63d.
  await runPython('relative_strength.py', [], 180_000)
    .catch(e => console.warn('[QUEUE] relative_strength failed:', (e as Error).message));

  // Cross-sectional ownership flow: sector-relative + universe-rank of MF net flow already
  // stamped on technical_signals → mf_flow_vs_sector / mf_flow_rank. Same-day, no look-ahead.
  await runPython('ownership_relative.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] ownership_relative failed:', (e as Error).message));

  // multi_factor_scorer.py (quant_scores.mf_*) used to run here — but this step (ml-daily-ops,
  // 7:30 PM IST) runs 3.5h BEFORE quantScoringService.ts's own quant_scores upsert (11 PM IST,
  // quant-scoring queue), exactly inverting the dependency its own docstring claimed ("depends
  // on quant_scores already having today's rows"). It always read yesterday's quant factors.
  // Moved into processQuantScoring() (screeners.jobs.ts), after runQuantScoring(), 2026-08.

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

  // Sector-level F&O sentiment: aggregate stock_options_oi by sector → sector_fo_sentiment.
  // Depends on pcr_fetcher.py (stock_options_oi) and iv_features (per-stock IV) having run.
  await runPython('sector_fo_proxy.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] sector_fo_proxy failed:', (e as Error).message));

  // F&O rollover % and cost of carry from NSE bhavcopies → fno_rollover → technical_signals.
  await runPython('fno_rollover_fetcher.py', ['--days', '1'], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] fno_rollover_fetcher failed:', (e as Error).message));

  // Cash market delivery % from NSE MTO DAT → stock_delivery_volume → technical_signals.
  await runPython('delivery_volume_fetcher.py', ['--days', '1'], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] delivery_volume_fetcher failed:', (e as Error).message));

  // Block deals from NSE live API → stock_block_deal_daily → technical_signals.
  await runPython('block_deal_fetcher.py', ['--days', '1'], 60_000)
    .catch(e => console.warn('[QUEUE] block_deal_fetcher failed:', (e as Error).message));

  // MC pricefeed: IND_PE, CAGR 3/5y, consensus PE/PB, delivery avg (fundamentals/delivery only —
  // price/volume columns moved to mc_price_features_ohlcv.py below, see its docstring for why).
  // 2328 stocks × 0.35s = ~14 min
  await runPython('mc_pricefeed_fetcher.py', [], 25 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_pricefeed_fetcher failed:', (e as Error).message));

  // Point-in-time mc_ma30/50/150/200_dist_pct, mc_3d_return, mc_52w_high/low_dist_pct,
  // mc_days_from_52wh, mc_ytd_return, mc_vol_ratio -- computed from stock_ohlcv (fresh as of
  // today's 16:00 IST stock-refresh, earlier in the day) rather than MoneyControl's live
  // snapshot. Replaces mc_pricefeed_fetcher's old no-date-filter UPDATE for these columns,
  // which was smearing today's value across a symbol's entire technical_signals history
  // (found 2026-07-19: mc_ma30_dist was the #1 most important ml_ensemble feature and was
  // frozen per-symbol for weeks — see mc_price_features_ohlcv.py's docstring).
  // MUST run after ohlcv_quality.py above -- it reads WHERE is_suspect=0 so a bad-print/
  // extreme-level-shift bar doesn't poison every moving-average window it falls inside.
  await runPython('mc_price_features_ohlcv.py', [], 15 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_price_features_ohlcv failed:', (e as Error).message));

  // MC chart patterns: professional pattern detection with target price, stop-loss, direction.
  // 2328 stocks × 0.35s = ~14 min
  await runPython('mc_chart_patterns_fetcher.py', [], 25 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_chart_patterns_fetcher failed:', (e as Error).message));

  // Index/F&O microstructure batch — safe to overlap like the moneycontrol/institutional/finbert
  // group above: each hits a distinct external API and writes its own dedicated index-level
  // table (nt_dashboard/nt_index_pcr_ts/nt_index_oi_eod/macro_asset_prices[distinct symbol
  // keys]/stock_option_features), never technical_signals, so there's no row-lock contention
  // with the per-stock feature writers elsewhere in this pipeline. Was ~9-10 min sequential
  // (six ~2min steps + one 30min step dominating); now bounded by the slowest member.
  await Promise.allSettled([
    // NiftyTrader F&O dashboard: max_pain per stock + directional OI flow (calls vs puts Δoi)
    // for all 147 F&O stocks in a single API call — daily because max pain shifts each session.
    runPython('nt_dashboard_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] nt_dashboard_fetcher failed:', (e as Error).message)),
    // NiftyTrader intraday PCR time series for major indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY).
    runPython('nt_pcr_ts_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] nt_pcr_ts_fetcher failed:', (e as Error).message)),
    // NiftyTrader EOD strike-wise OI snapshot — feeds index_max_pain + nt_index_oi_eod.
    runPython('nt_oi_snapshot_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] nt_oi_snapshot_fetcher failed:', (e as Error).message)),
    // India VIX + GIFT NIFTY intraday values + EOD close → macro_asset_prices + nt_index_pcr_ts.
    runPython('nt_vix_fetcher.py', [], 60_000)
      .catch(e => console.warn('[QUEUE] nt_vix_fetcher failed:', (e as Error).message)),
    // Market Mood Index (Tickertape fear/greed 0-100) → macro_asset_prices INDIA_MMI.
    runPython('mmi_fetcher.py', [], 60_000)
      .catch(e => console.warn('[QUEUE] mmi_fetcher failed:', (e as Error).message)),
    // NiftyTrader per-strike OI change (buildup/unwinding) for index options.
    runPython('nt_change_oi_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] nt_change_oi_fetcher failed:', (e as Error).message)),
    // SmartOptions Greek-enriched option chain for all F&O stocks (Delta/Gamma/Theta/Vega/IV).
    runPython('so_option_chain_fetcher.py', ['--delay', '0.3'], 30 * 60_000)
      .catch(e => console.warn('[QUEUE] so_option_chain_fetcher failed:', (e as Error).message)),
    // SmartOptions cross-market F&O activity screeners (most-active-value/oi-gainers/oi-losers)
    // at the current monthly expiry -- distinct from so_option_chain_fetcher's per-stock chain
    // above (that one needs stockCode; this one is a ranked cross-market screener with no
    // per-stock id). Promoted 2026-07-30 from a stale-expiry URL found in updated_urls.json.
    runPython('trendlyne_fno_activity_fetcher.py', [], 3 * 60_000)
      .catch(e => console.warn('[QUEUE] trendlyne_fno_activity_fetcher failed:', (e as Error).message)),
    // Sector Relative Rotation Graph + sector x sector correlation matrix (2026-08-06 urls.txt
    // analysis) → sector_rrg_history/sector_correlation_{pairs,stats,summary}.
    runPython('investsights_sector_intel_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] investsights_sector_intel_fetcher failed:', (e as Error).message)),
    // Ranked institutional buy/sell deal activity (2026-08-06 urls.txt analysis) → institutional_deal_signals.
    runPython('institutional_deals_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] institutional_deals_fetcher failed:', (e as Error).message)),
    // AI-generated earnings-call tone/takeaway (2026-08-06 urls.txt analysis) → concall_takeaways.
    runPython('investsights_concall_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] investsights_concall_fetcher failed:', (e as Error).message)),
    // NDTV Profit futures basis/roll-spread/PCR, independent cross-check for fno_rollover_fetcher.py
    // (2026-08-07 urls.txt follow-up) → ndtv_fno_basis. F&O-eligible universe only (209 symbols) --
    // futures don't exist for the rest of nse_stocks. Live-measured ~7s for the full universe.
    runPython('ndtv_fno_basis_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] ndtv_fno_basis_fetcher failed:', (e as Error).message)),
    // Market-wide corporate-actions calendar sourced from real NSE filings (2026-08-07
    // urls.txt open-source sourcing pass) → nse_filed_corporate_actions. Daily and cheap (one
    // API call, ~40 rows): the completeness cross-check for mc_corporate_actions_fetcher.py's
    // weekly per-stock crawl, so it should stay fresher than the thing it's checking.
    runPython('investsights_corporate_actions_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] investsights_corporate_actions_fetcher failed:', (e as Error).message)),
    // NDTV Profit futures basis/roll-spread/PCR, independent cross-check for fno_rollover_fetcher.py
    // (2026-08-07 urls.txt follow-up) → ndtv_fno_basis. F&O-eligible universe only (209 symbols) --
    // futures don't exist for the rest of nse_stocks. Live-measured ~7s for the full universe.
    runPython('ndtv_fno_basis_fetcher.py', [], 2 * 60_000)
      .catch(e => console.warn('[QUEUE] ndtv_fno_basis_fetcher failed:', (e as Error).message)),
  ]);

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

  // F&O expiry countdown (days_to_expiry/is_expiry_day) -- the expiry-side counterpart to
  // days_to_next_results above. nt_fno_expiry's own expiry dates are refreshed weekly
  // (sync_nt_fno_symbols.py, ml-weekly-retrain) since they rarely change, but the countdown
  // itself must recompute daily against today's date, same as days_to_next_results.
  await runPython('expiry_features.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] expiry_features failed:', (e as Error).message));

  // Broker research recommendations: named broker BUY/SELL events → mc_broker_reco + technical_signals.
  // Timeout bumped 2min->6min (2026-07-31): fetch_recos() no longer breaks out of pagination on
  // the first stale row (that early-exit was silently dropping recent recs -- the API's
  // reco_data is NOT chronologically sorted, a single page can mix Apr-2026 and Jul-2026 rows
  // in any order). Fixing that means every run now scans all MAX_PAGES=15 pages regardless of
  // --days, live-measured at ~4.6 min end-to-end.
  await runPython('mc_broker_reco_fetcher.py', ['--days', '7'], 6 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_broker_reco_fetcher failed:', (e as Error).message));

  // Economic calendar: upcoming high-impact macro events → eco_calendar + macro_asset_prices.
  await runPython('mc_eco_calendar_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] mc_eco_calendar_fetcher failed:', (e as Error).message));

  // Corporate action calendar: ex-dividend dates + board meeting dates → corporate_actions + technical_signals.
  // Prevents false STOP_LOSS signals on ex-div days; adds pre-earnings drift feature.
  await runPython('mc_corporate_calendar_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] mc_corporate_calendar_fetcher failed:', (e as Error).message));

  // NSE's own primary-market IPO calendar (current/upcoming/past issues) → nse_ipo_calendar.
  // Promoted 2026-07-30 via the `nse` (NseIndiaApi) package -- genuinely new data, no prior
  // fetcher in this codebase covered the IPO calendar.
  await runPython('nse_ipo_calendar_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] nse_ipo_calendar_fetcher failed:', (e as Error).message));

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

  // Per-stock option chain: expected move + GEX proxy + BS-derived ATM IV + next-month IV
  // term structure → stock_option_features + stock_options_oi + technical_signals.
  // 3min -> 6min (2026-07-18): the term-structure feature adds a second per-symbol API call
  // (next-month expiry chain), roughly doubling this script's request count.
  await runPython('stock_option_chain_fetcher.py', [], 6 * 60_000)
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
  // Doubled from 10→20 min: NSE HTTP pool times out mid-alphabet when the connection is
  // congested (observed 2026-07-13: EL* batch all timed out at read_timeout=12 causing SIGTERM).
  await runPython('insider_transactions_fetcher.py', [], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] insider_transactions_fetcher failed:', (e as Error).message));

  // Credit rating events (upgrades/downgrades) from BSE → credit_rating_events + technical_signals.
  await runPython('credit_rating_fetcher.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] credit_rating_fetcher failed:', (e as Error).message));

  // MF sector AUM flow from AMFI monthly disclosures → mf_sector_allocation + technical_signals.
  await runPython('mf_sector_flow_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] mf_sector_flow_fetcher failed:', (e as Error).message));

  // Index/macro batch — same rationale as the NT/MMI/option-chain batch above: five distinct
  // external APIs, five distinct index-level destination tables (macro_asset_prices, index_valuation,
  // stock_ohlcv[index symbols only — disjoint from the per-stock rows written elsewhere],
  // mc_advance_decline/market_breadth.adv_decline_ratio, index_option_oi/index_max_pain), no
  // technical_signals writes. Dominated by nifty_pe_fetcher's ~91-index 6-7min run either way,
  // so this collapses ~13 min of sequential 1-10min steps into ~7 min.
  await Promise.allSettled([
    // India macro indicators: PMI, GST, IIP, auto sales, RBI rate → macro_asset_prices.
    runPython('india_macro_fetcher.py', [], 3 * 60_000)
      .catch(e => console.warn('[QUEUE] india_macro_fetcher failed:', (e as Error).message)),
    // Index PE/PB/EPS → index_valuation (MoneyControl + Trendlyne, last 30 days).
    // ~35 of the ~91 indices now fall back to a second Trendlyne round-trip per index because
    // MC's graph endpoint returns corrupted data for most sector sub-indices — a full run takes
    // 6-7 minutes, well past the old 3-minute budget.
    runPython('nifty_pe_fetcher.py', ['--days', '30'], 10 * 60_000)
      .catch(e => console.warn('[QUEUE] nifty_pe_fetcher failed:', (e as Error).message)),
    // Index OHLC history from MoneyControl → stock_ohlcv (covers SENSEX + indices missing from Yahoo).
    runPython('mc_index_ohlc_fetcher.py', ['--range', '5d'], 3 * 60_000)
      .catch(e => console.warn('[QUEUE] mc_index_ohlc_fetcher failed:', (e as Error).message)),
    // NSE/BSE advance-decline raw counts → mc_advance_decline + market_breadth.adv_decline_ratio.
    runPython('mc_advance_decline_fetcher.py', [], 60_000)
      .catch(e => console.warn('[QUEUE] mc_advance_decline_fetcher failed:', (e as Error).message)),
    // Index options OI by strike → index_option_oi + index_max_pain (Nifty + BankNifty).
    runPython('mc_index_oi_fetcher.py', [], 3 * 60_000)
      .catch(e => console.warn('[QUEUE] mc_index_oi_fetcher failed:', (e as Error).message)),
  ]);

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

  // These were UNCAUGHT: if outcome resolution threw (e.g. a transient PG/IPv6 blip), the
  // whole daily-ops run aborted here — skipping ALL ML training below AND never reaching the
  // success handler, so the ml-ensemble-score/feature-engineering/fii-dii monitor states
  // showed "never succeeded" for a week. Every step below is now best-effort so the run
  // always completes and the training tail always attempts (scripts are idempotent — a
  // failed one simply retries tomorrow).
  await resolveOutcomesResilient(1).catch(e => console.warn('[QUEUE] resolveOutcomes(1) failed:', (e as Error).message));
  await T.run('outcome-resolver-5d', () => resolveOutcomesResilient(5));
  await T.run('outcome-resolver-15d', () => resolveOutcomesResilient(15));

  // Compute excursion path labels for all resolved entries:
  await runPython('exit_labeler.py', ['--limit', '500'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] exit_labeler failed:', (e as Error).message));

  // Now a windowed batch-resolve (was per-row N+1, routinely blew the old 180s
  // timeout on any real backlog) — give it real headroom.
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(err => console.error('[QUEUE] live_screener_resolver.py failed:', err.message));

  await T.run('performance-tracker', () => runPython('performance_tracker.py', ['--horizon', '5']));
  await runPython('performance_tracker.py', ['--horizon', '15'])
    .catch(e => console.warn('[QUEUE] performance_tracker(15) failed:', (e as Error).message));

  // ── feature-matrix hygiene (2026-07-31 bias audit) ──────────────────────────────
  // Must run AFTER every enrichment fetcher above and BEFORE any training step below.
  //
  // Each enrichment fetcher UPDATEs only the technical_signals row matching its own as-of
  // anchor, so a feature lands on exactly the day its fetcher ran and is NULL on every other
  // day (216 of 306 columns were <50% covered; ~150 at exactly 0%). Training then read them
  // through a bounded lateral join and saw NULL, while live inference read today's row and
  // saw values — train/serve skew. This forward-fills the sparse columns across the grid
  // (strictly forward, capped by age, never backward, so it introduces no look-ahead).
  await T.run('densify-feature-matrix',
    () => runPython('densify_feature_matrix.py', [], 15 * 60_000));

  // NOTE: bad-bar flagging deliberately lives in ohlcv_quality.py (which runs earlier in this
  // chain), NOT here. ohlcv_quality.flag_bad_prints() RESETS is_suspect=0 at the top of every
  // run, so a second flagging pass scheduled after it would be silently wiped on the next
  // cycle. The audit's extra checks were merged into ohlcv_quality.flag_malformed_bars()
  // instead; data_integrity_repair.py --bad-bars remains available as a manual one-off.

  await runPython('online_learner.py', ['--window', '180'], 120_000)
    .catch(e => console.warn('[QUEUE] online_learner failed:', (e as Error).message));

  // Warm-start LGBM ensemble on the last 3 days of newly-resolved outcomes (+20 boost rounds).
  // Runs after online_learner so SGD priors are already updated; keeps ensemble fresh daily
  // without the cost of a full weekly retrain.
  await T.run('ml-ensemble-incremental', () => runPython('ml_ensemble.py', ['--incremental', '--incr-days', '3'], 5 * 60_000));

  await T.run('ml-ensemble-score', () => pythonApi.scorePending());

  // Isotonic-recalibrate win_probability against realized WIN/LOSS so sizing/gating use
  // honest probabilities (the ensemble stack is overconfident). Runs after outcomes resolve.
  // Budget: measured 119s uncontended on 2026-07-31 against a 120_000 budget — a 1-second
  // margin, so it only ever passed on a fully idle box and was killed by the timeout on most
  // real runs. Same measure-then-budget correction as exit_labeler/exit_policy before it.
  await runPython('ml_calibration.py', [], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] ml_calibration failed:', (e as Error).message));

  // PSI-based feature drift check — writes drift_score to dl_model_performance so
  // scoring_engine applies a win_probability haircut when distributions shift.
  // exit(1) from drift_detector means EMERGENCY_RETRAIN is needed — that is a deliberate
  // signal, not a crash. Tolerate it here: queue the DL retrain and mark the step OK.
  // Budget: measured 57.2s uncontended on 2026-07-31 against a 60_000 budget — a 2.8-second
  // margin. This is a T.run() step (not a tolerated .catch()), so every timeout-kill failed the
  // WHOLE ml-daily-ops parent job: 32 of 66 runs (48%) had last_error='1 steps failed:
  // drift-detector', and the parent's last success was 2 days stale while every sibling step
  // had succeeded. A timeout message does not match the exit-code-1 branch below, so it
  // correctly rethrew — the defect was purely the budget, not the handling.
  await T.run('drift-detector', () =>
    runPython('drift_detector.py', [], 5 * 60_000).catch(async (e: any) => {
      if (e?.code === 1 || (e?.message || '').includes('exit code 1') ||
          (e?.message || '').includes('Command failed')) {
        console.log('[QUEUE] drift-detector: EMERGENCY_RETRAIN signalled — queuing DL retrain');
        try { await dlRetrainEmergencyQueue?.add('dl-retrain-emergency', { trigger: 'drift' }, { jobId: `drift-retrain-${Date.now()}`, removeOnComplete: 2, removeOnFail: 3 }); } catch (_) {}
        return { stdout: '[DRIFT] EMERGENCY_RETRAIN', stderr: '' }; // step succeeds
      }
      throw e; // real crash — propagate
    })
  );

  await runPython('cs_ranker.py', ['--score'], 120_000)
    .catch(e => console.warn('[QUEUE] cs_ranker score failed:', (e as Error).message));

  // Breakout classifier (Lever #4): score today's universe with P(>=6% move in 10d) →
  // technical_signals.breakout_probability. Advisory only for now (strong purged-OOF AUC
  // ~0.73 but on limited history); the weekly --train refits as coverage grows.
  await runPython('breakout_classifier.py', ['--score'], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] breakout_classifier score failed:', (e as Error).message));

  // Winner attribution: which stocks actually flew today, did we have them flagged,
  // and which precursors preceded the move → rolling lift → tomorrow's candidate list.
  await runPython('high_flyer_retrospective.py', [], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] high_flyer_retrospective failed:', (e as Error).message));

  // Breakout classifier (Lever #4) -- moved here from the weekly retrain (2026-07-17): its
  // only training source, stock_ohlcv, updates once a day at EOD, so daily is the cadence
  // that actually tracks the data rather than going stale for most of the week.
  await runPython('breakout_classifier.py', ['--train', '--score'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] breakout_classifier train failed:', (e as Error).message));
  // Day-movement predictor: cross-sectional model for which stocks will have an outsized
  // intraday RANGE today (regardless of direction) -- purged-OOF AUC 0.76 on OHLCV alone
  // (2026-07-17). Advisory-only for now: writes technical_signals.movement_probability,
  // not yet blended into intraday_ranker.py's score or position sizing.
  await runPython('movement_predictor.py', ['--train', '--score'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] movement_predictor train failed:', (e as Error).message));

  // Intraday feedback loop: paper-trade today's intraday recs vs the day's OHLC, then reverse-
  // engineer which signals preceded the winners → learned blend weights the ranker leans on.
  await runPython('intraday_outcome_resolver.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] intraday_outcome_resolver failed:', (e as Error).message));
  await runPython('intraday_strategy_learner.py', [], 120_000)
    .catch(e => console.warn('[QUEUE] intraday_strategy_learner failed:', (e as Error).message));

  await T.run('reward-engine', () => runPython('reward_engine.py'));
  // --update only recomputes Q-values for existing rl_episodes rows; nothing creates NEW
  // rows day-to-day (log_episode() is unused dead code) — --backfill is what actually
  // inserts episodes from newly-resolved signal_outcomes. A short lookback keeps this a
  // cheap daily top-up instead of re-scanning the full history (default 180d) every run.
  // Budget: measured 220s uncontended on 2026-07-31 (13,313 outcomes -> Q-updates) against a
  // 5-minute budget — 27% headroom, which concurrent load in this 19:30-00:00 window eats.
  await runPython('rl_agent.py', ['--backfill', '--lookback', '5'], 15 * 60_000)
    .catch(e => console.warn('[QUEUE] rl_agent backfill failed:', (e as Error).message));
  await T.run('rl-agent-update', () => runPython('rl_agent.py', ['--update']));

  const { computeSignalTypeStats } = await import('./technicalSignalsService');
  await T.run('signal-type-stats', () => computeSignalTypeStats());

  // news_symbol_link (news_sentiment_items -> symbol index) was built as a ONE-TIME manual
  // backfill on 2026-07-31 and never touched again -- 3,754+ articles published since (found
  // 2026-08-06 while tracing why a real, correctly-tagged, 24h-old bullish CELLO catalyst
  // never influenced its score) had zero linkage rows. The writer is idempotent
  // (ON CONFLICT(news_id, symbol) DO NOTHING, no destructive rebuild in the normal case) and
  // measured 29s uncontended against the live DB -- cheap enough to run nightly, last in this
  // chain so it picks up the day's full news-collection cycles (GNews runs up to every 6h).
  // No dataQualityChecks.ts entry needed: this is a derived index built entirely from two
  // already-monitored tables (news_sentiment_items, nse_stocks), not a new external datasource.
  await T.run('news-symbol-link', () => runPython('data_integrity_repair.py', ['--news-link'], 5 * 60_000));

  // Surface the real per-step outcomes (and a degraded job state if any failed) instead of the
  // old blanket 'success' the completed handler used to stamp on all of these.
  T.finish();
  return { success: true };
}

// ── Trendlyne checklist cycle processor (self-rescheduling, random interval) ──

async function processTrendlyneChecklistCycle(_job: Job): Promise<void> {
  const queue = trendlyneChecklistCycleQueue!;
  let nextDelayMs = randomDelayMs(15, 45);
  try {
    // Checklist fundamentals (5yr PAT trend, sales growth, etc.) have no intraday sensitivity —
    // unlike trendlyne-intraday-scan/confluence-compute, this job previously had NO market-hours
    // gate at all, so it kept ticking straight through 09:15-15:30 IST, adding concurrent
    // Trendlyne request load on top of the intraday scan's own calls (2026-08-04 job-timing
    // audit). Skip-and-reschedule during market hours, same pattern as every other gated job.
    if (await isMarketOpen()) {
      console.log('[TRENDLYNE-CHECKLIST] Skipped — market hours (checklist data has no intraday sensitivity)');
      return;
    }
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
        } else {
          await markChecklistAttempted(stock.symbol, Date.now());
        }
      } catch (e: any) {
        console.warn(`[TRENDLYNE-CHECKLIST] Failed for ${stock.symbol}:`, e.message);
        await markChecklistAttempted(stock.symbol, Date.now());
      }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }

    console.log(`[TRENDLYNE-CHECKLIST] Processed ${batch.length} stocks this run.`);
  } finally {
    await queue.add('checklist-cycle-tick', {}, { delay: nextDelayMs, removeOnComplete: 3, removeOnFail: 3 });
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Python runner ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

async function processMlWeeklyRetrain(_job: Job): Promise<{ success: boolean }> {
  // Dashboard sub-tasks (ml-ensemble-train, strategy-optimizer) run under T.run so their monitor
  // state reflects the REAL outcome via T.finish() — not the blanket 'success' the completed
  // handler used to stamp. Untracked steps stay best-effort with console.warn.
  const T = new StepTracker('ml-weekly-retrain');
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
  // Scoped to scripts/stocklist.json (~2005 stocks), not the full tlid universe: 2005 stocks
  // × 2 API calls × 0.5s = ~34 min; 150 min timeout is generous headroom
  await runPython('trendlyne_fundamentals_fetcher.py', [], 150 * 60_000)
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
  // Best-effort: a resolver blip must NOT skip the ml_ensemble --train below (the whole
  // point of the weekly job). Every step here is idempotent and independently catchable.
  await runPython('outcome_resolver.py', ['--horizon', '5'])
    .catch(e => console.warn('[QUEUE] weekly outcome_resolver(5) failed:', (e as Error).message));
  await runPython('outcome_resolver.py', ['--horizon', '15'])
    .catch(e => console.warn('[QUEUE] weekly outcome_resolver(15) failed:', (e as Error).message));
  // Run exit labeler to resolve excursions. Unlike the daily-ops call (--limit 500), this
  // one is unbounded — it's the weekly catch-up sweep for the full backlog since last
  // Sunday — so it needs real headroom; 10min was SIGTERM-killing it most weeks (2026-07-19).
  await runPython('exit_labeler.py', [], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] exit_labeler failed:', (e as Error).message));
  // Retrain the exit policy models. 10min was SIGTERM-killing this deterministically (not
  // just under contention) once signal_excursions grew to ~145k rows -- GradientBoosting
  // fits 4 models (2 targets x split-fit + refit-all) at n_estimators=300, measured 703s
  // uncontended on 2026-07-26. Same growing-dataset timeout pattern already hit once before
  // by exit_labeler.py just above (bumped 10min -> 30min on 2026-07-19); mirrored here.
  await runPython('exit_policy.py', ['--train'], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] exit_policy training failed:', (e as Error).message));
  // --tune runs Optuna hyperparameter search (this is what took the model from AUC 0.70 to
  // 0.757 in the first place) — without it, every scheduled retrain silently falls back to
  // untuned defaults, which measured ~0.20 AUC worse on held-out test in one observed run.
  // Soft failure: if ml-ensemble-train crashes (e.g. ValueError in score_pending), log the
  // warning but let the weekly job continue to breakout_classifier, strategy-optimizer, etc.
  // and always reach T.finish() so the heartbeat is written.
  await T.run('ml-ensemble-train', () => runPython('ml_ensemble.py', ['--train', '--tune', '--score'], 90 * 60_000))
    .catch(e => console.warn('[QUEUE] ml-ensemble-train failed (weekly retrain continues):', (e as Error).message));
  // breakout_classifier.py moved to daily ops (2026-07-17) -- its only training source,
  // stock_ohlcv, updates once a day at EOD, so a weekly cadence left it stale against data
  // that had already moved on for up to 6 of every 7 days.
  await runPython('cs_ranker.py', ['--train', '--score'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] cs_ranker retrain failed:', (e as Error).message));
  await T.run('strategy-optimizer', () => runPython('strategy_optimizer.py', [], 30 * 60_000));
  await runPython('backtester.py', ['--start', '2023-01-01'], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] backtester failed:', (e as Error).message));
  // Backtest-driven strategy parameter tuning (holdout-gated inside the script itself).
  // Keeps app_settings.optimal_* fresh only when out-of-sample Sharpe improves.
  await T.run('backtest-optimizer', () => runPython('backtest_optimizer.py', ['--window', '365'], 60 * 60_000))
    .catch(e => console.warn('[QUEUE] backtest_optimizer failed (weekly retrain continues):', (e as Error).message));
  await runPython('performance_tracker.py', ['--horizon', '5'])
    .catch(e => console.warn('[QUEUE] weekly performance_tracker(5) failed:', (e as Error).message));
  await runPython('performance_tracker.py', ['--horizon', '15'])
    .catch(e => console.warn('[QUEUE] weekly performance_tracker(15) failed:', (e as Error).message));
  // Factor-edge validation: does each candidate vendor/derived score actually predict forward
  // returns? Persists rank IC + cross-sectional AUC per horizon/regime to factor_edge_history so a
  // score that crosses the usable threshold surfaces as history accumulates. Advisory only —
  // nothing sizes on these yet (DVM is still LOW-DATA; re-evaluated every weekly run).
  await runPython('factor_edge.py',
    ['--table', 'trendlyne_dvm_scores', '--scores', 'd_score,v_score,m_score',
     '--horizons', '5,10,21,63', '--by-regime', '--persist'], 15 * 60_000)
    .catch(e => console.warn('[QUEUE] factor_edge (dvm) failed:', (e as Error).message));
  T.finish();
  return { success: true };
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Initialise queues & workers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬


/**
 * One quant-eod-sync step, under its own execution budget.
 *
 * These steps are TypeScript, so unlike the Python steps (which execFile already bounds and
 * kills) nothing bounds them: a stalled socket or a DB lock wait parks the step forever and
 * wedges the concurrency-1 slot. A blown budget throws, which preserves this job's existing
 * abort-on-step-failure behaviour while naming the culprit instead of failing anonymously.
 *
 * Budgets are PROVISIONAL and deliberately loose. No per-step timings were ever recorded; the
 * only hard data is whole-job runs of 153/157/239 min plus etnow-screener-sync's measured ~11
 * min standalone. They are sized to catch a hang, not to police normal runtime. The duration
 * line logged below is the data needed to tighten them — revisit once a week of runs exists.
 */
async function quantStep<T>(label: string, budgetMin: number, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await withJobTimeout(`quant-eod-sync:${label}`, budgetMin * 60_000, fn);
  } finally {
    console.log(`[QUANT EOD] ${label} took ${((Date.now() - t0) / 60_000).toFixed(1)}min`);
  }
}

/**
 * Await concurrent steps, then re-throw the first failure.
 *
 * allSettled rather than Promise.all on purpose: all() rejects on the first failure and leaves
 * the siblings running unawaited, which is how you orphan an in-flight sync — the exact class of
 * problem this job already has. Waiting for every step to settle before re-throwing preserves
 * the processor's pre-existing abort-on-step-failure behaviour with no orphans.
 */
async function quantPhase(steps: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(steps);
  const failed = results.find(r => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

async function processQuantEodSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] quant-eod-sync starting...');
  try {
    // Phase 1 — different vendors (NiftyTrader vs Trendlyne). Both write proprietary_scores_history
    // but under a different `source`, so ON CONFLICT(symbol,date,source,score_type) keeps the rows
    // disjoint; concurrent upserts can't collide.
    console.log('[QUANT EOD] 1. Syncing NiftyTrader & Trendlyne Scores');
    await quantPhase([
      quantStep('niftytrader-scores', 30, () => syncNiftyTraderScores()),
      quantStep('trendlyne-scores', 30, () => syncTrendlyneScores()),
    ]);

    // Serial, and deliberately not folded into a phase with any other Trendlyne step: overlapping
    // two Trendlyne calls risks the vendor rate-limit this repo has been bitten by before.
    console.log('[QUANT EOD] 1.5. Syncing Trendlyne Technical Snapshots');
    await quantStep('trendlyne-technicals', 45, () => syncTrendlyneTechnicals());

    // Trendlyne/MoneyControl/ETNow SCREENER MEMBERSHIP sync, full-universe fundamentals resync,
    // and the index-level PCR/GEX refresh were REMOVED from here 2026-08-04 (job-timing audit).
    // All three were pure duplication, not a safety net:
    //   - mc-screeners / etnow-screeners / trendlyne-screeners already run once, dependency-ordered,
    //     at 18:00/18:20/18:40 IST (et-marketstats-sync/mc-sync/etnow-sync in screeners.jobs.ts) --
    //     well before this job's 22:00 IST slot. Providers publish screener membership once/day
    //     post-close; re-fetching ~1,300-1,400 screeners again 2-4h later re-wrote identical rows.
    //   - fundamentals-sync (runFullFundamentalsSync(), a full-universe Yahoo Finance deep pull with
    //     NO staleness filter) has its own dedicated WEEKLY job (sync-fundamentals-weekly, Sunday
    //     08:30 IST). Calling it here too meant "weekly" fundamentals actually ran 6 nights/week --
    //     D/E, ROE, revenue growth etc. don't change day-to-day outside earnings season.
    //   - pcr_fetcher.py --gex (index PCR/GEX) already runs every 15 min during market hours
    //     (market-regime-refresh) and once more in ml-daily-ops (~19:30 IST) -- a 4th same-day call
    //     at 22:00 IST added nothing since index EOD PCR doesn't move after close.
    // See docs session notes 2026-08-04 for the full evidence trail (each call traced to its
    // function body, not just its job name).
    console.log('[QUANT EOD] 4. Syncing Delivery Data for Today');
    const today = new Date().toISOString().split('T')[0];
    await quantStep('delivery-map', 10, () => fetchDeliveryMap(today));

    updateMonitorState('quant-eod-sync', 'success');
    console.log('[QUEUE] quant-eod-sync completed successfully');
    return { success: true };
  } catch (err: any) {
    updateMonitorState('quant-eod-sync', 'failed', err.message);
    console.error('[QUEUE] quant-eod-sync failed:', err.message);
    throw err;
  }
}


// Catch-up throttle. Every queue that missed a slot used to enqueue its make-up run with no
// delay, so a restart fired all of them at once — each queue has its own concurrency-1 worker,
// so N heavy jobs started simultaneously on one box. That burst is what preceded both wedges.
// Staggering start times spreads the herd; the counter is module-level so the stagger is global
// across every addJobWithCatchup call in a single initQueues() pass, not per-queue.
const CATCHUP_STAGGER_MS = 5 * 60_000;
let _catchupSlot = 0;

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
        // Ollama now keeps the model resident between calls (OLLAMA_KEEP_ALIVE in aiService.ts,
        // was `keep_alive: 0` forcing a full reload per stock) and the quant/surveillance gates
        // run before the LLM call, so this no longer needs to be as conservative as when every
        // single job paid a cold model load.
        concurrency: 2,
        lockDuration: 600000,    // 10 minutes
        lockRenewTime: 180000,   // 3 minutes renewal
        stalledInterval: 600000, // 10 minutes (Don't check for stalls too frequently)
        maxStalledCount: 2,      // Fewer stalls allowed to trigger fail-fast
        limiter: {
          max: 3,
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

    const screenerJobs = await registerScreenerJobs(connection);
    ({ queue: stockScoringQueue, worker: scoringWorker } = screenerJobs.stockScoring);
    ({ queue: mcScreenerSyncQueue, worker: mcScreenerSyncWorker } = screenerJobs.mcScreenerSync);
    ({ queue: etnowScreenerSyncQueue, worker: etnowScreenerSyncWorker } = screenerJobs.etnowScreenerSync);
    ({ queue: etMarketstatsSyncQueue, worker: etMarketstatsSyncWorker } = screenerJobs.etMarketstatsSync);
    ({ queue: trendlyneScreenerSyncQueue, worker: trendlyneScreenerSyncWorker } = screenerJobs.trendlyneScreenerSync);
    ({ queue: fundamentalsSyncQueue, worker: fundamentalsSyncWorker } = screenerJobs.fundamentalsSync);
    ({ queue: quantScoringQueue, worker: quantScoringWorker } = screenerJobs.quantScoring);

    // ── Walk-forward-optimize queue (on-demand, no repeatable schedule) ────────
    walkForwardOptimizeQueue = new Queue(QUEUE_WALK_FORWARD_OPTIMIZE, { connection });

    walkForwardOptimizeWorker = new Worker(
      QUEUE_WALK_FORWARD_OPTIMIZE,
      processWalkForwardOptimize,
      {
        connection,
        concurrency: 1,
        lockDuration: 30 * 60 * 1000, // 30 min — several DE searches back to back per fold
        lockRenewTime: 5 * 60 * 1000,
      },
    );

    walkForwardOptimizeWorker.on('completed', (job) => {
      console.log(`[QUEUE] walk-forward-optimize completed (job ${job.id})`);
    });
    walkForwardOptimizeWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] walk-forward-optimize failed (job ${job?.id}):`, err.message);
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
        // Was '*/30 * * * *' (unrestricted, 24/7) -- the only intraday-cadence job in this file
        // without an hours/isMarketOpen guard, so it recomputed RSI/MACD/BB/divergence across
        // the full universe at 2 AM and on weekends/holidays against completely unchanged EOD
        // data. Narrowed to the same 8:30 AM-4:00 PM IST window as intraday-fetcher (one extra
        // post-close run), plus the same in-handler isMarketOpen() check for holiday-awareness.
        repeat: { pattern: '*/30 3-10 * * 1-5' }, // 3:00-10:30 UTC = 8:30 AM-4:00 PM IST, weekdays
        jobId: 'technical-signals-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    technicalSignalsWorker = new Worker(
      QUEUE_TECHNICAL_SIGNALS,
      async (_job: Job) => {
        if (!(await isMarketOpen())) {
          console.log('[QUEUE] technical-signals skipped — outside NSE market hours (weekend/holiday)');
          return;
        }
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
      // MoneyControl per-stock news (genuinely live, no metered quota -- mcFetchJson's own
      // Semaphore throttles concurrency) — denser cadence than Google News above since there's
      // no external rate budget to conserve.
      addJobWithCatchup(newsSentimentQueue,
        'mc-stock-news-refresh',
        {},
        {
          repeat: { every: 2 * 60 * 60 * 1000 }, // every 2 hours
          jobId: 'mc-stock-news-repeatable',
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
      // Results-season 2nd pass: board-meeting/results announcements are the most
      // price-sensitive BSE filings and an hourly-only poll can sit on one for up to 59 min.
      // Offset 30 min from the hourly job above (effective ~30-min cadence together) but a
      // pure no-op outside results season (isResultsSeasonActive() gate in the worker below) --
      // so this changes nothing on a quiet week and only adds load during the ~6 weeks/quarter
      // that actually need it.
      addJobWithCatchup(newsSentimentQueue,
        'bse-announcements-refresh-hot',
        {},
        {
          repeat: { every: 60 * 60 * 1000, offset: 30 * 60 * 1000 },
          jobId: 'bse-announcements-hot-repeatable',
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      ),
      // GNews (gnews.io) — 3 differentiated cadences, not one flat job: market/stock news is
      // what actually feeds trading decisions and goes stale fast, global business context
      // moves slower. Gated on GNEWS_API_KEY (a no-op cycle otherwise). Combined budget
      // 24+24+4=52 req/day against the 100/day free-tier cap — see newsSentimentService.ts's
      // GNews section header for the full per-cycle breakdown.
      addJobWithCatchup(newsSentimentQueue,
        'gnews-market-refresh',
        {},
        {
          repeat: { every: 2 * 60 * 60 * 1000 }, // 2h -> 24 req/day (2 calls/cycle)
          jobId: 'gnews-market-repeatable',
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      ),
      addJobWithCatchup(newsSentimentQueue,
        'gnews-stocks-refresh',
        {},
        {
          repeat: { every: 60 * 60 * 1000 }, // 1h -> 24 req/day (1 call/cycle, rotating batch)
          jobId: 'gnews-stocks-repeatable',
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      ),
      addJobWithCatchup(newsSentimentQueue,
        'gnews-global-refresh',
        {},
        {
          repeat: { every: 6 * 60 * 60 * 1000 }, // 6h -> 4 req/day (1 call/cycle)
          jobId: 'gnews-global-repeatable',
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      ),
      // Investing.com India (free, no key) — separate cadence from the flat 15-min
      // NEWS_SOURCES cycle above; see newsSentimentService.ts's INVESTING_SOURCES comment
      // for why (both feeds refresh far slower than 15 min, would just re-fetch stale items).
      addJobWithCatchup(newsSentimentQueue,
        'investing-ideas-refresh',
        {},
        {
          repeat: { every: 3 * 60 * 60 * 1000 }, // every 3h
          jobId: 'investing-ideas-repeatable',
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
        } else if (job.name === 'mc-stock-news-refresh') {
          await svc.runMcStockNewsCycle();
        } else if (job.name === 'bse-announcements-refresh') {
          await svc.runBseAnnouncementsCycle();
        } else if (job.name === 'bse-announcements-refresh-hot') {
          if (!(await svc.isResultsSeasonActive())) {
            console.log('[QUEUE] bse-announcements-refresh-hot skipped — not results season');
            return;
          }
          await svc.runBseAnnouncementsCycle();
        } else if (job.name === 'gnews-market-refresh') {
          await svc.runGNewsMarketCycle();
        } else if (job.name === 'gnews-stocks-refresh') {
          await svc.runGNewsStocksCycle();
        } else if (job.name === 'gnews-global-refresh') {
          await svc.runGNewsGlobalCycle();
        } else if (job.name === 'investing-ideas-refresh') {
          await svc.runInvestingIdeasCycle();
        } else {
          await svc.runNewsSentimentCycle();
        }
      },
      // Network-bound (Google News/BSE fetches over ~150 companies, batched); no per-fetch
      // timeout visible in fetchSource, so a slow upstream response can push this past the
      // previous 5-min lockDuration -- matches the 2026-07-06 "job stalled" failures.
      {
        connection,
        concurrency: 1,
        lockDuration: 10 * 60 * 1000,
        lockRenewTime: 2 * 60 * 1000,
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

    const operationsJobs = await registerOperationsJobs(connection);
    ({ queue: outcomeResolverQueue, worker: outcomeResolverWorker } = operationsJobs.outcomeResolver);
    ({ queue: researchPremarketQueue, worker: researchPremarketWorker } = operationsJobs.researchPremarket);
    ({ queue: researchPostcloseQueue, worker: researchPostcloseWorker } = operationsJobs.researchPostclose);

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
        repeat: { pattern: '0 14 * * 1-5' }, // 7:30 PM IST (14:00 UTC), Mon-Fri after EOD files are published
        jobId: 'ml-daily-ops',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    mlDailyOpsWorker = new Worker(
      QUEUE_ML_DAILY_OPS,
      // 3.5h budget vs the 4h lock: a normal run is ~2-3h, so this only fires on a genuine
      // hang, and it fires before BullMQ's stall path can requeue the wedged job.
      (job) => withJobTimeout('ml-daily-ops', 3.5 * 60 * 60 * 1000, () => processMlDailyOps(job)),
      {
        connection,
        concurrency: 1,
        // Job runs 120+ scripts sequentially (~2-3h total). Lock must cover the full
        // run or BullMQ marks it stalled and requeues it, creating a loop that blocks
        // the next day's scheduled run. Scripts use ON CONFLICT so restart is safe.
        lockDuration: 4 * 60 * 60 * 1000,  // 4h — covers the full daily ops run
        lockRenewTime: 30 * 60 * 1000,
        stalledInterval: 15 * 60 * 1000,
        maxStalledCount: 3,
      },
    );

    mlDailyOpsWorker.on('completed', (_job) => {
      // Per-step + overall monitor states are written by StepTracker.finish() inside the
      // processor (reflecting real outcomes), so this handler no longer blanket-marks success.
      console.log('[QUEUE] ml-daily-ops completed');
    });
    mlDailyOpsWorker.on('failed', (_job, err) => {
      // Processor threw before finish() ran (steps are best-effort, so this is a harness/uncaught
      // error, not a step failure) — mark the job failed so it isn't seen as healthy.
      console.error('[QUEUE] ml-daily-ops failed:', err.message);
      recordHeartbeat('ml-daily-ops', 'failed', err?.message);
    });

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ ML weekly retrain + optimize (Sunday 6 PM IST = 12:30 UTC) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    mlWeeklyRetrainQueue = new Queue(QUEUE_ML_WEEKLY_RETRAIN, { connection });
    // addJobWithCatchup does its own remove-then-add internally (and needs the pre-removal
    // repeatable's `next` to detect a slot missed by a restart) — removing it here first would
    // erase that signal before the helper ever sees it.
    await addJobWithCatchup(mlWeeklyRetrainQueue, 'ml-weekly-retrain', {}, {
      repeat: { pattern: '0 5 * * 0' }, // Sunday 10:30 IST (05:00 UTC) — early on the closed day, after fundamentals
      jobId: 'ml-weekly-retrain',
      removeOnComplete: 2, removeOnFail: 3,
    });
    mlWeeklyRetrainWorker = new Worker(QUEUE_ML_WEEKLY_RETRAIN, processMlWeeklyRetrain, {
      connection,
      concurrency: 1,
      lockDuration: 6 * 60 * 60 * 1000,
      lockRenewTime: 30 * 60 * 1000,
      stalledInterval: 15 * 60 * 1000,
      maxStalledCount: 3,
    });
    mlWeeklyRetrainWorker.on('completed', () => {
      // Per-step + overall monitor states are written by StepTracker.finish() in the processor.
      console.log('[QUEUE] ml-weekly-retrain done');
    });
    mlWeeklyRetrainWorker.on('failed', (_, err) => {
      // Processor threw before finish() ran — mark the job failed so it isn't seen as healthy.
      console.error('[QUEUE] ml-weekly-retrain failed:', err.message);
      updateMonitorState('ml-weekly-retrain', 'failed', err?.message);
    });

    // ── Intraday fetcher (every 15 min, 8:30 AM - 4:00 PM IST = 3:00-10:30 UTC, weekdays)
    // Was */30: TechCharts bars are resolution=15 (a new bar only forms every 15 min), so a
    // 30-min cadence needlessly doubled worst-case CMP staleness for no reason -- 15 min
    // matches the source data's own granularity, ~4min runtime leaves ample headroom.
    intradayFetcherQueue = new Queue(QUEUE_INTRADAY_FETCHER, { connection });
    const intradayRep = await intradayFetcherQueue.getRepeatableJobs();
    for (const r of intradayRep) await intradayFetcherQueue.removeRepeatableByKey(r.key);
    await intradayFetcherQueue.add('intraday-fetcher', {}, {
      repeat: { pattern: '*/15 3-10 * * 1-5', tz: 'Etc/UTC' },
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


    const dlJobs = await registerDlJobs(connection);
    ({ queue: dlMacroFetchQueue, worker: dlMacroFetchWorker } = dlJobs.macroFetch);
    ({ queue: dlFeatureRefreshQueue, worker: dlFeatureRefreshWorker } = dlJobs.featureRefresh);
    ({ queue: dlInferenceQueue, worker: dlInferenceWorker } = dlJobs.inference);
    ({ queue: dlRegimeUpdateQueue, worker: dlRegimeUpdateWorker } = dlJobs.regimeUpdate);
    ({ queue: dlRetrainWeeklyQueue, worker: dlRetrainWeeklyWorker } = dlJobs.retrainWeekly);

    // ── Pre-open snapshot (3:40 AM UTC = 9:10 AM IST, weekdays) ──────────────────────────
    // GIFT Nifty level + Asia sentiment + global risk score captured before Indian market opens.
    const QUEUE_PREOPEN = 'preopen-snapshot';
    const preopenQueue = new Queue(QUEUE_PREOPEN, { connection });
    const preopenRep = await preopenQueue.getRepeatableJobs();
    for (const r of preopenRep) await preopenQueue.removeRepeatableByKey(r.key);
    await preopenQueue.add('preopen-daily', {}, {
      // tz is mandatory here: with no tz, BullMQ/cron-parser falls back to the Node process's
      // local timezone, which on this deployment is Asia/Kolkata -- so '40 3' was firing at
      // 3:40 AM IST (hours before NSE's 9:00-9:15 IST preopen session even opens) instead of
      // the intended 3:40 AM UTC = 9:10 AM IST. Confirmed live via Redis (`bull:preopen-snapshot:
      // repeat:*`): the stored repeat definition had no `tz` key and its computed next-fire
      // epoch was 22:10 UTC (= 03:40 IST), while every sibling cron job in this file resolves
      // to `tz: 'Etc/UTC'` either explicitly or via addJobWithCatchup()'s auto-injection --
      // this was the one holdout still using a raw, pre-registerJob.ts-extraction Queue.add().
      repeat: { pattern: '40 3 * * 1-5', tz: 'Etc/UTC' },
      jobId: 'preopen-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    new Worker(QUEUE_PREOPEN,
      async () => {
        // 3 min: NSE preopen endpoints respond slowly (or hang) when hit outside the
        // 9:00-9:15 IST window -- e.g. a restart catch-up job -- and 60s killed those runs.
        await runPython('preopen_fetcher.py', [], 3 * 60_000)
          .then(() => recordHeartbeat('preopen-snapshot', 'success'))
          .catch(e => {
            console.warn('[QUEUE] preopen_fetcher failed:', (e as Error).message);
            recordHeartbeat('preopen-snapshot', 'failed', (e as Error).message);
          });

        console.log('[QUEUE] Running early_hours_predictor...');
        await runPython('early_hours_predictor.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] early_hours_predictor failed:', (e as Error).message));
      },
      // No lockDuration previously -- fell back to BullMQ's 30s default while this worker
      // awaits up to 2 sequential 60s runPython calls (120s worst case), causing repeated
      // "job stalled more than allowable limit" failures.
      { connection, concurrency: 1, lockDuration: 3 * 60_000 });
    console.log('[QUEUE] Pre-open snapshot scheduled at 9:10 AM IST (weekdays)');

    // ── Intraday regime refresh: VIX + USDINR + Nifty basis every 15 min (9:15–15:30 IST) ──
    const QUEUE_REGIME = 'market-regime-refresh';
    const regimeQueue = new Queue(QUEUE_REGIME, { connection });
    const regimeRep = await regimeQueue.getRepeatableJobs();
    for (const r of regimeRep) await regimeQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(regimeQueue, 'regime-intraday', {}, {
      repeat: { pattern: '*/15 3-10 * * 1-5' },  // 3:45–10:00 UTC = 9:15–15:30 IST
      jobId: 'regime-intraday',
      removeOnComplete: 3, removeOnFail: 3,
    });
    new Worker(QUEUE_REGIME,
      async () => {
        // Ordered intraday chain — runs every 15 min while the tape is live. Guard on the
        // holiday-aware status so this cron (weekday+time only) no-ops on holidays.
        if (!(await isMarketOpen())) {
          console.log('[QUEUE] intraday pipeline skipped — outside NSE market hours (weekend/holiday)');
          recordHeartbeat('market-regime-refresh', 'success');
          recordHeartbeat('intraday-ranker', 'success');
          return;
        }
        // 0) capture intraday breadth BEFORE the regime label that consumes it.
        // Previously this only ran as a side effect of liveStockData.ts's quote refresh,
        // which is cache-driven -- so it fired only when a user request happened to miss the
        // cache during market hours. Result: 54 snapshot rows total, with multi-day gaps, and
        // intraday_regime.py's (correct) staleness guard therefore dropped breadth from the
        // regime fusion most cycles. On this chain it runs every 15 min like its consumer.
        try {
          const { getOrRefreshAllStocks } = await import('./liveStockData');
          const { persistIntradayBreadth } = await import('./intradayBreadth');
          const quotes = await getOrRefreshAllStocks();
          const breadth = await persistIntradayBreadth(quotes);
          recordHeartbeat('intraday-breadth-capture', 'success');
          if (breadth) console.log(`[QUEUE] intraday breadth captured (score ${breadth.breadthScore})`);
        } catch (e) {
          console.warn('[QUEUE] intraday breadth capture failed:', (e as Error).message);
          recordHeartbeat('intraday-breadth-capture', 'failed', (e as Error).message);
        }
        // 1) fetch live macro (VIX/USDINR/basis) → macro_asset_prices
        await runPython('market_regime_fetcher.py', [], 60_000)
          .then(() => recordHeartbeat('market-regime-refresh', 'success'))
          .catch(e => {
            console.warn('[QUEUE] market_regime_fetcher failed:', (e as Error).message);
            recordHeartbeat('market-regime-refresh', 'failed', (e as Error).message);
          });
        // 1b) Nifty PCR + dealer GEX (index-level only, ~90s) → macro_asset_prices. Previously
        // only refreshed once/day inside ml-daily-ops/quant-eod-sync, so the intraday regime
        // nowcast below fused a stale EOD PCR all session. This is the lightweight index-only
        // call (NOT so_option_chain_fetcher.py/stock_option_chain_fetcher.py, the ~30min/3min
        // per-stock scrapes that stay EOD-only) -- cheap enough for a 15-min cadence.
        await runPython('pcr_fetcher.py', ['--gex'], 90_000)
          .catch(e => console.warn('[QUEUE] pcr_fetcher (intraday) failed:', (e as Error).message));
        // 2) fuse VIX/basis/MMI/breadth/PCR → app_settings.intraday_regime (non-fatal: ranker
        //    defaults to NEUTRAL if this is missing)
        await runPython('intraday_regime.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] intraday_regime failed:', (e as Error).message));
        // 3) rank stocks for intraday off the fresh regime → intraday_recommendations
        await runPython('intraday_ranker.py', [], 5 * 60_000)
          .then(() => recordHeartbeat('intraday-ranker', 'success'))
          .catch(e => {
            console.warn('[QUEUE] intraday_ranker failed:', (e as Error).message);
            recordHeartbeat('intraday-ranker', 'failed', (e as Error).message);
          });
      },
      // Generous lockDuration: four sequential runPython calls (~8.5 min worst case) plus the
      // shared 5-concurrent-subprocess semaphore wait, so BullMQ doesn't consider it stalled.
      { connection, concurrency: 1, lockDuration: 10 * 60_000 });
    console.log('[QUEUE] Intraday pipeline (regime fetch → PCR/GEX → regime label → ranker) scheduled every 15 min during market hours');

    // ── Closed-day early batch ────────────────────────────────────────────────
    // On a TRADING HOLIDAY (weekday, exchange shut) there is no market close to wait for, so run
    // the daily learning/ranking pipeline in the morning instead of the usual evening slot.
    // Weekends are handled separately by the early-Sunday weekly jobs. No-ops on normal sessions.
    // On a holiday the usual evening crons still fire (idempotent re-run) — this is purely additive.
    const QUEUE_CLOSED_DAY = 'closed-day-early-batch';
    const closedDayQueue = new Queue(QUEUE_CLOSED_DAY, { connection });
    const cdRep = await closedDayQueue.getRepeatableJobs();
    for (const r of cdRep) await closedDayQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(closedDayQueue, 'closed-day-early-batch', {}, {
      // 07:10 IST weekdays (pre-open). Moved off 07:30 IST 2026-07-31 — it started on the
      // same minute as unified-ranker, which it also dispatches (with a 20-min delay) on
      // closed days, so the two were contending at exactly the moment it fans work out.
      repeat: { pattern: '40 1 * * 1-5' },
      jobId: 'closed-day-early-batch',
      removeOnComplete: 3, removeOnFail: 3,
    });
    new Worker(QUEUE_CLOSED_DAY,
      async () => {
        if (!(await isTradingHolidayToday())) {
          recordHeartbeat('closed-day-early-batch', 'success'); // normal session / weekend — nothing to early-run
          return;
        }
        console.log('[QUEUE] Trading holiday — running daily pipeline early (outcome-resolver → ml-daily-ops → unified-ranker)');
        const opt = { removeOnComplete: 3, removeOnFail: 3 };
        try {
          await outcomeResolverQueue?.add('closed-day-early', {}, opt);
          await mlDailyOpsQueue?.add('closed-day-early', {}, opt);
          // unified-ranker after a delay so fresh scores / ml-ops land first
          await unifiedRankerQueue?.add('closed-day-early', {}, { ...opt, delay: 20 * 60_000 });
          recordHeartbeat('closed-day-early-batch', 'success');
        } catch (e) {
          console.warn('[QUEUE] closed-day-early-batch failed:', (e as Error).message);
          recordHeartbeat('closed-day-early-batch', 'failed', (e as Error).message);
        }
      },
      { connection, concurrency: 1, lockDuration: 5 * 60_000 });
    console.log('[QUEUE] Closed-day early batch scheduled (pre-open weekdays; runs the daily pipeline early on trading holidays)');

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ DL Emergency Retrain (on-demand, triggered by drift detector) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    dlRetrainEmergencyQueue = new Queue(QUEUE_DL_RETRAIN_EMERGENCY, { connection });
    dlRetrainEmergencyWorker = new Worker(QUEUE_DL_RETRAIN_EMERGENCY,
      // Same 24h override as dl-retrain-weekly above, and for the same reason -- this queue
      // runs the identical dl_trainer.py orchestrator, just drift-triggered instead of cron'd.
      async () => processDLPython('dl_trainer.py', ['--trigger', 'drift'], 24 * 60 * 60 * 1000),
      {
        connection,
        concurrency: 1,
        lockDuration: 24 * 60 * 60 * 1000,
        lockRenewTime: 30 * 60 * 1000,
        stalledInterval: 15 * 60 * 1000,
        maxStalledCount: 3,
      });
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
      {
        connection,
        concurrency: 1,
        lockDuration: 3 * 60 * 60 * 1000,
        lockRenewTime: 15 * 60 * 1000,
        stalledInterval: 15 * 60 * 1000,
        maxStalledCount: 3,
      });
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
      // 04:20 PM IST (10:50 UTC). Moved off 4:15 PM 2026-07-31 — it started on the same
      // minute as research-postclose. Order that matters is unchanged and now explicit:
      // stock-refresh 4:00 PM writes the day's bar -> this gap-fills it 4:20 PM ->
      // dl-feature-refresh reads stock_ohlcv at 5:00 PM.
      repeat: { pattern: '50 10 * * 1-5' },
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

    const confluenceJobs = await registerConfluenceJobs();
    ({ queue: confluenceComputeQueue, worker: confluenceComputeWorker } = confluenceJobs.compute);
    ({ queue: confluenceOutcomesQueue, worker: confluenceOutcomesWorker } = confluenceJobs.outcomes);

    const agentJobs = await registerAgentJobs(connection);
    ({ queue: agentDataScientistQueue, worker: agentDataScientistWorker } = agentJobs.dataScientist);
    ({ queue: agentStrategistQueue, worker: agentStrategistWorker } = agentJobs.strategist);
    ({ queue: agentAuditorQueue, worker: agentAuditorWorker } = agentJobs.auditor);
    ({ queue: agentOptimizerQueue, worker: agentOptimizerWorker } = agentJobs.optimizer);

    const syncJobs = await registerSyncJobs(connection);
    ({ queue: screenerPerfQueue, worker: screenerPerfWorker } = syncJobs.screenerPerf);
    ({ queue: companyProfilesSyncQueue, worker: companyProfilesSyncWorker } = syncJobs.companyProfilesSync);
    ({ queue: tickertapeScorecardQueue, worker: tickertapeScorecardWorker } = syncJobs.tickertapeScorecard);
    ({ queue: nseScreenerSyncQueue, worker: nseScreenerSyncWorker } = syncJobs.nseSync);

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
        repeat: { pattern: '30 16 * * 1-5' }, // 10:00 PM IST (16:30 UTC), Mon-Fri after daily ops
        jobId: 'quant-eod-sync-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    quantEodSyncWorker = new Worker(
      QUEUE_QUANT_EOD_SYNC,
      // 5.5h backstop. NOT sized off lockDuration: the last three runs took 153/157/239 min and
      // all completed fine — lockRenewTime keeps renewing while the worker lives, so the 120min
      // lock bounds silence, not runtime. Anything under ~4h would kill healthy nightly runs.
      // The per-step budgets are the real defense and must stay the binding constraint, so this
      // sits above their ~207min worst-case (phases count only their slowest member); it only
      // catches a hang in an unwrapped gap.
      (job) => withJobTimeout('quant-eod-sync', 5.5 * 60 * 60_000, () => processQuantEodSync(job)),
      {
        connection,
        concurrency: 1,
        lockDuration: 120 * 60_000,
        lockRenewTime: 15 * 60_000,
        stalledInterval: 15 * 60 * 1000,
        maxStalledCount: 3,
      }
    );
    quantEodSyncWorker.on('completed', () => console.log('[QUEUE] quant-eod-sync done'));
    quantEodSyncWorker.on('failed', (_, e) => {
      // The processor's own catch can't see a timeout — it rejects outside the processor —
      // so mark the state here too, otherwise a timed-out run leaves the last success showing.
      updateMonitorState('quant-eod-sync', 'failed', e.message);
      console.error('[QUEUE] quant-eod-sync failed:', e.message);
    });

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
          const symbols = await getTrendlyneMetricSymbols();
          await enqueueTrendlyneMetricsFetchJobs(trendlyneDailyFetchQueue!, symbols, 12);
          return;
        }
        await runTrendlyneMetricsFetch(job.data.symbol);
      },
      { connection, concurrency: 2, lockDuration: 30 * 60_000 }
    );

    trendlyneDailyFetchWorker.on('completed', () => {
      console.log('[QUEUE] trendlyne-daily-fetch completed');
      recordHeartbeat('trendlyne-daily-fetch', 'success');
    });
    trendlyneDailyFetchWorker.on('failed', (_, e) => {
      console.error('[QUEUE] trendlyne-daily-fetch failed:', e.message);
      recordHeartbeat('trendlyne-daily-fetch', 'failed', e?.message);
    });

    const trendlyneWeeklyJobs = await registerTrendlyneWeeklyJobs(connection);
    ({ queue: trendlyneMidweekQueue, worker: trendlyneMidweekWorker } = trendlyneWeeklyJobs.midweek);
    ({ queue: trendlyneRatiosMonthlyQueue, worker: trendlyneRatiosMonthlyWorker } = trendlyneWeeklyJobs.ratiosMonthly);

    // Ã¢â€â‚¬Ã¢â€â‚¬ Unified Ranker Ã¢â‚¬â€ daily at 15:45 IST (10:15 UTC) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    unifiedRankerQueue = new Queue(QUEUE_UNIFIED_RANKER, { connection });
    const unifiedRankerWorkerInstance = new Worker(
      QUEUE_UNIFIED_RANKER,
      async () => {
        console.log('[QUEUE] unified-ranker starting...');
        // 30 min: a full run now takes 15-20+ min (700k-row confluence window scans +
        // quality/win-prob loaders). The old 5-min budget timeout-killed 19 of its last
        // 24 runs, leaving unified_recommendations stale for the Top Rated tab.
        await runPython('unified_ranker.py', [], 30 * 60_000);

        // Push today's highest-conviction canonical picks over WebSocket (2026-08-05 fix --
        // see unifiedSignalBroadcast.ts's header for the gap this closes). Best-effort: the
        // ranker's own DB write already succeeded above, so a broadcast failure here must
        // never fail the job.
        try {
          const { broadcastCanonicalPicks } = await import('./unifiedSignalBroadcast');
          const { wsSignalService } = await import('./websocketService');
          const sent = await broadcastCanonicalPicks(wsSignalService);
          console.log(`[QUEUE] unified-ranker broadcast ${sent} canonical pick(s) over WebSocket`);
        } catch (e) {
          console.warn('[QUEUE] unified-ranker WS broadcast failed:', (e as Error).message);
        }
      },
      // No lockDuration previously -- fell back to BullMQ's 30s default while awaiting a
      // runPython call allowed up to 5 minutes, causing repeated "job stalled" failures
      // (confirmed in job_heartbeat: 3 stalls on 2026-07-09 alone).
      { connection, concurrency: 1, lockDuration: 35 * 60_000 },
    );
    unifiedRankerWorker = unifiedRankerWorkerInstance;

    const staleUR = await unifiedRankerQueue.getRepeatableJobs();
    for (const r of staleUR) await unifiedRankerQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(unifiedRankerQueue, 
      'unified-ranker-daily',
      {},
      {
        // 07:30 IST (02:00 UTC), pre-open. Was 15:45 IST (just after close) — but that ran
        // the canonical ranker BEFORE its own inputs refreshed: stock_scores (stock-scoring
        // 22:30 IST), technical_signals ML features + win_probability (ml-daily-ops 19:30 IST)
        // and OHLCV (stock-refresh 16:00 IST) all land AFTER 15:45, so unified_recommendations
        // was always built on ~1-day-stale scores. Running pre-open consumes the fully-refreshed
        // prior-session features and has the fresh ranking ready before the 09:15 open.
        repeat:  { pattern: '0 2 * * 1-5' },
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

    await registerDigestJobs(connection);

    // ── Daily data-integrity report — 8:40 AM IST (03:10 UTC), every day ──────────
    // Formal cron wrapper around dataQualityChecks.ts's ~25-check suite (2026-08-01 audit).
    // The 15-min setInterval poll in jobWatchdog.ts already runs these checks continuously
    // and pages on critical failures -- this does NOT replace that, it exists because the
    // poll itself was never a monitored JOB_REGISTRY job (an unregistered setInterval has no
    // lateness detection: a dead process silently takes monitoring down with it, same class
    // of gap job-digest had before it was registered). Sends a pass/warn/fail summary
    // regardless of outcome, so a quiet day is confirmed rather than assumed. Scheduled
    // after both unified-ranker (07:30 IST) and recommendations-digest (08:15 IST weekdays)
    // so the report reflects that morning's freshly-built state when both ran.
    const QUEUE_DATA_QUALITY_DAILY = 'data-quality-daily';
    const dataQualityDailyQueue = new Queue(QUEUE_DATA_QUALITY_DAILY, { connection });
    const dataQualityDailyWorker = new Worker(
      QUEUE_DATA_QUALITY_DAILY,
      async () => {
        const { runDataQualityChecks } = await import('./dataQualityChecks');
        const results = await runDataQualityChecks();
        const passed = results.filter(r => r.status === 'pass').length;
        const warned = results.filter(r => r.status === 'warn');
        const failed = results.filter(r => r.status === 'fail' || r.status === 'error');
        const criticalFailed = failed.filter(r => r.critical);

        // r.detail routinely embeds raw snake_case table names (e.g. "mf_sector_allocation is
        // empty") -- unbalanced underscores kill this whole single-message digest in Telegram's
        // legacy Markdown parser (confirmed live 2026-08-04, 08:40 IST, matching this job's cron).
        const lines = [`📊 *Daily Data-Integrity Report*`, `${passed}/${results.length} checks passed.`];
        if (failed.length) {
          lines.push('', '*Failures:*');
          for (const r of failed) lines.push(`${r.critical ? '🚨' : '⚠️'} \`${sanitizeMarkdown(r.label)}\` — ${sanitizeMarkdown(r.detail)}`);
        }
        if (warned.length) {
          lines.push('', '*Warnings:*');
          for (const r of warned) lines.push(`⚠️ \`${sanitizeMarkdown(r.label)}\` — ${sanitizeMarkdown(r.detail)}`);
        }
        await telegramService.sendMarkdownMessage(lines.join('\n'));

        if (criticalFailed.length) {
          // The 15-min poll already alerted on these individually; failing this job too
          // means a stuck critical failure shows up as "late" in the digest, not just as a
          // once-a-day Telegram message that's easy to miss among the rest of the channel.
          throw new Error(`${criticalFailed.length} critical data-quality check(s) failing: ${criticalFailed.map(r => r.id).join(', ')}`);
        }
      },
      { connection, concurrency: 1, lockDuration: 5 * 60_000 },
    );
    dataQualityDailyWorker.on('completed', () => {
      console.log('[QUEUE] data-quality-daily sent');
      recordHeartbeat('data-quality-daily', 'success');
    });
    dataQualityDailyWorker.on('failed', (_, err) => {
      console.error('[QUEUE] data-quality-daily failed:', err.message);
      recordHeartbeat('data-quality-daily', 'failed', err.message);
    });

    const dataQualityRepeatables = await dataQualityDailyQueue.getRepeatableJobs();
    for (const r of dataQualityRepeatables) await dataQualityDailyQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(dataQualityDailyQueue, 'data-quality-daily-run', {}, {
      repeat: { pattern: '10 3 * * *' },
      jobId: 'data-quality-daily-repeatable',
      removeOnComplete: 3,
      removeOnFail: 3,
    });

    // ── Trendlyne Checklist Cycle (self-rescheduling, random interval) ──────────
    trendlyneChecklistCycleQueue = new Queue(QUEUE_TRENDLYNE_CHECKLIST_CYCLE, { connection });
    trendlyneChecklistCycleWorker = new Worker(
      QUEUE_TRENDLYNE_CHECKLIST_CYCLE,
      processTrendlyneChecklistCycle,
      { connection, concurrency: 1, lockDuration: 20 * 60 * 1000, lockRenewTime: 3 * 60 * 1000 },
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
    etMarketstatsSyncWorker?.close(),
    trendlyneScreenerSyncWorker?.close(),
    fundamentalsSyncWorker?.close(),
    quantScoringWorker?.close(),
    walkForwardOptimizeWorker?.close(),
    stockRefreshQueue?.close(),
    aiSignalsQueue?.close(),
    stockScoringQueue?.close(),
    mcScreenerSyncQueue?.close(),
    etnowScreenerSyncQueue?.close(),
    etMarketstatsSyncQueue?.close(),
    trendlyneScreenerSyncQueue?.close(),
    fundamentalsSyncQueue?.close(),
    quantScoringQueue?.close(),
    walkForwardOptimizeQueue?.close(),
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

export interface WalkForwardOptimizeParams {
  start: string; end: string; mode?: 'rolling' | 'anchored';
  n_folds?: number; is_days?: number; oos_days?: number; step_days?: number;
  optimize?: boolean; objective?: 'sharpe' | 'sortino';
  min_score?: number; horizon?: number; max_pos?: number; capital?: number; name?: string;
}

export async function enqueueWalkForwardOptimize(
  params: WalkForwardOptimizeParams,
): Promise<{ jobId: string }> {
  if (!walkForwardOptimizeQueue) {
    throw new Error('Walk-forward-optimize queue unavailable (Redis not connected)');
  }
  const job = await walkForwardOptimizeQueue.add('walk-forward-optimize', params, {
    removeOnComplete: 10,
    removeOnFail: 10,
  });
  return { jobId: job.id! };
}

export async function getWalkForwardOptimizeJobStatus(jobId: string): Promise<{
  state: string;
  result: any | null;
  failedReason: string | null;
}> {
  if (!walkForwardOptimizeQueue) {
    throw new Error('Walk-forward-optimize queue unavailable (Redis not connected)');
  }
  const job = await walkForwardOptimizeQueue.getJob(jobId);
  if (!job) {
    return { state: 'not_found', result: null, failedReason: null };
  }
  const state = await job.getState();
  return {
    state,
    result: state === 'completed' ? job.returnvalue : null,
    failedReason: job.failedReason ?? null,
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



