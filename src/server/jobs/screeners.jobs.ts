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
import { recalculateScores } from '../scoringService';
import { syncAllScreenerStocksToDB } from '../trendlyneScreener';
import { registerRepeatableJob } from './registerJob';
import { runPython } from '../pythonRunner';
import { shouldSkipOnTradingHoliday } from '../marketStatusService';

export const QUEUE_STOCK_SCORING          = 'stock-scoring';
export const QUEUE_MC_SCREENER_SYNC       = 'mc-screener-sync';
export const QUEUE_ETNOW_SCREENER_SYNC    = 'etnow-screener-sync';
export const QUEUE_ET_MARKETSTATS_SYNC    = 'et-marketstats-sync';
export const QUEUE_TRENDLYNE_SCREENER_SYNC = 'trendlyne-screener-sync';
export const QUEUE_FUNDAMENTALS_SYNC      = 'fundamentals-sync';
export const QUEUE_QUANT_SCORING          = 'quant-scoring';

async function processStockScoring(job: Job): Promise<{ success: boolean }> {
  // 2026-08-06: skip entirely on a trading holiday, no morning replacement -- recalculateScores()
  // would just re-derive the same composite scores from the same unchanged stock_scores/
  // technical_signals inputs (the exchange never opened, nothing upstream refreshed). Not wired
  // into closed-day-early-batch's dispatch: unlike outcome-resolver/ml-daily-ops/unified-ranker,
  // re-scoring off literally identical inputs produces an identical result, so there's nothing
  // to gain by running it earlier -- only by not running it a second time that evening.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] stock-scoring skipped — trading holiday, nothing new to score');
    return { success: true };
  }
  console.log('[QUEUE] Starting scheduled stock scoring...');
  // Calls recalculateScores() directly, NOT syncAndScore() -- 2026-08-04 job-timing audit.
  // syncAndScore() also re-syncs Trendlyne/MoneyControl/ETNow screener membership in-process,
  // which made this scheduled 22:30 IST run a THIRD same-evening re-fetch of each provider
  // (after the dedicated 18:00/18:20/18:40 IST syncs, then AGAIN inside quant-eod-sync at
  // 22:00 IST). Those dedicated jobs are dependency-ordered ahead of this one and own screener
  // membership now; this job only needs to re-score off what's already fresh in the DB.
  // syncAndScore() itself is untouched and still used by scoring.router.ts's on-demand
  // "resync everything now" trigger, where an explicit re-sync is the whole point.
  const result = await recalculateScores();
  if (!result.success) throw new Error(`Stock scoring failed: ${result.message}`);
  return { success: true };
}

async function processMcScreenerSync(job: Job): Promise<{ success: boolean }> {
  // 2026-08-06: no new data to fetch on a trading holiday -- MoneyControl's screener universe
  // reflects the same closed exchange session as yesterday. Never dispatched by closed-day-
  // early-batch (no shortlist depends on same-day screener membership refreshing that fast),
  // so a plain holiday check is enough here, unlike the scoring/ranking jobs elsewhere.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] mc-screener-sync skipped — trading holiday, nothing new to sync');
    return { success: true };
  }
  console.log('[QUEUE] Starting scheduled MoneyControl screener sync...');
  const { syncMoneyControlScreeners } = await import('../moneycontrolScreener');
  await syncMoneyControlScreeners();
  return { success: true };
}

async function processEtnowScreenerSync(job: Job): Promise<{ success: boolean }> {
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] etnow-sync skipped — trading holiday, nothing new to sync');
    return { success: true };
  }
  console.log('[QUEUE] Starting scheduled ETNow screener sync...');
  const { syncETnowScreeners } = await import('../etnowScreenerSync');
  await syncETnowScreeners();
  return { success: true };
}

async function processEtMarketstatsSync(job: Job): Promise<{ success: boolean }> {
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] et-marketstats-sync skipped — trading holiday, nothing new to sync');
    return { success: true };
  }
  console.log('[QUEUE] Starting scheduled ET Marketstats screener sync...');
  const { syncEtMarketstatsScreeners } = await import('../etMarketstatsSync');
  await syncEtMarketstatsScreeners();
  return { success: true };
}

