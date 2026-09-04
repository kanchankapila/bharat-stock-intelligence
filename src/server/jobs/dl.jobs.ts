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
import { StepTracker } from '../jobSteps';
import { shouldSkipOnTradingHoliday } from '../marketStatusService';

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

async function processDlMacroFetch(_job: Job): Promise<{ success: boolean; failedSteps?: string[] }> {
  // Explicit timeout, not processDLPython's 6h default: this worker's lockDuration is
  // only 5 min, so an unbounded default lets a hang block the lock indefinitely instead
  // of failing cleanly -- exactly what caused a live incident (repeated "could not renew
  // lock" errors + a growing pile of stuck python.exe processes, since a stuck subprocess
  // was never killed and each BullMQ retry spawned another one alongside it).
  const T = new StepTracker('dl-macro-fetch');
  await processDLPython('global_macro_fetcher.py', [], 2 * 60_000);
  // MC global: 15 indices (Nikkei/HangSeng/KOSPI/etc) + currencies + ADRs + commodities → mc_global_snapshot + macro_asset_prices.
  // The two steps below were .catch(console.warn): mc_global_snapshot / macro_asset_prices /
  // sector_global_corr_* could stop being written entirely with this job still green.
  await runPython('mc_global_macro_fetcher.py', [], 60_000)
    .catch(e => T.fail('mc_global_macro_fetcher', e));
  // Sector-global correlation depends on macro_asset_prices populated above.
  await runPython('sector_global_corr.py', [], 3 * 60_000)
    .catch(e => T.fail('sector_global_corr', e));
  // Bond yields (India G-Sec + US/UK/DE 10yr) are now fetched inside global_macro_fetcher.py.
  const verdict = T.finish();
  return { success: verdict.ok, failedSteps: verdict.failedSteps };
}

async function processDlFeatureRefresh(job: Job): Promise<{ success: boolean; skipped?: boolean }> {
  // 2026-08-06: feature_engineering.py reads stock_ohlcv, which stock-refresh never wrote a
  // new bar into on a trading holiday -- there is no new session to featurize. Never
  // dispatched by closed-day-early-batch, so a plain holiday check is enough.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] dl-feature-refresh skipped — trading holiday, no new session to featurize');
    // `skipped: true` lets registerDlJobs' completion chain (below) tell a genuine holiday
    // no-op apart from a real run -- without it, dl-inference would still get chain-dispatched
    // off a "successful" completion that produced no new feature_store row.
    return { success: true, skipped: true };
  }
  return processDLPython('feature_engineering.py');
}

// 2026-08-06: tracks the IST calendar date dl-inference last actually ran on (either via the
// chain trigger below or the fallback cron), so the fallback cron can skip a same-day re-run
// instead of unconditionally duplicating whatever the chain already did. In-memory/per-process
// is deliberate -- a server restart resetting this just means the fallback might run once extra
// on that rare day, an acceptable, bounded cost against the complexity of persisting it.
let _lastDlInferenceRunIstDate: string | null = null;

function _currentIstDateString(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function processDlInference(job: Job): Promise<{ success: boolean }> {
  // 2026-08-06: skip entirely on a trading holiday, no morning replacement -- dl-feature-refresh
  // is also skipped on the same day (see processDlFeatureRefresh above), so feature_store has no
  // new row to infer against; re-running would just reproduce yesterday's prediction under
  // logical_trading_date()'s resolved date.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] dl-inference skipped — trading holiday, no new feature row to infer against');
    return { success: true };
  }
  // The scheduled fallback (job.name === 'dl-infer-daily', see registerDlJobs below) only
  // exists to catch the rare case the chain trigger never fired -- on a normal night it would
  // otherwise unconditionally re-run inference a second time, every single night, exactly the
  // kind of daily duplicate this whole session is closing. The chain-triggered job itself
  // carries a different job.name ('dl-infer-after-feature-refresh') and is never skipped here.
  if (job.name === 'dl-infer-daily' && _lastDlInferenceRunIstDate === _currentIstDateString()) {
    console.log('[QUEUE] dl-inference (fallback) skipped — already ran today via the dl-feature-refresh chain trigger');
    return { success: true };
  }
  const result = await processDLPython('dl_engine.py', ['--mode', 'infer']);
  _lastDlInferenceRunIstDate = _currentIstDateString();
  return result;
}

