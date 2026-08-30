/**
 * Trendlyne weekly/monthly batch jobs (midweek adv-tech+price-analysis, monthly ratios),
 * migrated out of queues.ts's initQueues() as the seventh slice of the queues.ts decomposition
 * (see CLAUDE.md architecture review, Phase 3 — earlier slices: screeners.jobs.ts,
 * agents.jobs.ts, operations.jobs.ts, sync.jobs.ts, dl.jobs.ts).
 *
 * trendlyne-daily-fetch stays in queues.ts (its processor self-references the very queue
 * instance registerRepeatableJob() creates for it — a shape that helper doesn't cover yet).
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (trendlyneMidweekQueue, trendlyneRatiosMonthlyQueue) — this module only owns the
 * registration logic.
 */
import { Job } from 'bullmq';
import { runPython } from '../pythonRunner';
import { updateMonitorState } from '../monitoringService';
import { registerRepeatableJob } from './registerJob';
import { isMarketOpen } from '../marketStatusService';

export const QUEUE_TRENDLYNE_MIDWEEK = 'trendlyne-midweek';
export const QUEUE_TRENDLYNE_RATIOS_MONTHLY = 'trendlyne-ratios-monthly';
export const QUEUE_TRENDLYNE_CATCHUP = 'trendlyne-catchup';

/**
 * The four per-symbol trendlyne.com fetchers, in rotation order.
 *
 * Each takes a bounded slice per run (cap_to_run_budget in fetch_utils.py) because
 * trendlyne.com's AWS WAF allowance is a per-session REQUEST COUNT (~131-150 measured
 * 2026-08-17), not a rate — so a 2,234-symbol universe cannot be fetched in one pass at any
 * pacing. Bounded slice + each fetcher's resume-from-DB skip converges instead; that is how
 * trendlyne_adv_tech_daily reached 2234/2234 the same day, after a year of weekly failures.
 *
 * ONE script per run, not all four: they share a single source IP, so they share one
 * allowance. Rotating by wall-clock (below) keeps that stateless.
 */
const CATCHUP_FETCHERS = [
  'trendlyne_adv_tech_fetcher.py',
  'trendlyne_price_analysis_fetcher.py',
  'trendlyne_overview_fetcher.py',
  'trendlyne_fundamentals_fetcher.py',
];

/** Rotate off the clock rather than stored state — a restart must not always replay index 0. */
export function catchupFetcherFor(now = new Date()): string {
  const slot = Math.floor(now.getTime() / (20 * 60_000));
  return CATCHUP_FETCHERS[slot % CATCHUP_FETCHERS.length];
}

export async function processTrendlyneCatchup(_job: Job): Promise<{ success: boolean; script: string }> {
  const script = catchupFetcherFor();
  // 10 min: a 110-request slice is ~2-4 min serially. Deliberately far below the 20-min cadence
  // so two catch-up runs can never overlap and double-spend the shared WAF allowance.
  //
  // Was `.catch(warn)` with no rethrow, same shape processTrendlyneMidweek below was already
  // fixed for (2026-08-28) but this sibling was missed: a timeout/failure here logged a warning
  // and then unconditionally returned {success:true}, so job_heartbeat.trendlyne-catchup showed
  // 0 failures across 861 runs even on a night this exact timeout fired twice inside one hour
  // (found live 2026-08-30 reviewing logs/error-2026-08-30.log). Rethrow so a real failure
  // reaches worker.on('failed') and actually marks the heartbeat.
  try {
    await runPython(script, [], 10 * 60_000);
  } catch (e) {
    console.warn(`[QUEUE] trendlyne-catchup ${script} failed:`, (e as Error).message);
    throw e;
  }
  return { success: true, script };
}