async function processTrendlyneScreenerSync(job: Job): Promise<{ success: boolean }> {
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] trendlyne-screener-sync skipped — trading holiday, nothing new to sync');
    return { success: true };
  }
  console.log('[QUEUE] Starting scheduled Trendlyne screener-stock sync...');
  // Given no dedicated schedule of its own before 2026-08-04: this membership sync only ever
  // ran as a side effect of quant-eod-sync (22:00 IST) and stock-scoring's syncAndScore()
  // (22:30 IST) -- both of which ALSO redundantly re-synced MC/ETnow (removed the same audit).
  // Removing those two calls without adding this dedicated one would have left Trendlyne
  // screener membership with no scheduled sync at all. Placed alongside its mc-sync/etnow-sync/
  // et-marketstats-sync siblings (18:00-18:40 IST) rather than left in the 22:00/22:30 slot.
  const result = await syncAllScreenerStocksToDB();
  if (!result.success) throw new Error(`Trendlyne screener sync failed: ${result.error}`);
  return { success: true };
}

async function processFundamentalsSync(job: Job): Promise<{ success: boolean }> {
  const phase2Only = job.data?.phase2Only === true;
  console.log(`[QUEUE] Starting fundamentals sync (phase2Only=${phase2Only})...`);
  const { runFullFundamentalsSync } = await import('../fundamentalsSyncService');
  await runFullFundamentalsSync(phase2Only);
  return { success: true };
}

