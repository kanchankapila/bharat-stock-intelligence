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

export const QUEUE_TRENDLYNE_MIDWEEK = 'trendlyne-midweek';
export const QUEUE_TRENDLYNE_RATIOS_MONTHLY = 'trendlyne-ratios-monthly';

async function processTrendlyneMidweek(_job: Job): Promise<{ success: boolean }> {
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

async function processTrendlyneRatiosMonthly(_job: Job): Promise<{ success: boolean; monthlySkipped?: boolean }> {
  const isFirstSundayOfMonth = new Date().getUTCDate() <= 7;

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
  await runPython('financial_ratios_fetcher.py', [], 60 * 60_000)
    .catch(e => console.warn('[QUEUE] financial_ratios_fetcher failed:', (e as Error).message));

  if (!isFirstSundayOfMonth) {
    console.log('[QUEUE] trendlyne-ratios: weekly ratios done; monthly steps skipped '
      + '(not the first Sunday of the month)');
    return { success: true, monthlySkipped: true };
  }

  // MONTHLY — these two genuinely track monthly/quarterly source publications, so
  // running them weekly would be pure load for no new data.
  // 60 min: 1969-stock sequential cash-conversion-cycle fetch runs ~33 min at ~1 stock/s,
  // so the old 30-min budget SIGTERM'd near the end (leaving partial data + a 'failed' mark
  // in the monthly report even though most rows were written).
  await runPython('working_capital_fetcher.py', [], 60 * 60_000)
    .catch(e => console.warn('[QUEUE] working_capital_fetcher failed:', (e as Error).message));
  // Per-stock MF ownership flow (AMFI publishes portfolio disclosures monthly).
  await runPython('mf_stock_holdings_fetcher.py', [], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] mf_stock_holdings_fetcher failed:', (e as Error).message));
  // Deepens proprietary_scores_history's Altman/Ohlson/Graham/DuPont history from
  // moneycontrol_fetcher.py's daily single-snapshot scrape to ~9 years of annual bars.
  // Runs AFTER working_capital_fetcher.py above (not before) because it resolves each
  // stock's real fiscal year-end from working_capital_history -- freshest FY-end data
  // first, then the history backfill that depends on it. Monthly cadence: these are
  // annual figures that change at most once a year, so a weekly re-run (like the ratios
  // above) would be pure load for no new data.
  await runPython('mc_stockvitals_history_fetcher.py', [], 60 * 60_000)
    .catch(e => console.warn('[QUEUE] mc_stockvitals_history_fetcher failed:', (e as Error).message));
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
    // Every Sunday 12:30 UTC. financial_ratios_fetcher runs on ALL of them (weekly);
    // working_capital + mf_stock_holdings only on the first Sunday of the month.
    repeat: { pattern: '30 12 * * 0' },
    jobId: 'trendlyne-ratios-monthly-weekly-check',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processTrendlyneRatiosMonthly,
    monitorName: 'trendlyne-ratios-monthly',
    concurrency: 1,
    lockDuration: 60 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
    monitorFn: updateMonitorState,
  });

  return { midweek, ratiosMonthly };
}
