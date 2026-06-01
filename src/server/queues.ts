/**
 * BullMQ queues & workers
 *
 * Two queues:
 *   stock-refresh  â€“ repeatable job every 5 min, refreshes all NSE live prices
 *   ai-signals     â€“ per-stock AI analysis jobs, concurrency 3
 *
 * Both require Redis.  If Redis is unavailable the module exports no-op stubs
 * and the server falls back to the legacy setInterval approach.
 */

import { Queue, Worker, QueueEvents, Job, ConnectionOptions } from 'bullmq';
import { fetchAllLiveStocks } from './liveStockData';
import { cacheSet } from './cacheService';
import { generateStockAnalysis } from '../services/aiService';
import db from './db';
import { syncAndScore } from './scoringService';
import Redis from 'ioredis';
import { REDIS_BASE } from './redisConfig';
import { runPython } from './pythonRunner';
import { pythonApi } from './pythonApi';

// â”€â”€â”€ Redis connection shared across all BullMQ objects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeConnection(isProbe = false): ConnectionOptions {
  const base = {
    ...REDIS_BASE,
    connectTimeout: isProbe ? 2000 : 5000,
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
    maxRetriesPerRequest: null, // Required by BullMQ for blocking commands
    enableOfflineQueue: true,
    autoResubscribe: true,
    retryStrategy: (times) => {
      if (times > 20) return null; // give up after ~60s of retries
      return Math.min(times * 100, 3000);
    },
  };
}

// â”€â”€â”€ Queue names â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

const BULK_CACHE_KEY      = 'live-stocks-bulk';
const BULK_TTL_SECONDS    = 5 * 60;
const REFRESH_REPEAT_MS   = BULK_TTL_SECONDS * 1000;

// â”€â”€â”€ Module-level handles (null when Redis unavailable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
export let outcomeResolverQueue: Queue | null = null;
let outcomeResolverWorker: Worker | null = null;
export let mlDailyOpsQueue: Queue | null = null;
let mlDailyOpsWorker: Worker | null = null;
export let mlWeeklyRetrainQueue: Queue | null = null;
let mlWeeklyRetrainWorker: Worker | null = null;
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

export let screenerPerfQueue: Queue | null = null;
let screenerPerfWorker: Worker | null = null;

// Shared in-process mirror populated by the stock-refresh worker
// (same reference as the one exported from liveStockData via the cache layer)
let bulkMirror: Map<string, any> = new Map();

// â”€â”€â”€ Confluence compute processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processConfluenceCompute(_job: Job): Promise<{ computed: number; elite: number; strong: number }> {
  const { computeConfluenceSignals, runMLProbabilityOverlay } = await import('./confluenceEngine');
  const result = await computeConfluenceSignals();
  runMLProbabilityOverlay().catch((err: any) =>
    console.warn('[CONFLUENCE] ML overlay failed (non-blocking):', err?.message ?? err)
  );
  return result;
}

async function processConfluenceOutcomes(_job: Job): Promise<void> {
  await runPython('confluence_outcome_tracker.py', [], 120_000);
}

// â”€â”€â”€ Stock-refresh worker processor (PHASE 1: Now persists OHLCV) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processStockRefresh(_job: Job): Promise<{ count: number; persisted: number }> {
  const { fetchAndPersistOHLCVData } = await import('./liveStockData');
  const result = await fetchAndPersistOHLCVData();
  return result;
}