async function processQuantScoring(job: Job): Promise<{ success: boolean }> {
  // 2026-08-06: same reasoning as processStockScoring above -- skip entirely, no morning
  // replacement, since quant_scores would just be re-derived from the same unchanged inputs.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] quant-scoring skipped — trading holiday, nothing new to score');
    return { success: true };
  }
  console.log('[QUEUE] Starting quant strategy scoring...');
  const { runQuantScoring } = await import('../quantScoringService');
  await runQuantScoring();
  // Multi-factor alpha score (Quality/Momentum/Value/Risk-Adj/Macro) -> quant_scores.mf_*.
  // Must run AFTER runQuantScoring() so it reads today's fresh upsert, not a stale row — it
  // used to run inside ml-daily-ops at 7:30 PM IST, 3.5h BEFORE this 11 PM job, exactly
  // inverting the dependency its own docstring claims. Moved here 2026-08.
  await runPython('multi_factor_scorer.py', [], 180_000)
    .catch(e => console.warn('[QUEUE] multi_factor_scorer failed:', (e as Error).message));
  // Beta/Sortino/VaR95 -> quant_scores.beta_1y/beta_6m/sortino_ratio/var_95 (2026-08-07,
  // dead-column sweep). risk_metrics_engine.py was fully built (reads stock_ohlcv, computes
  // rolling stats vs NIFTY50, writes via UPDATE quant_scores ... WHERE symbol=?) but was never
  // scheduled anywhere -- confirmed 0 references in queues.ts/jobs/*.ts before this. Same
  // ordering requirement as multi_factor_scorer.py above (must run AFTER runQuantScoring() so
  // the row exists to UPDATE) and safe to run alongside it: runQuantScoring()'s own UPSERT_SQL
  // explicitly lists its own columns and never mentions beta_1y/beta_6m/sortino_ratio/var_95,
  // so it can't clobber what this step writes on any later run. Measured live 2026-08-07:
  // full 2,449-symbol universe (2,423 processed, 26 skipped for insufficient history) in
  // 37.6s -- the 10-symbol --test sample's 5.4s was almost entirely fixed overhead (module
  // import, NIFTY50 benchmark load), not a per-symbol cost, so a naive linear extrapolation
  // from it would have badly overestimated. 5min budget is ample margin over the real number.
  await runPython('risk_metrics_engine.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] risk_metrics_engine failed:', (e as Error).message));

  // Point-in-time snapshot, taken HERE because quant_scores is only settled once all three
  // writers above have run (runQuantScoring -> multi_factor_scorer -> risk_metrics_engine).
  //
  // quant_scores is PRIMARY KEY (symbol) with no date column, so every run overwrites it and
  // its history is otherwise unrecoverable. That is what makes backfilling the canonical
  // ranker impossible: unified_ranker.py reads this table with no date filter, so
  // reconstructing a past ranking would have to substitute today's values -- a look-ahead leak
  // straight into the high_vol veto via annualized_vol. See migration 1786960000000.
  //
  // snapshot_date is MAX(date) FROM stock_ohlcv, not a wall clock: quant_scores is derived from
  // OHLCV so that is definitionally the session it describes, and it stays correct when this
  // 17:30 UTC job runs late or as a boot catch-up. new Date() here would be the
  // date.today()-as-write-anchor class in recurring-bugs.md.
  //
  // Column list mirrors all 44 of quant_scores; the quant-scores-history-column-parity
  // data-quality check fails if that table gains one this misses.
  const { snapshotQuantScores } = await import('../quantScoringService');
  await snapshotQuantScores()
    .catch(e => console.warn('[QUEUE] quant_scores snapshot failed:', (e as Error).message));
  // Persist the two validated standalone paper screens for cheap API/UI reads. Both remain
  // outside unified_ranker: their evidence supports paper trading, not dilution into the
  // canonical multi-engine blend (and this repo has measured that COMBINING made things worse
  // in every case tested). A recent start date is enough to compute today's ranks and avoids
  // rebuilding the 5-year research panel every night.
  //
  // value_book_to_price is listed FIRST because it is the stronger of the two on every axis
  // measured -- t 2.67 vs 2.08, Sharpe 1.47 vs 1.10, turnover 0.28 vs 0.35, max DD -17.9% vs
  // -19.5%. It was validated 2026-08-10 but left unwired until then, so the weaker factor was
  // the only one the UI could show.
  //
  // Run SEQUENTIALLY, not in parallel: each invocation loads the full price panel (~3M bars)
  // and two at once would double peak memory for no wall-clock gain on a shared box. Each is
  // independently .catch()'d so one factor failing still leaves the other's snapshot fresh,
  // and neither may fail canonical quant scoring.
  // value_book_to_price is in factor_backtest.PROVISIONAL_FACTORS: Trendlyne's valuation
  // history is a recent vendor BACKFILL (fetched_at spans 2026-06-30..08-08), so a restated
  // trailing figure silently rewrites the past and the t-stat could be inflated. That guard
  // is right, and --allow-provisional is its intended deliberate override rather than a
  // bypass -- so the reasoning for overriding is recorded here:
  //   - book value is the LEAST restatement-prone value input (balance sheet, not earnings);
  //   - the far more restatement-prone earnings variant performs WORSE (value_earnings_yield
  //     +0.34%/mo t=0.94 vs value_book_to_price +0.93%/mo t=2.67). A restatement artifact
  //     would inflate the earnings-based factor MOST, so the ordering is backwards for that
  //     explanation;
  //   - the picks are labelled paper-trade with decay and provisional caveats in the UI.
  // This is a bounded argument, not a quantified sensitivity. If a point-in-time valuation
  // snapshot ever accumulates (see _add_valuation), re-run the factor against it and drop
  // this flag rather than leaving it on by inertia.
  const provisional: Record<string, boolean> = { value_book_to_price: true };
  for (const factor of ['value_book_to_price', 'momentum_12_1']) {
    const args = ['--factor', factor, '--top-k', '50', '--start', '2024-01-01', '--persist-picks'];
    if (provisional[factor]) args.push('--allow-provisional');
    await runPython('factor_backtest.py', args, 15 * 60_000)
      .catch(e => console.warn(`[QUEUE] factor picks snapshot (${factor}) failed:`, (e as Error).message));
  }
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
    // 6:00 PM IST (12:30 UTC) weekdays — FIRST of the four screener syncs. Moved from
    // 11:35 PM (see the mc-sync note). scoring_engine.load_data() reads all four screener
    // sources directly from the DB and nothing re-syncs any of them in-process anymore
    // (2026-08-04: removed the redundant re-syncs from quant-eod-sync/stock-scoring — see
    // trendlyne-screener-sync and mc-sync's notes) — every sync's ordering ahead of
    // ml-daily-ops/stock-scoring is load-bearing now, not just this one.
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

  const trendlyneScreenerSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_TRENDLYNE_SCREENER_SYNC,
    jobName: 'trendlyne-screener-sync',
    // 6:10 PM IST (12:40 UTC) weekdays — between et-marketstats-sync (6:00 PM) and mc-sync
    // (6:20 PM). New 2026-08-04: this membership sync previously had NO dedicated schedule —
    // it only ran as a side effect of quant-eod-sync (10:00 PM) and stock-scoring's
    // syncAndScore() (10:30 PM), both of which also redundantly re-synced MC/ETnow a 2nd/3rd
    // time that same evening. Removing those two call sites (job-timing audit) meant Trendlyne
    // screener membership needed its own slot here, alongside its MC/ETnow/ET-marketstats
    // siblings, instead of being left in the 10:00/10:30 PM slot.
    repeat: { pattern: '40 12 * * 1-5' },
    jobId: 'trendlyne-screener-sync-repeatable',
    removeOnComplete: 5,
    removeOnFail: 3,
    processor: processTrendlyneScreenerSync,
    monitorName: 'trendlyne-screener-sync',
    concurrency: 1,
    // Hundreds of screeners sequentially (fetch + 500ms rate-limit delay each) — same order of
    // magnitude runtime as mc-sync/etnow-sync's own sequential per-screener sync.
    lockDuration: 90 * 60 * 1000,
    lockRenewTime: 15 * 60 * 1000,
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

  return { stockScoring, mcScreenerSync, etnowScreenerSync, etMarketstatsSync, trendlyneScreenerSync, fundamentalsSync, quantScoring };
}
