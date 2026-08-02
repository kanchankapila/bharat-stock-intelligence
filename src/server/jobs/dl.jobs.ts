/**
 * Deep-learning pipeline jobs (macro fetch, feature refresh, inference, regime update, weekly
 * retrain), migrated out of queues.ts's initQueues() as the sixth slice of the queues.ts
 * decomposition (see CLAUDE.md architecture review, Phase 3 — earlier slices: screeners.jobs.ts,
 * agents.jobs.ts, operations.jobs.ts, sync.jobs.ts).
 *
 * processDLPython() lives here (not duplicated) even though queues.ts's own ohlcv-backfill and
 * dl-retrain-emergency workers also call it — both stay in queues.ts (dl-retrain-emergency has
 * no addJobWithCatchup/repeat schedule at all; it's purely on-demand, triggered by the drift
 * detector, a different shape than registerRepeatableJob covers), so queues.ts imports this
 * helper back from here rather than the reverse, keeping the dependency graph one-directional
 * (queues.ts -> jobs/*.jobs.ts, never back) -- same pattern as resolveOutcomesResilient in
 * operations.jobs.ts.
 *
 * dl-inference/dl-regime-update/dl-retrain-weekly use updateMonitorState() with a monitor id
 * that DIFFERS from the job/queue name (dl-inference -> 'dl-engine-infer', dl-regime-update ->
 * 'regime-detector', dl-retrain-weekly -> 'dl-trainer') -- these are intentional, not typos;
 * they match what MONITOR_SCRIPTS/JOB_REGISTRY actually key on downstream, so monitorName (used
 * for the `[QUEUE] <name> completed/failed` log line) and the id passed to monitorFn are set
 * independently per job below rather than assumed equal.
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (dlMacroFetchQueue, dlFeatureRefreshQueue, dlInferenceQueue, dlRegimeUpdateQueue,
 * dlRetrainWeeklyQueue) — monitor.router.ts's queue-health dashboard imports those exact
 * bindings directly, so this module only owns the registration logic.
 */
import { Job } from 'bullmq';
import { runPython } from '../pythonRunner';
import { updateMonitorState } from '../monitoringService';
import { registerRepeatableJob } from './registerJob';

export const QUEUE_DL_MACRO_FETCH    = 'dl-macro-fetch';
export const QUEUE_DL_FEATURE_REFRESH = 'dl-feature-refresh';
export const QUEUE_DL_INFERENCE       = 'dl-inference';
export const QUEUE_DL_REGIME_UPDATE   = 'dl-regime-update';
export const QUEUE_DL_RETRAIN_WEEKLY  = 'dl-retrain-weekly';

export async function processDLPython(
  script: string, args: string[] = [], timeoutMs = 6 * 60 * 60_000,
): Promise<{ success: boolean }> {
  await runPython(script, args, timeoutMs);
  return { success: true };
}

async function processDlMacroFetch(_job: Job): Promise<void> {
  // Explicit timeout, not processDLPython's 6h default: this worker's lockDuration is
  // only 5 min, so an unbounded default lets a hang block the lock indefinitely instead
  // of failing cleanly -- exactly what caused a live incident (repeated "could not renew
  // lock" errors + a growing pile of stuck python.exe processes, since a stuck subprocess
  // was never killed and each BullMQ retry spawned another one alongside it).
  await processDLPython('global_macro_fetcher.py', [], 2 * 60_000);
  // MC global: 15 indices (Nikkei/HangSeng/KOSPI/etc) + currencies + ADRs + commodities → mc_global_snapshot + macro_asset_prices.
  await runPython('mc_global_macro_fetcher.py', [], 60_000)
    .catch(e => console.warn('[QUEUE] mc_global_macro_fetcher failed:', (e as Error).message));
  // Sector-global correlation depends on macro_asset_prices populated above.
  await runPython('sector_global_corr.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] sector_global_corr failed:', (e as Error).message));
  // Bond yields (India G-Sec + US/UK/DE 10yr) are now fetched inside global_macro_fetcher.py.
}

async function processDlFeatureRefresh(_job: Job): Promise<{ success: boolean }> {
  return processDLPython('feature_engineering.py');
}

async function processDlInference(_job: Job): Promise<{ success: boolean }> {
  return processDLPython('dl_engine.py', ['--mode', 'infer']);
}

async function processDlRegimeUpdate(_job: Job): Promise<{ success: boolean }> {
  // Same fix as processDlMacroFetch above: explicit timeout, not the 6h default, since this
  // worker's lockDuration is only 5 min.
  return processDLPython('regime_detector.py', ['--mode', 'update'], 2 * 60_000);
}