// â”€â”€â”€ AI-signals worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processAISignal(job: Job): Promise<void> {
  const { symbol, stockData } = job.data as { symbol: string; stockData: Record<string, unknown> };

  const analysis = await generateStockAnalysis(symbol, stockData);

  // Persist to DB (same schema as the existing saveSignal procedure)
  db.prepare(`
    INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    symbol,
    analysis.signal,
    analysis.entry,
    analysis.target,
    analysis.stopLoss,
    analysis.confidence,
    analysis.reasoning,
    new Date().toISOString(),
  );

  // Update job progress so the frontend can display it
  await job.updateProgress(100);
}

// â”€â”€â”€ Stock-scoring worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processStockScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled stock scoring...');
  const result = await syncAndScore();
  return { success: result.success };
}

// â”€â”€â”€ MC screener sync worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processMcScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled MoneyControl screener sync...');
  const { syncMoneyControlScreeners } = await import('./moneycontrolScreener');
  await syncMoneyControlScreeners();
  return { success: true };
}

// â”€â”€â”€ ETNow screener sync worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processEtnowScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled ETNow screener sync...');
  const { syncETnowScreeners } = await import('./etnowScreenerSync');
  await syncETnowScreeners();
  return { success: true };
}

// â”€â”€â”€ NSE-sync worker processor (PHASE 2: Weekly NSE master data sync) â”€â”€â”€â”€â”€â”€â”€

async function processNSESync(_job: Job): Promise<{ success: boolean; stockCount: number }> {
  console.log('[QUEUE] Starting NSE master data sync...');
  try {
    const { syncNSEStocksToDatabase } = await import('./nseService');
    const result = await syncNSEStocksToDatabase();
    const stockCount = (result?.inserted || 0) + (result?.updated || 0);
    console.log(`[QUEUE] NSE sync completed, ${stockCount} stocks updated`);
    return { success: true, stockCount };
  } catch (err: any) {
    console.error('[QUEUE] NSE sync failed:', err.message);
    throw err;
  }
}

// â”€â”€â”€ Fundamentals-sync worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processFundamentalsSync(job: Job): Promise<{ success: boolean }> {
  const phase2Only = job.data?.phase2Only === true;
  console.log(`[QUEUE] Starting fundamentals sync (phase2Only=${phase2Only})...`);
  const { runFullFundamentalsSync } = await import('./fundamentalsSyncService');
  await runFullFundamentalsSync(phase2Only);
  return { success: true };
}

// â”€â”€â”€ Quant-scoring worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processQuantScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting quant strategy scoring...');
  const { runQuantScoring } = await import('./quantScoringService');
  await runQuantScoring();
  return { success: true };
}

async function processOutcomeResolver(_job: Job): Promise<{ success: boolean }> {
  await runPython('fii_dii_fetcher.py', [], 90_000).catch(() => {});

  await pythonApi.resolveOutcomes(1).catch(e => console.warn('[API] resolve-outcomes(1):', (e as Error).message));
  await pythonApi.resolveOutcomes(5).catch(e => console.warn('[API] resolve-outcomes(5):', (e as Error).message));
  await pythonApi.resolveOutcomes(15).catch(e => console.warn('[API] resolve-outcomes(15):', (e as Error).message));

  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);

  await pythonApi.scorePending().catch(e => console.warn('[API] score-pending:', (e as Error).message));

  return { success: true };
}

// â”€â”€â”€ ML daily ops worker processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processMlDailyOps(_job: Job): Promise<{ success: boolean }> {
  await runPython('fii_dii_fetcher.py', [], 90_000).catch(() => {});
  await runPython('finbert_scorer.py', ['--days', '1'], 180_000).catch(() => {});

  await pythonApi.resolveOutcomes(5).catch(e => console.warn('[API] resolve-outcomes(5):', (e as Error).message));
  await pythonApi.resolveOutcomes(15).catch(e => console.warn('[API] resolve-outcomes(15):', (e as Error).message));

  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);

  await pythonApi.scorePending().catch(e => console.warn('[API] score-pending:', (e as Error).message));

  await runPython('reward_engine.py');
  await runPython('rl_agent.py', ['--update']);
  return { success: true };
}

// â”€â”€â”€ Research report processor functions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ DL Python runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function processDLPython(script: string, args: string[] = [], timeoutMs = 6 * 60 * 60_000): Promise<{ success: boolean }> {
  await runPython(script, args, timeoutMs);
  return { success: true };
}

async function processMlWeeklyRetrain(_job: Job): Promise<{ success: boolean }> {
  await runPython('outcome_resolver.py', ['--horizon', '5']);
  await runPython('outcome_resolver.py', ['--horizon', '15']);
  await runPython('ml_ensemble.py', ['--train', '--score'], 60 * 60_000);
  await runPython('strategy_optimizer.py', [], 30 * 60_000).catch(() => {});
  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);
  return { success: true };
}

async function processScreenerPerf(_job: Job): Promise<void> {
  await runPython('screener_performance.py', [], 15 * 60_000);
  try {
    const { classifyAllScreeners } = await import('./screenerClassifier');
    await classifyAllScreeners();
  } catch (e: unknown) {
    console.error('[QUEUE] screener classification failed:', (e as Error).message);
  }
}

// â”€â”€â”€ Initialise queues & workers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    try { probe.disconnect(true); } catch { /* ignore */ }
    console.warn = _origWarn;
    console.warn('[QUEUE] Redis unavailable, disabling BullMQ:', err.message);
    return false;
  }

  // 2. Initialise resilient queues & workers
  const connection = makeConnection(false);
  try {
    // â”€â”€ Stock refresh queue (PHASE 1 FIX: Resume daily OHLCV sync) â”€â”€â”€â”€â”€â”€â”€â”€
    stockRefreshQueue = new Queue(QUEUE_STOCK_REFRESH, { connection });

    // Remove any stale repeatable job
    const repeatables = await stockRefreshQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await stockRefreshQueue.removeRepeatableByKey(r.key);
    }
    
    // Daily sync after market close (4 PM IST = 10:30 AM UTC)
    // This ensures OHLCV data is persisted for backtesting
    await stockRefreshQueue.add(
      'refresh-all-daily',
      {},
      {
        repeat: { pattern: '30 10 * * 1-5' },  // 10:30 AM UTC = 4:00 PM IST, weekdays only
        jobId: 'refresh-all-daily-repeatable',
        removeOnComplete: { age: 86400 },   // Keep completed jobs for 1 day
        removeOnFail: { age: 604800 },      // Keep failed jobs for 7 days (for debugging)
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
    });
    stockWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] stock-refresh failed:`, err.message);
    });
    stockWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] stock-refresh error:', err.message);
    });

    // Trigger an immediate first refresh (Paused)
    // await stockRefreshQueue.add('refresh-all', {}, { removeOnComplete: 1 });

    // â”€â”€ AI signals queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    });

    signalWorker.on('failed', (job, err) => {
      console.warn(`[QUEUE] ai-signals job ${job?.data?.symbol} failed:`, err.message);
    });

    signalWorker.on('stalled', (jobId) => {
      console.warn(`[QUEUE] ai-signals job ${jobId} stalled! This usually means the process crashed or the lock expired.`);
    });

    console.log('[QUEUE] BullMQ initialised (stock-refresh + ai-signals)');

    // â”€â”€ Stock scoring queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    stockScoringQueue = new Queue(QUEUE_STOCK_SCORING, { connection });

    // Repeat every 24 hours
    const scoringRepeatables = await stockScoringQueue.getRepeatableJobs();
    for (const r of scoringRepeatables) {
      await stockScoringQueue.removeRepeatableByKey(r.key);
    }
    await stockScoringQueue.add(
      'score-all',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 }, // 24 hours
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
    });
    scoringWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] stock-scoring failed:`, err.message);
    });

    // â”€â”€ MC screener sync queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    mcScreenerSyncQueue = new Queue(QUEUE_MC_SCREENER_SYNC, { connection });

    // Repeat every 12 hours
    const mcRepeatables = await mcScreenerSyncQueue.getRepeatableJobs();
    for (const r of mcRepeatables) {
      await mcScreenerSyncQueue.removeRepeatableByKey(r.key);
    }
    await mcScreenerSyncQueue.add(
      'mc-sync',
      {},
      {
        repeat: { every: 12 * 60 * 60 * 1000 }, // 12 hours
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
      },
    );

    mcScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] mc-screener-sync completed`);
    });
    mcScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] mc-screener-sync failed:`, err.message);
    });

    // â”€â”€ ETNow screener sync queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    etnowScreenerSyncQueue = new Queue(QUEUE_ETNOW_SCREENER_SYNC, { connection });

    // Repeat every 12 hours
    const etnowRepeatables = await etnowScreenerSyncQueue.getRepeatableJobs();
    for (const r of etnowRepeatables) {
      await etnowScreenerSyncQueue.removeRepeatableByKey(r.key);
    }
    await etnowScreenerSyncQueue.add(
      'etnow-sync',
      {},
      {
        repeat: { every: 12 * 60 * 60 * 1000 }, // 12 hours
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
        lockDuration: 60000,
      },
    );

    etnowScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] etnow-screener-sync completed`);
    });
    etnowScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] etnow-screener-sync failed:`, err.message);
    });

    // â”€â”€ NSE sync queue (PHASE 2: Weekly master data update) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    nseScreenerSyncQueue = new Queue(QUEUE_NSE_SYNC, { connection });

    // Remove any stale repeatable job
    const nseRepeatables = await nseScreenerSyncQueue.getRepeatableJobs();
    for (const r of nseRepeatables) {
      await nseScreenerSyncQueue.removeRepeatableByKey(r.key);
    }

    // Repeat weekly on Sunday at 2 AM UTC (7:30 AM IST) for low load time
    await nseScreenerSyncQueue.add(
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
    });
    nseScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] nse-sync failed:`, err.message);
    });

    // â”€â”€ Fundamentals sync queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    fundamentalsSyncQueue = new Queue(QUEUE_FUNDAMENTALS_SYNC, { connection });

    // Weekly repeatable job (Phase 1 + Phase 2 every 7 days)
    const fundRepeatables = await fundamentalsSyncQueue.getRepeatableJobs();
    for (const r of fundRepeatables) {
      await fundamentalsSyncQueue.removeRepeatableByKey(r.key);
    }
    await fundamentalsSyncQueue.add(
      'sync-fundamentals-weekly',
      { phase2Only: false },
      {
        repeat: { every: 7 * 24 * 60 * 60 * 1000 }, // 7 days
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
        lockDuration: 30 * 60 * 1000,  // 30 min â€” Phase 2 deep sync is slow
        lockRenewTime: 5 * 60 * 1000,
      },
    );

    fundamentalsSyncWorker.on('completed', (_job) => {
      console.log('[QUEUE] fundamentals-sync completed');
    });
    fundamentalsSyncWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] fundamentals-sync failed:', err.message);
    });

    // â”€â”€ Quant scoring queue (daily) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    quantScoringQueue = new Queue(QUEUE_QUANT_SCORING, { connection });

    const quantRepeatables = await quantScoringQueue.getRepeatableJobs();
    for (const r of quantRepeatables) {
      await quantScoringQueue.removeRepeatableByKey(r.key);
    }
    await quantScoringQueue.add(
      'quant-score-daily',
      {},
      {
        repeat: { every: 24 * 60 * 60 * 1000 }, // every 24 hours
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
        lockDuration: 10 * 60 * 1000, // 10 min â€” pure in-process computation
        lockRenewTime: 2 * 60 * 1000,
      },
    );

    quantScoringWorker.on('completed', (_job) => {
      console.log('[QUEUE] quant-scoring completed');
    });
    quantScoringWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] quant-scoring failed:', err.message);
    });

    // â”€â”€ Technical signals queue (every 30 minutes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    technicalSignalsQueue = new Queue(QUEUE_TECHNICAL_SIGNALS, { connection });

    const tsRepeatables = await technicalSignalsQueue.getRepeatableJobs();
    for (const r of tsRepeatables) {
      await technicalSignalsQueue.removeRepeatableByKey(r.key);
    }
    await technicalSignalsQueue.add(
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
    });
    technicalSignalsWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] technical-signals failed:', err.message);
    });
    technicalSignalsWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] technical-signals error:', err.message);
    });

    // â”€â”€ Signal outcomes queue (daily, resolves 5D + 15D win rates) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    signalOutcomesQueue = new Queue(QUEUE_SIGNAL_OUTCOMES, { connection });

    const outRepeatables = await signalOutcomesQueue.getRepeatableJobs();
    for (const r of outRepeatables) {
      await signalOutcomesQueue.removeRepeatableByKey(r.key);
    }
    await signalOutcomesQueue.add(
      'signal-outcomes-daily',
      {},
      {
        repeat: { pattern: '30 3 * * 1-5' }, // 9:00 AM IST, Monâ€“Fri (30 min after signals)
        jobId: 'signal-outcomes-daily',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    signalOutcomesWorker = new Worker(
      QUEUE_SIGNAL_OUTCOMES,
      async (_job: Job) => {
        const { computeSignalOutcomes } = await import('./signalOutcomesService');
        computeSignalOutcomes(5);
        computeSignalOutcomes(15);
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
    });
    signalOutcomesWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] signal-outcomes failed:', err.message);
    });

    // â”€â”€ News sentiment queue (every 30 seconds) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    newsSentimentQueue = new Queue(QUEUE_NEWS_SENTIMENT, { connection });

    const newsRepeatables = await newsSentimentQueue.getRepeatableJobs();
    for (const r of newsRepeatables) {
      await newsSentimentQueue.removeRepeatableByKey(r.key);
    }
    await newsSentimentQueue.add(
      'news-sentiment-refresh',
      {},
      {
        repeat: { every: 5 * 60 * 1000 }, // every 5 minutes
        jobId: 'news-sentiment-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    newsSentimentWorker = new Worker(
      QUEUE_NEWS_SENTIMENT,
      async (_job: Job) => {
        const { runNewsSentimentCycle } = await import('./newsSentimentService');
        await runNewsSentimentCycle();
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
    });
    newsSentimentWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] news-sentiment failed:', err.message);
    });
    newsSentimentWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] news-sentiment error:', err.message);
    });

    // â”€â”€ Trendlyne intraday queue (every 5 min) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    trendlyneIntradayQueue = new Queue(QUEUE_TRENDLYNE_INTRADAY, { connection });

    const tlRepeatables = await trendlyneIntradayQueue.getRepeatableJobs();
    for (const r of tlRepeatables) {
      await trendlyneIntradayQueue.removeRepeatableByKey(r.key);
    }
    await trendlyneIntradayQueue.add(
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
        console.log('[QUEUE] Starting scheduled 15-min intraday screener sync & scan...');
        const { syncAllScreenerStocksToDB, runIntradayScreenerScan } = await import('./trendlyneScreener');
        const { syncMoneyControlScreeners } = await import('./moneycontrolScreener');
        const { syncETnowScreeners } = await import('./etnowScreenerSync');
        
        try {
          await syncAllScreenerStocksToDB('intraday');
        } catch (e: any) {
          console.error('[QUEUE] Trendlyne intraday sync failed:', e.message);
        }
        try {
          await syncMoneyControlScreeners('intraday');
        } catch (e: any) {
          console.error('[QUEUE] MoneyControl intraday sync failed:', e.message);
        }
        try {
          await syncETnowScreeners('intraday');
        } catch (e: any) {
          console.error('[QUEUE] ETNow intraday sync failed:', e.message);
        }

        await runIntradayScreenerScan();
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 8 * 60 * 1000, // 8 minutes (sufficient for 15-min sync and scan)
      },
    );

    trendlyneIntradayWorker.on('completed', (_job) => {
      console.log('[QUEUE] trendlyne-intraday completed');
    });
    trendlyneIntradayWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-intraday failed:', err.message);
    });
    trendlyneIntradayWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] trendlyne-intraday error:', err.message);
    });

    // â”€â”€ Outcome resolver queue (daily at 9:30 AM IST = 04:00 UTC, weekdays) â”€â”€
    outcomeResolverQueue = new Queue(QUEUE_OUTCOME_RESOLVER, { connection });

    const orRepeatables = await outcomeResolverQueue.getRepeatableJobs();
    for (const r of orRepeatables) {
      await outcomeResolverQueue.removeRepeatableByKey(r.key);
    }
    await outcomeResolverQueue.add(
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
    });
    outcomeResolverWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] outcome-resolver failed:', err.message);
    });

    // â”€â”€ ML daily ops queue (5:00 PM IST = 11:30 UTC, weekdays) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    mlDailyOpsQueue = new Queue(QUEUE_ML_DAILY_OPS, { connection });

    const mlRepeatables = await mlDailyOpsQueue.getRepeatableJobs();
    for (const r of mlRepeatables) {
      await mlDailyOpsQueue.removeRepeatableByKey(r.key);
    }
    await mlDailyOpsQueue.add(
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
        lockDuration: 15 * 60 * 1000,
        lockRenewTime: 3 * 60 * 1000,
      },
    );

    mlDailyOpsWorker.on('completed', (_job) => {
      console.log('[QUEUE] ml-daily-ops completed');
    });
    mlDailyOpsWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] ml-daily-ops failed:', err.message);
    });

    // â”€â”€ ML weekly retrain + optimize (Sunday 6 PM IST = 12:30 UTC) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    mlWeeklyRetrainQueue = new Queue(QUEUE_ML_WEEKLY_RETRAIN, { connection });
    const mlWkRep = await mlWeeklyRetrainQueue.getRepeatableJobs();
    for (const r of mlWkRep) await mlWeeklyRetrainQueue.removeRepeatableByKey(r.key);
    await mlWeeklyRetrainQueue.add('ml-weekly-retrain', {}, {
      repeat: { pattern: '30 12 * * 0' },
      jobId: 'ml-weekly-retrain',
      removeOnComplete: 2, removeOnFail: 3,
    });
    mlWeeklyRetrainWorker = new Worker(QUEUE_ML_WEEKLY_RETRAIN, processMlWeeklyRetrain, { connection, concurrency: 1, lockDuration: 90 * 60 * 1000, lockRenewTime: 10 * 60 * 1000 });
    mlWeeklyRetrainWorker.on('completed', () => console.log('[QUEUE] ml-weekly-retrain done'));
    mlWeeklyRetrainWorker.on('failed', (_, err) => console.error('[QUEUE] ml-weekly-retrain failed:', err.message));

    // â”€â”€ Research report queues â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    researchPremarketQueue = new Queue(QUEUE_RESEARCH_PREMARKET, { connection });
    const premarketRep = await researchPremarketQueue.getRepeatableJobs();
    for (const r of premarketRep) await researchPremarketQueue.removeRepeatableByKey(r.key);
    await researchPremarketQueue.add('research-premarket-daily', {}, {
      repeat: { pattern: '0 3 * * 1-5' },
      jobId: 'research-premarket-repeatable',
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
    researchPremarketWorker = new Worker(QUEUE_RESEARCH_PREMARKET, processResearchPremarket,
      { connection, concurrency: 1, lockDuration: 15 * 60 * 1000 });
    researchPremarketWorker.on('completed', () => console.log('[QUEUE] research-premarket done'));
    researchPremarketWorker.on('failed', (_, err) => console.error('[QUEUE] research-premarket failed:', err.message));

    researchPostcloseQueue = new Queue(QUEUE_RESEARCH_POSTCLOSE, { connection });
    const postcloseRep = await researchPostcloseQueue.getRepeatableJobs();
    for (const r of postcloseRep) await researchPostcloseQueue.removeRepeatableByKey(r.key);
    await researchPostcloseQueue.add('research-postclose-daily', {}, {
      repeat: { pattern: '45 10 * * 1-5' },
      jobId: 'research-postclose-repeatable',
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 604800 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
    researchPostcloseWorker = new Worker(QUEUE_RESEARCH_POSTCLOSE, processResearchPostclose,
      { connection, concurrency: 1, lockDuration: 15 * 60 * 1000 });
    researchPostcloseWorker.on('completed', () => console.log('[QUEUE] research-postclose done'));
    researchPostcloseWorker.on('failed', (_, err) => console.error('[QUEUE] research-postclose failed:', err.message));

    // â”€â”€ DL Macro Fetch (8:00 AM IST = 2:30 AM UTC, weekdays) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    dlMacroFetchQueue = new Queue(QUEUE_DL_MACRO_FETCH, { connection });
    const dlMacroRep = await dlMacroFetchQueue.getRepeatableJobs();
    for (const r of dlMacroRep) await dlMacroFetchQueue.removeRepeatableByKey(r.key);
    await dlMacroFetchQueue.add('dl-macro-daily', {}, {
      repeat: { pattern: '30 2 * * 1-5' },
      jobId: 'dl-macro-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlMacroFetchWorker = new Worker(QUEUE_DL_MACRO_FETCH,
      async () => processDLPython('global_macro_fetcher.py'),
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 });
    dlMacroFetchWorker.on('completed', () => console.log('[QUEUE] dl-macro-fetch done'));
    dlMacroFetchWorker.on('failed', (_, err) => console.error('[QUEUE] dl-macro-fetch failed:', err.message));

    // â”€â”€ DL Feature Refresh (3:30 PM IST = 10:00 AM UTC, weekdays) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    dlFeatureRefreshQueue = new Queue(QUEUE_DL_FEATURE_REFRESH, { connection });
    const dlFeatRep = await dlFeatureRefreshQueue.getRepeatableJobs();
    for (const r of dlFeatRep) await dlFeatureRefreshQueue.removeRepeatableByKey(r.key);
    await dlFeatureRefreshQueue.add('dl-feature-daily', {}, {
      repeat: { pattern: '0 10 * * 1-5' },
      jobId: 'dl-feature-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlFeatureRefreshWorker = new Worker(QUEUE_DL_FEATURE_REFRESH,
      async () => processDLPython('feature_engineering.py'),
      { connection, concurrency: 1, lockDuration: 60 * 60 * 1000, lockRenewTime: 10 * 60 * 1000 });
    dlFeatureRefreshWorker.on('completed', () => console.log('[QUEUE] dl-feature-refresh done'));
    dlFeatureRefreshWorker.on('failed', (_, err) => console.error('[QUEUE] dl-feature-refresh failed:', err.message));

    // â”€â”€ DL Inference (4:30 PM IST = 11:00 AM UTC, weekdays) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    dlInferenceQueue = new Queue(QUEUE_DL_INFERENCE, { connection });
    const dlInfRep = await dlInferenceQueue.getRepeatableJobs();
    for (const r of dlInfRep) await dlInferenceQueue.removeRepeatableByKey(r.key);
    await dlInferenceQueue.add('dl-infer-daily', {}, {
      repeat: { pattern: '0 11 * * 1-5' },
      jobId: 'dl-infer-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlInferenceWorker = new Worker(QUEUE_DL_INFERENCE,
      async () => processDLPython('dl_engine.py', ['--mode', 'infer']),
      { connection, concurrency: 1, lockDuration: 30 * 60 * 1000, lockRenewTime: 5 * 60 * 1000 });
    dlInferenceWorker.on('completed', () => console.log('[QUEUE] dl-inference done'));
    dlInferenceWorker.on('failed', (_, err) => console.error('[QUEUE] dl-inference failed:', err.message));

    // â”€â”€ DL Regime Update (4:45 PM IST = 11:15 AM UTC, weekdays) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    dlRegimeUpdateQueue = new Queue(QUEUE_DL_REGIME_UPDATE, { connection });
    const dlRegRep = await dlRegimeUpdateQueue.getRepeatableJobs();
    for (const r of dlRegRep) await dlRegimeUpdateQueue.removeRepeatableByKey(r.key);
    await dlRegimeUpdateQueue.add('dl-regime-daily', {}, {
      repeat: { pattern: '15 11 * * 1-5' },
      jobId: 'dl-regime-daily',
      removeOnComplete: 3, removeOnFail: 3,
    });
    dlRegimeUpdateWorker = new Worker(QUEUE_DL_REGIME_UPDATE,
      async () => processDLPython('regime_detector.py', ['--mode', 'update']),
      { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 });
    dlRegimeUpdateWorker.on('completed', () => console.log('[QUEUE] dl-regime-update done'));
    dlRegimeUpdateWorker.on('failed', (_, err) => console.error('[QUEUE] dl-regime-update failed:', err.message));

    // â”€â”€ DL Weekly Retrain (Sunday 11:00 PM IST = Sun 17:30 UTC) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    dlRetrainWeeklyQueue = new Queue(QUEUE_DL_RETRAIN_WEEKLY, { connection });
    const dlWkRep = await dlRetrainWeeklyQueue.getRepeatableJobs();
    for (const r of dlWkRep) await dlRetrainWeeklyQueue.removeRepeatableByKey(r.key);
    await dlRetrainWeeklyQueue.add('dl-retrain-weekly', {}, {
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
    dlRetrainWeeklyWorker.on('completed', () => console.log('[QUEUE] dl-retrain-weekly done'));
    dlRetrainWeeklyWorker.on('failed', (_, err) => console.error('[QUEUE] dl-retrain-weekly failed:', err.message));

    // â”€â”€ DL Emergency Retrain (on-demand, triggered by drift detector) â”€â”€â”€â”€â”€â”€â”€â”€
    dlRetrainEmergencyQueue = new Queue(QUEUE_DL_RETRAIN_EMERGENCY, { connection });
    dlRetrainEmergencyWorker = new Worker(QUEUE_DL_RETRAIN_EMERGENCY,
      async () => processDLPython('dl_trainer.py', ['--trigger', 'drift']),
      { connection, concurrency: 1, lockDuration: 6 * 60 * 60 * 1000, lockRenewTime: 30 * 60 * 1000 });
    dlRetrainEmergencyWorker.on('completed', () => console.log('[QUEUE] dl-retrain-emergency done'));
    dlRetrainEmergencyWorker.on('failed', (_, err) => console.error('[QUEUE] dl-retrain-emergency failed:', err.message));

    // â”€â”€ OHLCV Backfill â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Worker handles both one-time full backfill and recurring weekly gap-fill
    ohlcvBackfillQueue = new Queue(QUEUE_OHLCV_BACKFILL, { connection });
    ohlcvBackfillWorker = new Worker(QUEUE_OHLCV_BACKFILL,
      async (job: Job) => {
        const mode = (job.data?.mode as string) || 'gap-fill';
        const lookback = (job.data?.lookback as number) || 30;
        return processDLPython('backfill_ohlcv.py', ['--mode', mode, '--lookback', String(lookback)]);
      },
      { connection, concurrency: 1, lockDuration: 3 * 60 * 60 * 1000, lockRenewTime: 15 * 60 * 1000 });
    ohlcvBackfillWorker.on('completed', (job) => console.log(`[QUEUE] ohlcv-backfill (${job.data?.mode}) done`));
    ohlcvBackfillWorker.on('failed', (_, err) => console.error('[QUEUE] ohlcv-backfill failed:', err.message));

    // Weekly gap-fill: Saturday 2:00 AM IST = Friday 20:30 UTC
    const ohlcvRep = await ohlcvBackfillQueue.getRepeatableJobs();
    for (const r of ohlcvRep) await ohlcvBackfillQueue.removeRepeatableByKey(r.key);
    await ohlcvBackfillQueue.add('ohlcv-gap-fill-weekly', { mode: 'gap-fill', lookback: 30 }, {
      repeat: { pattern: '30 20 * * 5' },
      jobId: 'ohlcv-gap-fill-weekly',
      removeOnComplete: 2, removeOnFail: 3,
    });

    // Startup check: if stock_ohlcv has fewer than 1000 rows trigger full backfill once
    const ohlcvCount = (db.prepare('SELECT COUNT(*) as c FROM stock_ohlcv').get() as any)?.c ?? 0;
    if (ohlcvCount < 1000) {
      console.log(`[QUEUE] stock_ohlcv sparse (${ohlcvCount} rows) â€” queuing full backfill`);
      await ohlcvBackfillQueue.add('ohlcv-full-backfill-startup', { mode: 'full' }, {
        jobId: 'ohlcv-full-backfill-startup',
        removeOnComplete: 1, removeOnFail: 3,
      });
    } else {
      // Always ensure NIFTY50 index history is present
      const niftyCount = (db.prepare("SELECT COUNT(*) as c FROM stock_ohlcv WHERE symbol='NIFTY50'").get() as any)?.c ?? 0;
      if (niftyCount === 0) {
        console.log('[QUEUE] NIFTY50 missing from stock_ohlcv â€” queuing index backfill');
        await ohlcvBackfillQueue.add('ohlcv-indices-startup', { mode: 'indices' }, {
          jobId: 'ohlcv-indices-startup',
          removeOnComplete: 1, removeOnFail: 3,
        });
      }
    }

    // â”€â”€ Confluence Compute Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    confluenceComputeQueue = new Queue(QUEUE_CONFLUENCE_COMPUTE, { connection: makeConnection() });
    confluenceComputeWorker = new Worker(
      QUEUE_CONFLUENCE_COMPUTE,
      processConfluenceCompute,
      { connection: makeConnection(), concurrency: 1 }
    );
    confluenceComputeWorker.on('failed', (_job, err) =>
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} job failed:`, err.message)
    );
    confluenceComputeWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} error:`, err.message);
    });
    await confluenceComputeQueue.add(
      'confluence-compute',
      {},
      { repeat: { every: 30 * 60 * 1000 }, removeOnComplete: 3, removeOnFail: 3 }
    );

    // â”€â”€ Confluence Outcomes Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    confluenceOutcomesQueue = new Queue(QUEUE_CONFLUENCE_OUTCOMES, { connection: makeConnection() });
    confluenceOutcomesWorker = new Worker(
      QUEUE_CONFLUENCE_OUTCOMES,
      processConfluenceOutcomes,
      { connection: makeConnection(), concurrency: 1 }
    );
    confluenceOutcomesWorker.on('failed', (job, err) =>
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_OUTCOMES} job failed:`, err.message)
    );
    await confluenceOutcomesQueue.add(
      'confluence-outcomes-daily',
      {},
      { repeat: { every: 24 * 60 * 60 * 1000 }, removeOnComplete: 3, removeOnFail: 3 }
    );
    console.log('[QUEUE] confluence-compute (every 30 min) + confluence-outcomes (daily) registered');

    // ── Screener performance queue (daily 6 PM IST = 12:30 UTC, weekdays) ──────
    screenerPerfQueue = new Queue(QUEUE_SCREENER_PERFORMANCE, { connection });

    const screenerPerfRepeatables = await screenerPerfQueue.getRepeatableJobs();
    for (const r of screenerPerfRepeatables) {
      await screenerPerfQueue.removeRepeatableByKey(r.key);
    }
    await screenerPerfQueue.add(
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

    screenerPerfWorker.on('completed', () => console.log('[QUEUE] screener-performance completed'));
    screenerPerfWorker.on('failed', (_job, err) => console.error('[QUEUE] screener-performance failed:', err.message));
    screenerPerfWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error('[QUEUE] screener-performance error:', err.message);
    });

    console.log('[QUEUE] screener-performance (daily 6PM IST weekdays) registered');

    console.warn = _origWarn;
    console.log('[QUEUE] BullMQ initialised (stock-refresh + ai-signals)');
    return true;
  } catch (err: any) {
    console.warn = _origWarn;
    console.warn('[QUEUE] BullMQ unavailable (Redis down?) â€” falling back to setInterval:', err.message);
    stockRefreshQueue = null;
    aiSignalsQueue    = null;
    stockScoringQueue = null;
    trendlyneIntradayQueue = null;
    return false;
  }
}

// â”€â”€â”€ Graceful shutdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  ]);
}

// â”€â”€â”€ Enqueue AI-signals for an array of stocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Queue stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

