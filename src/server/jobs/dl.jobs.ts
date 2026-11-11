/**
 * Deep-learning pipeline jobs that still feed live models: macro fetch, feature refresh
 * (feature_store, read by the ML ensemble) and regime update (market_regimes, read by the ranker;
 * monitor id 'regime-detector', not the queue name). DL inference and the weekly retrain were
 * retired 2026-11-11 (AF-20261111-01); registerDlJobs clears their old schedules.
 * processDLPython() lives here and queues.ts imports it back (ohlcv-backfill).
 */
import { Job, Queue } from 'bullmq';
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
): Promise<{ success: boolean; skipped?: boolean }> {
  await runPython(script, args, timeoutMs);
  return { success: true };
}

async function processDlMacroFetch(_job: Job): Promise<{ success: boolean; skipped?: boolean; failedSteps?: string[]; monitorAlreadyRecorded?: boolean }> {
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
  // Sector-global correlation depends on macro_asset_prices populated above. 3 -> 10 min
  // (2026-11-07): same technical_signals row-lock waits as the evening call raised on 11-03; this
  // 08:00 call kept 3 min and died at exactly 180s on 11-02 and 11-04 (standalone run: 10s).
  await runPython('sector_global_corr.py', [], 10 * 60_000)
    .catch(e => T.fail('sector_global_corr', e));
  // Bond yields (India G-Sec + US/UK/DE 10yr) are now fetched inside global_macro_fetcher.py.
  const verdict = T.finish();
  return { success: verdict.ok, failedSteps: verdict.failedSteps,
    monitorAlreadyRecorded: verdict.monitorAlreadyRecorded };
}

async function processDlFeatureRefresh(job: Job): Promise<{ success: boolean; skipped?: boolean }> {
  // 2026-08-06: feature_engineering.py reads stock_ohlcv, which stock-refresh never wrote a
  // new bar into on a trading holiday -- there is no new session to featurize. Never
  // dispatched by closed-day-early-batch, so a plain holiday check is enough.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] dl-feature-refresh skipped — trading holiday, no new session to featurize');
    return { success: true, skipped: true };
  }
  return processDLPython('feature_engineering.py');
}

async function processDlRegimeUpdate(_job: Job): Promise<{ success: boolean; skipped?: boolean }> {
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
    monitorFn: (_name, status, detail, durationMs) => updateMonitorState('regime-detector', status, detail, durationMs),
  });

  // dl-inference and dl-retrain-weekly RETIRED 2026-11-11 (AF-20261111-01, user decision): dl_score
  // is 0.0 in every regime, its 5d rank IC is +0.003 (t 0.74, 90 dates) and none of its outputs
  // forecast move size beyond trailing volatility (measurement.md 2026-11-11); the retrain peaked
  // at 13.8 GB. Only the stale repeatables are cleared, so Redis stops firing them into queues
  // with no worker. dl_engine.py / dl_trainer.py stay for a manual run.
  for (const name of [QUEUE_DL_INFERENCE, QUEUE_DL_RETRAIN_WEEKLY]) {
    const q = new Queue(name, { connection });
    for (const r of await q.getRepeatableJobs()) await q.removeRepeatableByKey(r.key);
    await q.close();
  }

  return { macroFetch, featureRefresh, regimeUpdate };
}
