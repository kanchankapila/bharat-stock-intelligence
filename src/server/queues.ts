/**
 * BullMQ queues & workers
 *
 * Two queues:
 *   stock-refresh  – repeatable job every 5 min, refreshes all NSE live prices
 *   ai-signals     – per-stock AI analysis jobs, concurrency 3
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

// ─── Redis connection shared across all BullMQ objects ───────────────────────

function makeConnection(isProbe = false): ConnectionOptions {
  const base = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    connectTimeout: 5000,
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
      const delay = Math.min(times * 100, 3000);
      return delay;
    },
  };
}

// ─── Queue names ─────────────────────────────────────────────────────────────

export const QUEUE_STOCK_REFRESH        = 'stock-refresh';
export const QUEUE_AI_SIGNALS           = 'ai-signals';
export const QUEUE_STOCK_SCORING        = 'stock-scoring';
export const QUEUE_MC_SCREENER_SYNC     = 'mc-screener-sync';
export const QUEUE_FUNDAMENTALS_SYNC    = 'fundamentals-sync';
export const QUEUE_QUANT_SCORING        = 'quant-scoring';
export const QUEUE_TECHNICAL_SIGNALS    = 'technical-signals';
export const QUEUE_SIGNAL_OUTCOMES      = 'signal-outcomes';
export const QUEUE_NEWS_SENTIMENT       = 'news-sentiment';
export const QUEUE_TRENDLYNE_INTRADAY   = 'trendlyne-intraday';

const BULK_CACHE_KEY      = 'live-stocks-bulk';
const BULK_TTL_SECONDS    = 5 * 60;
const REFRESH_REPEAT_MS   = BULK_TTL_SECONDS * 1000;

// ─── Module-level handles (null when Redis unavailable) ───────────────────────

export let stockRefreshQueue:      Queue | null = null;
export let aiSignalsQueue:         Queue | null = null;
export let stockScoringQueue:      Queue | null = null;
export let mcScreenerSyncQueue:    Queue | null = null;
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
let fundamentalsSyncWorker:   Worker | null = null;
let quantScoringWorker:       Worker | null = null;
let technicalSignalsWorker:   Worker | null = null;
let signalOutcomesWorker:     Worker | null = null;
let newsSentimentWorker:      Worker | null = null;
let trendlyneIntradayWorker:  Worker | null = null;

// Shared in-process mirror populated by the stock-refresh worker
// (same reference as the one exported from liveStockData via the cache layer)
let bulkMirror: Map<string, any> = new Map();

// ─── Stock-refresh worker processor ──────────────────────────────────────────

async function processStockRefresh(_job: Job): Promise<{ count: number }> {
  const freshData = await fetchAllLiveStocks();
  bulkMirror = new Map(freshData.map((s: any) => [s.symbol, s]));
  await cacheSet(BULK_CACHE_KEY, freshData, BULK_TTL_SECONDS);
  return { count: freshData.length };
}

// ─── AI-signals worker processor ─────────────────────────────────────────────

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

// ─── Stock-scoring worker processor ──────────────────────────────────────────

async function processStockScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled stock scoring...');
  const result = await syncAndScore();
  return { success: result.success };
}

// ─── MC screener sync worker processor ───────────────────────────────────────

async function processMcScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled MoneyControl screener sync...');
  const { syncMoneyControlScreeners } = await import('./moneycontrolScreener');
  await syncMoneyControlScreeners();
  return { success: true };
}

// ─── Fundamentals-sync worker processor ──────────────────────────────────────

async function processFundamentalsSync(job: Job): Promise<{ success: boolean }> {
  const phase2Only = job.data?.phase2Only === true;
  console.log(`[QUEUE] Starting fundamentals sync (phase2Only=${phase2Only})...`);
  const { runFullFundamentalsSync } = await import('./fundamentalsSyncService');
  await runFullFundamentalsSync(phase2Only);
  return { success: true };
}

// ─── Quant-scoring worker processor ──────────────────────────────────────────

async function processQuantScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting quant strategy scoring...');
  const { runQuantScoring } = await import('./quantScoringService');
  await runQuantScoring();
  return { success: true };
}

// ─── Initialise queues & workers ─────────────────────────────────────────────

export async function initQueues(): Promise<boolean> {
  // 1. Fail-fast probe to see if Redis is even there
  const probeConnection = makeConnection(true);
  const probe = new Redis({ ...(probeConnection as any), lazyConnect: true });
  
  try {
    await probe.connect();
    await probe.quit();
    console.log('[QUEUE] Redis connection probe successful');
  } catch (err: any) {
    console.warn('[QUEUE] Redis unavailable, disabling BullMQ:', err.message);
    return false;
  }

  // 2. Initialise resilient queues & workers
  const connection = makeConnection(false);
  try {
    // ── Stock refresh queue (PAUSED for visibility-based fetching) ───────────
    stockRefreshQueue = new Queue(QUEUE_STOCK_REFRESH, { connection });

    // Remove any stale repeatable job
    const repeatables = await stockRefreshQueue.getRepeatableJobs();
    for (const r of repeatables) {
      await stockRefreshQueue.removeRepeatableByKey(r.key);
    }
    
    // Continuous background fetching paused to prevent API limits
    /*
    await stockRefreshQueue.add(
      'refresh-all',
      {},
      {
        repeat: { every: REFRESH_REPEAT_MS },
        jobId: 'refresh-all-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );
    */

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

    // Trigger an immediate first refresh (Paused)
    // await stockRefreshQueue.add('refresh-all', {}, { removeOnComplete: 1 });

    // ── AI signals queue ─────────────────────────────────────────────────────
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

    // ── Stock scoring queue ──────────────────────────────────────────────────
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

    // ── MC screener sync queue ───────────────────────────────────────────────
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

    // ── Fundamentals sync queue ──────────────────────────────────────────────
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
        lockDuration: 30 * 60 * 1000,  // 30 min — Phase 2 deep sync is slow
        lockRenewTime: 5 * 60 * 1000,
      },
    );

    fundamentalsSyncWorker.on('completed', (_job) => {
      console.log('[QUEUE] fundamentals-sync completed');
    });
    fundamentalsSyncWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] fundamentals-sync failed:', err.message);
    });

    // ── Quant scoring queue (daily) ──────────────────────────────────────────
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
        lockDuration: 10 * 60 * 1000, // 10 min — pure in-process computation
        lockRenewTime: 2 * 60 * 1000,
      },
    );

    quantScoringWorker.on('completed', (_job) => {
      console.log('[QUEUE] quant-scoring completed');
    });
    quantScoringWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] quant-scoring failed:', err.message);
    });

    // ── Technical signals queue (daily at 8:30 AM IST = 03:00 UTC) ──────────
    technicalSignalsQueue = new Queue(QUEUE_TECHNICAL_SIGNALS, { connection });

    const tsRepeatables = await technicalSignalsQueue.getRepeatableJobs();
    for (const r of tsRepeatables) {
      await technicalSignalsQueue.removeRepeatableByKey(r.key);
    }
    await technicalSignalsQueue.add(
      'technical-signals-daily',
      {},
      {
        repeat: { pattern: '0 3 * * 1-5' }, // 8:30 AM IST, Mon–Fri
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

    // ── Signal outcomes queue (daily, resolves 5D + 15D win rates) ───────────
    signalOutcomesQueue = new Queue(QUEUE_SIGNAL_OUTCOMES, { connection });

    const outRepeatables = await signalOutcomesQueue.getRepeatableJobs();
    for (const r of outRepeatables) {
      await signalOutcomesQueue.removeRepeatableByKey(r.key);
    }
    await signalOutcomesQueue.add(
      'signal-outcomes-daily',
      {},
      {
        repeat: { pattern: '30 3 * * 1-5' }, // 9:00 AM IST, Mon–Fri (30 min after signals)
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

    // ── News sentiment queue (every 15 min) ──────────────────────────────────
    newsSentimentQueue = new Queue(QUEUE_NEWS_SENTIMENT, { connection });

    const newsRepeatables = await newsSentimentQueue.getRepeatableJobs();
    for (const r of newsRepeatables) {
      await newsSentimentQueue.removeRepeatableByKey(r.key);
    }
    await newsSentimentQueue.add(
      'news-sentiment-refresh',
      {},
      {
        repeat: { every: 1 * 60 * 1000 }, // every 1 minute
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

    // ── Trendlyne intraday queue (every 5 min) ───────────────────────────────
    trendlyneIntradayQueue = new Queue(QUEUE_TRENDLYNE_INTRADAY, { connection });

    const tlRepeatables = await trendlyneIntradayQueue.getRepeatableJobs();
    for (const r of tlRepeatables) {
      await trendlyneIntradayQueue.removeRepeatableByKey(r.key);
    }
    await trendlyneIntradayQueue.add(
      'trendlyne-intraday-scan',
      {},
      {
        repeat: { every: 5 * 60 * 1000 }, // 5 minutes
        jobId: 'trendlyne-intraday-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );

    trendlyneIntradayWorker = new Worker(
      QUEUE_TRENDLYNE_INTRADAY,
      async (_job: Job) => {
        const { runIntradayScreenerScan } = await import('./trendlyneScreener');
        await runIntradayScreenerScan();
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 4 * 60 * 1000, // 4 minutes
      },
    );

    trendlyneIntradayWorker.on('completed', (_job) => {
      console.log('[QUEUE] trendlyne-intraday completed');
    });
    trendlyneIntradayWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-intraday failed:', err.message);
    });

    return true;
  } catch (err: any) {
    console.warn('[QUEUE] BullMQ unavailable (Redis down?) — falling back to setInterval:', err.message);
    stockRefreshQueue = null;
    aiSignalsQueue    = null;
    stockScoringQueue = null;
    trendlyneIntradayQueue = null;
    return false;
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

export async function shutdownQueues(): Promise<void> {
  await Promise.allSettled([
    stockWorker?.close(),
    signalWorker?.close(),
    scoringWorker?.close(),
    mcScreenerSyncWorker?.close(),
    fundamentalsSyncWorker?.close(),
    quantScoringWorker?.close(),
    stockRefreshQueue?.close(),
    aiSignalsQueue?.close(),
    stockScoringQueue?.close(),
    mcScreenerSyncQueue?.close(),
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
  ]);
}

// ─── Enqueue AI-signals for an array of stocks ───────────────────────────────

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

// ─── Queue stats ──────────────────────────────────────────────────────────────

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
