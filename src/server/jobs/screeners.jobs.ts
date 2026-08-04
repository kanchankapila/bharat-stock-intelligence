/**
 * Screener-sync + scoring jobs, migrated out of queues.ts's initQueues() as the first slice
 * of the queues.ts decomposition (see CLAUDE.md architecture review, Phase 3). These six were
 * chosen because their registration was already byte-for-byte identical in shape (repeatable
 * cron schedule, standard concurrency/lockDuration worker options, standard
 * completed/failed -> recordHeartbeat event handlers, no extras) — see registerJob.ts's
 * registerRepeatableJob() for the shared shape this now goes through.
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (stockScoringQueue, mcScreenerSyncQueue, ...) — several other files (monitor.router.ts's
 * queue-health dashboard, fundamentalsSyncService.ts, quantScoringService.ts,
 * scoring.router.ts, fundamentals.router.ts, jobsMonitor.test.ts's mocks) import those exact
 * bindings directly, so this module only owns the *registration logic*; queues.ts's
 * initQueues() still assigns the result into its own module-level `let`s.
 */
import { Job } from 'bullmq';
import { syncAndScore } from '../scoringService';
import { registerRepeatableJob } from './registerJob';
import { runPython } from '../pythonRunner';

export const QUEUE_STOCK_SCORING       = 'stock-scoring';
export const QUEUE_MC_SCREENER_SYNC    = 'mc-screener-sync';
export const QUEUE_ETNOW_SCREENER_SYNC = 'etnow-screener-sync';
export const QUEUE_ET_MARKETSTATS_SYNC = 'et-marketstats-sync';
export const QUEUE_FUNDAMENTALS_SYNC   = 'fundamentals-sync';
export const QUEUE_QUANT_SCORING       = 'quant-scoring';

async function processStockScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled stock scoring...');
  const result = await syncAndScore();
  if (!result.success) throw new Error(`Stock scoring failed: ${result.message}`);
  return { success: true };
}

async function processMcScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled MoneyControl screener sync...');
  const { syncMoneyControlScreeners } = await import('../moneycontrolScreener');
  await syncMoneyControlScreeners();
  return { success: true };
}

async function processEtnowScreenerSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled ETNow screener sync...');
  const { syncETnowScreeners } = await import('../etnowScreenerSync');
  await syncETnowScreeners();
  return { success: true };
}

async function processEtMarketstatsSync(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting scheduled ET Marketstats screener sync...');
  const { syncEtMarketstatsScreeners } = await import('../etMarketstatsSync');
  await syncEtMarketstatsScreeners();
  return { success: true };
}

async function processFundamentalsSync(job: Job): Promise<{ success: boolean }> {
  const phase2Only = job.data?.phase2Only === true;
  console.log(`[QUEUE] Starting fundamentals sync (phase2Only=${phase2Only})...`);
  const { runFullFundamentalsSync } = await import('../fundamentalsSyncService');
  await runFullFundamentalsSync(phase2Only);
  return { success: true };
}

async function processQuantScoring(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting quant strategy scoring...');
  const { runQuantScoring } = await import('../quantScoringService');
  await runQuantScoring();
  // Multi-factor alpha score (Quality/Momentum/Value/Risk-Adj/Macro) -> quant_scores.mf_*.
  // Must run AFTER runQuantScoring() so it reads today's fresh upsert, not a stale row — it
  // used to run inside ml-daily-ops at 7:30 PM IST, 3.5h BEFORE this 11 PM job, exactly
  // inverting the dependency its own docstring claims. Moved here 2026-08.
  await runPython('multi_factor_scorer.py', [], 180_000)
    .catch(e => console.warn('[QUEUE] multi_factor_scorer failed:', (e as Error).message));
  return { success: true };
}