async function processDlRegimeUpdate(_job: Job): Promise<{ success: boolean }> {
  // Same fix as processDlMacroFetch above: explicit timeout, not the 6h default, since this
  // worker's lockDuration is only 5 min.
  //
  // 2 min was too tight and was the source of this job's failure count: 2026-08-10 17:00:09
  // died on "Timed out after 120000ms (killed by timeout)" and the retry 8 minutes later
  // completed normally, same script, same data. Unpickling the HMM + StandardScaler and
  // reading the full NIFTY history is variable under contention with the other DL jobs.
  // 4 min keeps a full minute of headroom inside the 5-min lockDuration.
  return processDLPython('regime_detector.py', ['--mode', 'update'], 4 * 60_000);
}

async function processDlRetrainWeekly(job: Job): Promise<{ success: boolean }> {
  const trigger = job.data?.trigger || 'scheduled';
  // Explicit 24h timeout, not processDLPython's 6h default: a real full-universe BiLSTM
  // retrain (~2100 symbols, chunked training + walk-forward validation retraining
  // several more model copies) measured at ~15min for just 25 symbols on this machine's
  // shared 8GB GPU under typical contention (other GPU jobs, e.g. FinBERT) -- extrapolated, a full
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
    // 5:00 AM IST (23:30 UTC) -- FALLBACK ONLY. 2026-08-06: dl-inference's real dependency is
    // just feature_store (dl-feature-refresh) + market_regimes, nothing from the 21:00-23:35
    // IST cluster it used to be scheduled around -- so the primary trigger is now the
    // featureRefresh.worker completion chain below, which fires it the moment fresh features
    // actually exist (typically well before 11:30 PM) instead of waiting for a fixed midnight
    // slot regardless of whether dl-feature-refresh happened to finish early or late that
    // night (measured 2026-08-05: 17:00->18:58 IST, well over its nominal 60min budget --
    // a fixed downstream time can't be both safe and prompt against that variance). This cron
    // only matters if the chain never fired (dl-feature-refresh itself failed, or a mid-window
    // restart) -- processDlInference's own same-day dedup skips it otherwise. Kept before
    // closed-day-early-batch (7:10 AM) and unified-ranker (7:30 AM), not at the old midnight
    // slot, since a fallback that only fires on a genuine miss doesn't need to run any earlier
    // than "before the next thing that might want it."
    repeat: { pattern: '0 16 * * 1-5' }, // 9:30 PM IST (16:00 UTC)
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

  // Chain trigger: dispatch dl-inference the moment dl-feature-refresh actually finishes with
  // fresh data, rather than relying solely on the fixed fallback above. `result.skipped` (see
  // processDlFeatureRefresh) distinguishes a genuine run from a trading-holiday no-op -- a
  // skipped refresh produced no new feature_store row, so chain-dispatching inference off it
  // would just reproduce yesterday's prediction for no reason.
  featureRefresh.worker.on('completed', (_job, result: any) => {
    if (result?.skipped) return;
    inference.queue.add('dl-infer-after-feature-refresh', {}, { removeOnComplete: 3, removeOnFail: 3 })
      .then(() => console.log('[QUEUE] dl-inference dispatched right after dl-feature-refresh (chain trigger)'))
      // swallow-ok: no job verdict exists to attach this to -- the 'completed' handler has
      // already returned, so there is no StepTracker in scope, and stamping 'dl-engine-infer'
      // failed would report on a run that has not happened. console.error (not warn) because an
      // enqueue failure here is a Redis-level fault; the fixed dl-infer-daily schedule above is
      // the functional mitigation, so a lost chain-dispatch delays inference, it does not skip it.
      .catch(e => console.error('[QUEUE] Failed to chain-dispatch dl-inference after dl-feature-refresh:', (e as Error).message));
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
    repeat: { pattern: '0 6 * * 6' }, // Saturday 11:30 IST (06:00 UTC) — early on the closed day, after ml retrain
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