async function processTrendlyneMidweek(_job: Job): Promise<{ success: boolean; skipped?: boolean }> {
  // AF-20260828-25: the deliberate Tuesday 8 PM IST slot is already off-hours, but
  // registerJob's catch-up mechanism re-fires this job whenever a server restart notices it
  // "missed" that slot -- at whatever wall-clock time the restart happened to land, market
  // hours included. Live-measured 2026-08-28: off-hours got 106/110 requests through cleanly;
  // a mid-day run got blocked after exactly 1 request, and a second mid-day run got 51/75
  // before a sustained block. Same shared-IP WAF budget as every other Trendlyne fetcher
  // (data-sources.md's request-count-not-rate finding) -- spending it during market hours,
  // when it degrades fastest, is strictly worse than waiting for the next off-hours window.
  // { skipped: true } (not a thrown error) -- registerJob's shared 'completed' handler already
  // treats this as a no-op, same convention as technical-signals' own market-hours skip guard.
  if (await isMarketOpen()) {
    console.log('[QUEUE] trendlyne-midweek skipped — market is open, deferring to the next off-hours run to protect the shared Trendlyne WAF budget');
    return { success: true, skipped: true };
  }

  // Both scripts must still run even if one fails (a broken adv-tech fetch shouldn't skip
  // price-analysis, and vice versa) -- but swallowing both failures via .catch() unconditionally
  // resolving {success:true} meant a real failure never reached the worker's 'completed'/'failed'
  // event, so registerRepeatableJob() always recorded this job as a success regardless of what
  // actually happened underneath. This is exactly what let trendlyne_price_analysis_fetcher.py's
  // FetchTracker fail-loud fix (2026-08-03, exits non-zero once 100% of a run's stocks return "no
  // data") go unnoticed on 2026-07-28 and again on 2026-08-04 -- the script correctly exited 1
  // both times, but this wrapper still reported "trendlyne-midweek completed" with no error.
  // Collect failures and throw once both have had a chance to run, so a genuine break is visible
  // in job_heartbeat/the daily digest instead of only in a DB-freshness staleness check.
  const errors: string[] = [];
  await runPython('trendlyne_adv_tech_fetcher.py', [], 40 * 60_000)
    .catch(e => {
      console.warn('[QUEUE] trendlyne_adv_tech_fetcher failed:', (e as Error).message);
      errors.push(`trendlyne_adv_tech_fetcher: ${(e as Error).message}`);
    });
  await runPython('trendlyne_price_analysis_fetcher.py', [], 40 * 60_000)
    .catch(e => {
      console.warn('[QUEUE] trendlyne_price_analysis_fetcher failed:', (e as Error).message);
      errors.push(`trendlyne_price_analysis_fetcher: ${(e as Error).message}`);
    });
  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }
  return { success: true };
}