async function processDlRetrainWeekly(job: Job): Promise<{ success: boolean }> {
  const trigger = job.data?.trigger || 'scheduled';
  // Explicit 24h timeout, not processDLPython's 6h default: a real full-universe BiLSTM
  // retrain (~2100 symbols, chunked training + walk-forward validation retraining
  // several more model copies) measured at ~15min for just 25 symbols on this machine's
  // shared 8GB GPU under typical contention (Ollama + other jobs) -- extrapolated, a full
  // run can run well past 6h. The 6h default is still correct for every OTHER
  // processDLPython caller (feature_engineering.py, dl_engine.py --mode infer,
  // backfill_ohlcv.py), so it's overridden per-call here rather than raised globally.
  return processDLPython('dl_trainer.py', ['--trigger', trigger], 24 * 60 * 60 * 1000);
}

export async function registerDlJobs(connection: any) {
  const macroFetch = await registerRepeatableJob({
    connection,
    queueName: QUEUE_DL_MACRO_FETCH,
    jobName: 'dl-macro-daily',
    repeat: { pattern: '30 2 * * 1-5' }, // 8:00 AM IST
    jobId: 'dl-macro-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processDlMacroFetch,
    monitorName: 'dl-macro-fetch',
    concurrency: 1,
    lockDuration: 5 * 60 * 1000,
  });

  const featureRefresh = await registerRepeatableJob({
    connection,
    queueName: QUEUE_DL_FEATURE_REFRESH,
    jobName: 'dl-feature-daily',
    // 5:00 PM IST (11:30 UTC). MOVED from 3:30 PM IST (2026-07-31): feature_engineering.py
    // reads stock_ohlcv, but that day's bar is only persisted by stock-refresh at 4:00 PM
    // and gap-filled at 4:15 PM — so running at 3:30 PM (the closing bell itself) built
    // every DL feature set without the current session in it, every day.
    repeat: { pattern: '30 11 * * 1-5' },
    jobId: 'dl-feature-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processDlFeatureRefresh,
    monitorName: 'dl-feature-refresh',
    concurrency: 1,
    lockDuration: 60 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
  });

  const inference = await registerRepeatableJob({
    connection,
    queueName: QUEUE_DL_INFERENCE,
    jobName: 'dl-infer-daily',
    // 12:00 AM IST (18:30 UTC). Moved off 10:30 PM IST (2026-07-31): it collided exactly
    // with stock-scoring, and the 10:00 PM–11:35 PM window held 8 heavy jobs in 95 minutes,
    // which is where all 43 pg-pool "timeout exceeded when trying to connect" errors landed.
    // Still strictly after dl-feature-refresh (5:00 PM) and before unified-ranker (7:30 AM).
    repeat: { pattern: '30 18 * * 1-5' },
    jobId: 'dl-infer-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processDlInference,
    monitorName: 'dl-inference',
    concurrency: 1,
    lockDuration: 30 * 60 * 1000,
    lockRenewTime: 5 * 60 * 1000,
    // Real monitor id is 'dl-engine-infer', not 'dl-inference' -- see module docstring.
    monitorFn: (_name, status, detail) => updateMonitorState('dl-engine-infer', status, detail),
  });

  const regimeUpdate = await registerRepeatableJob({
    connection,
    queueName: QUEUE_DL_REGIME_UPDATE,
    jobName: 'dl-regime-daily',
    repeat: { pattern: '15 11 * * 1-5' }, // 4:45 PM IST
    jobId: 'dl-regime-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processDlRegimeUpdate,
    monitorName: 'dl-regime-update',
    concurrency: 1,
    lockDuration: 5 * 60 * 1000,
    // Real monitor id is 'regime-detector', not 'dl-regime-update' -- see module docstring.
    monitorFn: (_name, status, detail) => updateMonitorState('regime-detector', status, detail),
  });

  const retrainWeekly = await registerRepeatableJob({
    connection,
    queueName: QUEUE_DL_RETRAIN_WEEKLY,
    jobName: 'dl-retrain-weekly',
    repeat: { pattern: '0 6 * * 0' }, // Sunday 11:30 IST (06:00 UTC) — early on the closed day, after ml retrain
    jobId: 'dl-retrain-weekly',
    removeOnComplete: 2,
    removeOnFail: 3,
    processor: processDlRetrainWeekly,
    monitorName: 'dl-retrain-weekly',
    concurrency: 1,
    lockDuration: 24 * 60 * 60 * 1000,
    lockRenewTime: 30 * 60 * 1000,
    stalledInterval: 15 * 60 * 1000,
    maxStalledCount: 3,
    // Real monitor id is 'dl-trainer', not 'dl-retrain-weekly' -- see module docstring.
    monitorFn: (_name, status, detail) => updateMonitorState('dl-trainer', status, detail),
  });

  return { macroFetch, featureRefresh, inference, regimeUpdate, retrainWeekly };
}