export async function registerScreenerJobs(connection: any) {
  const stockScoring = await registerRepeatableJob({
    connection,
    queueName: QUEUE_STOCK_SCORING,
    jobName: 'score-all',
    repeat: { pattern: '0 17 * * 1-5' }, // 10:30 PM IST (17:00 UTC), Mon-Fri after daily ops
    jobId: 'score-all-repeatable',
    removeOnComplete: 5,
    removeOnFail: 3,
    processor: processStockScoring,
    monitorName: 'stock-scoring',
    concurrency: 1,
    lockDuration: 600000, // 10 minutes for heavy scoring sync
  });

  const mcScreenerSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_MC_SCREENER_SYNC,
    jobName: 'mc-sync',
    // 6:20 PM IST (12:50 UTC) weekdays. MOVED from 11:00 PM IST (2026-07-31): every consumer
    // of the screener tables ran BEFORE this sync, so they all read yesterday's membership.
    // `screener_features_fetcher.py` runs inside ml-daily-ops (7:30 PM IST) and builds
    // `screener_momentum_score` — the largest single engine weight in most REGIME_WEIGHTS
    // regimes — off `screener_appearances`, which this job populates. Now: syncs 6:00-6:40 PM,
    // then ml-daily-ops 7:30 PM, then stock-scoring 10:30 PM — strictly downstream.
    repeat: { pattern: '50 12 * * 1-5' },
    jobId: 'mc-sync-repeatable',
    removeOnComplete: 5,
    removeOnFail: 3,
    processor: processMcScreenerSync,
    monitorName: 'mc-screener-sync',
    concurrency: 1,
    // MC screener sync fetches ~1,400 screeners sequentially — same problem as ETNow: 60s
    // lockDuration caused "could not renew lock" every cycle.
    lockDuration: 90 * 60 * 1000,
    lockRenewTime: 15 * 60 * 1000,
  });

  const etnowScreenerSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_ETNOW_SCREENER_SYNC,
    jobName: 'etnow-sync',
    // 6:40 PM IST (13:10 UTC) weekdays — staggered 20 min after mc-sync, still ahead of
    // ml-daily-ops (7:30 PM). Moved from 11:30 PM; see the mc-sync note for why.
    repeat: { pattern: '10 13 * * 1-5' },
    jobId: 'etnow-sync-repeatable',
    removeOnComplete: 5,
    removeOnFail: 3,
    processor: processEtnowScreenerSync,
    monitorName: 'etnow-screener-sync',
    concurrency: 1,
    // Syncs ~1,300 screeners sequentially (fetch + 800ms rate-limit delay each) — real
    // runtime is ~35-60 min. The old 60s lockDuration made BullMQ think the job died
    // mid-run every cycle (repeated "could not renew lock" errors).
    lockDuration: 90 * 60 * 1000,
    lockRenewTime: 15 * 60 * 1000,
  });

  const etMarketstatsSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_ET_MARKETSTATS_SYNC,
    jobName: 'et-marketstats-sync',
    // 6:00 PM IST (12:30 UTC) weekdays — FIRST of the three screener syncs. Moved from
    // 11:35 PM (see the mc-sync note). This one mattered most: et_marketstats is the only
    // screener source syncAndScore() does NOT re-sync in-process before scoring, yet
    // scoring_engine.load_data() reads it — so at 11:35 PM it was always exactly one day
    // behind the scores built from it at 10:30 PM.
    repeat: { pattern: '30 12 * * 1-5' },
    jobId: 'et-marketstats-sync-repeatable',
    removeOnComplete: 5,
    removeOnFail: 3,
    processor: processEtMarketstatsSync,
    monitorName: 'et-marketstats-sync',
    concurrency: 1,
    // ~92 screeners sequentially (fetch + 500ms rate-limit delay each) — a few minutes.
    lockDuration: 20 * 60 * 1000,
    lockRenewTime: 5 * 60 * 1000,
  });

  const fundamentalsSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_FUNDAMENTALS_SYNC,
    jobName: 'sync-fundamentals-weekly',
    data: { phase2Only: false },
    repeat: { pattern: '0 3 * * 0' }, // Sunday 08:30 IST (03:00 UTC) — early on the closed day, not Mon 03:30 IST
    jobId: 'fundamentals-sync-weekly',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processFundamentalsSync,
    monitorName: 'fundamentals-sync',
    concurrency: 1,
    lockDuration: 30 * 60 * 1000, // Phase 2 deep sync is slow
    lockRenewTime: 5 * 60 * 1000,
  });

  const quantScoring = await registerRepeatableJob({
    connection,
    queueName: QUEUE_QUANT_SCORING,
    jobName: 'quant-score-daily',
    repeat: { pattern: '30 17 * * 1-5' }, // 11:00 PM IST (17:30 UTC), Mon-Fri after stock scoring
    jobId: 'quant-scoring-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processQuantScoring,
    monitorName: 'quant-scoring',
    concurrency: 1,
    lockDuration: 10 * 60 * 1000, // pure in-process computation
    lockRenewTime: 2 * 60 * 1000,
  });

  return { stockScoring, mcScreenerSync, etnowScreenerSync, etMarketstatsSync, fundamentalsSync, quantScoring };
}