export async function processTrendlyneRatiosMonthly(_job: Job): Promise<{ success: boolean; monthlySkipped?: boolean }> {
  const isFirstSundayOfMonth = new Date().getUTCDate() <= 7;
  // Every step below used to be `.catch(warn)` with no rethrow -- same shape processTrendlyneMidweek
  // was fixed for on 2026-08-28, missed here (found live 2026-08-30): job_heartbeat.trendlyne-ratios-monthly
  // shows 0 failures across its whole run history despite six independently-failable steps, which is
  // exactly the "success heartbeat on a step that wrote nothing" class in recurring-bugs.md. Steps still
  // run best-effort (one broken fetcher must not skip the rest), but errors are now collected and
  // re-thrown once every step has had its chance, so a real failure reaches job_heartbeat.
  const errors: string[] = [];
  const step = (label: string, p: Promise<unknown>) =>
    p.catch(e => {
      console.warn(`[QUEUE] ${label} failed:`, (e as Error).message);
      errors.push(`${label}: ${(e as Error).message}`);
    });

  // WEEKLY (every Sunday) — moved out of the first-Sunday gate 2026-07-31.
  // The ratios themselves only change quarterly, but the gate meant a newly-added
  // COLUMN was invisible for up to a month: the 2026-07-23 banking-ratio harvest
  // (nim/cost_to_income/capital_adequacy/gross_npa_pct) still had 1,969 of 1,978 rows
  // predating it on 07-31, because the last full-universe run was 07-11. Nothing
  // errored — the columns were simply NULL — and densify_feature_matrix.py cannot
  // help, since there is no prior value to carry forward.
  //
  // 60 min, not 30: measured 29m02s for 1,969 stocks on 2026-07-31, i.e. 97% of the
  // old 30-min budget. That is the same under-budgeted-timeout pattern that has bitten
  // this file repeatedly — treat anything under ~2x the measured runtime as too tight.
  await step('financial_ratios_fetcher', runPython('financial_ratios_fetcher.py', [], 60 * 60_000));

  // Deep per-stock corporate-action history (dividends/bonus/splits/rights), 2026-08-07
  // urls.txt open-source sourcing pass -> stock_corporate_action_history. Weekly, not daily:
  // dividends/bonus/splits are declared a handful of times a year per stock, so a daily crawl
  // of ~2000+ stocks would be pure load for almost no new data -- matches
  // financial_ratios_fetcher.py's own weekly cadence directly above for the same reason.
  // 30 min budget: mc_pricefeed_fetcher.py (same per-stock MC crawl shape, same BATCH_SIZE=15
  // concurrency) measures ~25 min full-universe; this fetcher's section=all payload is smaller
  // per-stock than pricefeed's, so 30 min is headroom, not a guess -- re-measure and bump if a
  // real run needs more.
  await step('mc_corporate_actions_fetcher', runPython('mc_corporate_actions_fetcher.py', [], 30 * 60_000));

  // ohlcv_adjust.py had NO scheduled run at all before this (its own docstring only documents
  // manual `--report`/`--persist` invocation) -- so ohlcv_adjustment_factors, which
  // backtester.load_bhavcopy_adjusted() depends on for every delisted-symbol backtest, was
  // frozen at whatever a one-off manual run last left it. Scheduled here, weekly, right after
  // the bhavcopy universe (nse_bhavcopy_fetcher.py, daily inside ml-daily-ops) and the fresh
  // MC corporate-action history right above it -- both this step's real inputs.
  await step('ohlcv_adjust --persist', runPython('ohlcv_adjust.py', ['--persist'], 20 * 60_000));
  // Cross-validates the heuristic factors above against stock_corporate_action_history and
  // fills genuine gaps (e.g. pre-2021 bonus/split events bhavcopy has no rows for at all) --
  // see cross_validate_with_mc_actions()'s own docstring for the confirmed/filled/disagreement
  // three-way split. Deliberately run as a SEPARATE step after --persist commits, not merged
  // into one invocation, so a failure in the cross-check never blocks the heuristic scan.
  await step('ohlcv_adjust --cross-validate', runPython('ohlcv_adjust.py', ['--cross-validate', '--persist'], 10 * 60_000));

  // mc_seasonality_best_stocks refresh (added 2026-08-07 — the table's schema existed since
  // moneycontrol_fetcher.py's original table batch, but no writer was ever built; the
  // getMcSeasonality tRPC procedure / SeasonalityCalendar.tsx (Smart Money page) had been
  // silently reading an always-empty table). 24 requests (12 months x bullish/bearish),
  // measured ~48s uncontended; 10-min budget is generous headroom for MC rate-limit backoff.
  // Weekly, not monthly: cheap enough that there's no reason to wait a month for movement.
  await step('moneycontrol_fetcher --seasonality', runPython('moneycontrol_fetcher.py', ['--seasonality'], 10 * 60_000));

  if (!isFirstSundayOfMonth) {
    console.log('[QUEUE] trendlyne-ratios: weekly ratios done; monthly steps skipped '
      + '(not the first Sunday of the month)');
    if (errors.length > 0) throw new Error(errors.join(' | '));
    return { success: true, monthlySkipped: true };
  }

  // MONTHLY — these two genuinely track monthly/quarterly source publications, so
  // running them weekly would be pure load for no new data.
  // 60 min: 1969-stock sequential cash-conversion-cycle fetch runs ~33 min at ~1 stock/s,
  // so the old 30-min budget SIGTERM'd near the end (leaving partial data + a 'failed' mark
  // in the monthly report even though most rows were written).
  await step('working_capital_fetcher', runPython('working_capital_fetcher.py', [], 60 * 60_000));
  // Per-stock MF ownership flow (AMFI publishes portfolio disclosures monthly).
  await step('mf_stock_holdings_fetcher', runPython('mf_stock_holdings_fetcher.py', [], 30 * 60_000));
  // Deepens proprietary_scores_history's Altman/Ohlson/Graham/DuPont history from
  // moneycontrol_fetcher.py's daily single-snapshot scrape to ~9 years of annual bars.
  // Runs AFTER working_capital_fetcher.py above (not before) because it resolves each
  // stock's real fiscal year-end from working_capital_history -- freshest FY-end data
  // first, then the history backfill that depends on it. Monthly cadence: these are
  // annual figures that change at most once a year, so a weekly re-run (like the ratios
  // above) would be pure load for no new data.
  await step('mc_stockvitals_history_fetcher', runPython('mc_stockvitals_history_fetcher.py', [], 60 * 60_000));
  if (errors.length > 0) throw new Error(errors.join(' | '));
  return { success: true };
}

export async function registerTrendlyneWeeklyJobs(connection: any) {
  const midweek = await registerRepeatableJob({
    connection,
    queueName: QUEUE_TRENDLYNE_MIDWEEK,
    jobName: 'trendlyne-midweek-batch',
    // Tuesday 14:30 UTC (8:00 PM IST). Moved off 6:00 PM IST 2026-07-31: the three
    // screener syncs relocated into the 6:00-6:40 PM block, and this heavy weekly
    // Trendlyne batch landed exactly on et-marketstats-sync every Tuesday.
    repeat: { pattern: '30 14 * * 2' },
    jobId: 'trendlyne-midweek-weekly',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processTrendlyneMidweek,
    monitorName: 'trendlyne-midweek',
    concurrency: 1,
    lockDuration: 90 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
    monitorFn: updateMonitorState,
  });

  const ratiosMonthly = await registerRepeatableJob({
    connection,
    queueName: QUEUE_TRENDLYNE_RATIOS_MONTHLY,
    jobName: 'trendlyne-ratios-monthly-check',
    // 2026-08-09: moved 12:30 UTC (18:00 IST, evening) -> 00:30 UTC (06:00 IST, early morning).
    // This job's own real crash today traced to Postgres OOMing under a too-small container
    // memory limit (fixed separately, docker-compose.yml), but the box was ALSO under real
    // host-level memory pressure at the time -- mostly Chrome (~6.6GB across 8 processes),
    // which is presumably heaviest during active daytime/evening use. 06:00 IST runs before
    // typical waking/browsing hours, and deliberately BEFORE the 07:30-11:30+ IST cluster
    // (nse-sync/fundamentals-sync/ml-weekly-retrain/dl-retrain-weekly) rather than after it --
    // dl-retrain-weekly has a 24h lockDuration and no predictable finish time, so scheduling
    // after it risked open-ended overlap instead of a bounded one. financial_ratios_fetcher
    // runs on ALL Sundays (weekly); working_capital + mf_stock_holdings only on the first
    // Sunday of the month. Weekly cadence (168h gap) is unchanged by the hour-of-day move, so
    // financial-ratios/working-capital's staleLimitHours in monitorScripts.ts need no change.
    repeat: { pattern: '30 0 * * 6' }, // Saturday 06:00 IST (00:30 UTC)
    jobId: 'trendlyne-ratios-monthly-weekly-check',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processTrendlyneRatiosMonthly,
    monitorName: 'trendlyne-ratios-monthly',
    concurrency: 1,
    // 60min -> 270min (2026-08-07): matches jobRegistry.ts's graceMinutes bump for this same
    // job -- see that file's comment for the full worst-case-budget derivation. lockRenewTime
    // below already re-extends the lock every 10min while the worker is alive, so this ceiling
    // mainly protects against a genuinely stalled/dead worker, not normal long-running steps.
    lockDuration: 270 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
    monitorFn: updateMonitorState,
  });

  const catchup = await registerRepeatableJob({
    connection,
    queueName: QUEUE_TRENDLYNE_CATCHUP,
    jobName: 'trendlyne-catchup-slice',
    // Every 20 min, all day: one fetcher per run, so each of the four gets a slice every 80
    // min (~18 slices/day => ~1,980 symbols/day for the 1-request-per-symbol fetchers). That
    // converges a 2,234-symbol universe in ~1-2 days, which is the cadence these near-static
    // datasets need — and it mirrors the one Trendlyne job that has never failed
    // (trendlyne-daily-fetch, 87,721 runs / 0 failures), which spreads its per-symbol requests
    // across a 12-hour window instead of bursting them.
    repeat: { pattern: '*/20 * * * *' },
    jobId: 'trendlyne-catchup-slice',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processTrendlyneCatchup,
    monitorName: 'trendlyne-catchup',
    concurrency: 1,
    lockDuration: 15 * 60 * 1000,
  });

  return { midweek, ratiosMonthly, catchup };
}
