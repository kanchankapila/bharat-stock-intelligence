/**
 * Confluence-engine jobs (compute, outcomes), migrated out of queues.ts's initQueues() as the
 * ninth slice of the queues.ts decomposition (see CLAUDE.md architecture review, Phase 3 —
 * earlier slices: screeners.jobs.ts, agents.jobs.ts, operations.jobs.ts, sync.jobs.ts,
 * dl.jobs.ts, trendlyneWeekly.jobs.ts, digests.jobs.ts).
 *
 * Both jobs originally called makeConnection() fresh for the Queue AND separately for the
 * Worker (two distinct connection-options objects), unlike every other job in this file, which
 * shares one `connection` object across all Queue/Worker pairs. makeConnection() is a plain
 * factory returning a fresh options object each call (not a live connection itself — BullMQ
 * opens its own ioredis connection per Queue/Worker regardless), so this module passes one
 * makeConnection() result through registerRepeatableJob() for both Queue and Worker construction
 * — functionally equivalent connection settings, just one shared options object instead of two.
 * makeConnection() itself stays in queues.ts (it's also used for the module's startup probe and
 * the shared `connection` every other job uses) and is imported back from there.
 *
 * confluence-compute's original completed handler had no console.log (only recordHeartbeat) —
 * registerRepeatableJob() always logs `[QUEUE] <name> completed`, so this migration adds one
 * additional log line on success. Cosmetic only: no stored data, monitor state, or scheduling
 * behavior changes.
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (confluenceComputeQueue, confluenceOutcomesQueue) — monitor.router.ts's queue-health
 * dashboard imports those exact bindings directly, so this module only owns the registration
 * logic.
 */
import { Job } from 'bullmq';
import { runPython } from '../pythonRunner';
import { isMarketOpen, shouldSkipOnTradingHoliday } from '../marketStatusService';
import { registerRepeatableJob } from './registerJob';
import { StepTracker } from '../jobSteps';
import { dbGet } from '../dbAsync';
import { makeConnection } from '../queues';

export const QUEUE_CONFLUENCE_COMPUTE = 'confluence-compute';
export const QUEUE_CONFLUENCE_OUTCOMES = 'confluence-outcomes';

/**
 * True during the hours where re-running the whole-universe confluence compute can actually see
 * different input than its last run: the evening data-landing window (screener syncs 6:00-6:40 PM
 * -> ml-daily-ops 7:30 PM -> stock-scoring/quant-scoring/confluence-outcomes 10:30 PM-11:30 PM ->
 * dl-inference chain-triggered right after dl-feature-refresh (typically well before 11:30 PM,
 * see dl.jobs.ts) -> screener-performance 2:30 AM) plus a short pre-open refresh window
 * ahead of unified-ranker (7:30 AM). Outside these hours (~00:00-06:00, ~08:00-17:00 IST on a
 * trading day) every upstream table (technical_signals, screener tables, stock_scores,
 * quant_scores) is provably static until the next landing event, so recomputing this "whole-
 * universe, heavy" signal on an unchanged input is pure waste, not a safety margin.
 *
 * Added 2026-08-04 (job-timing audit): this job's 30-min cadence + market-hours skip alone left
 * ~15-17 nightly ticks (roughly 00:30-08:00 IST) recomputing frozen data every single night.
 */
export function isConfluenceComputeWindow(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const hour = ist.getUTCHours();
  return (hour >= 17 && hour <= 23) || hour === 6 || hour === 7;
}


/**
 * Whether to actually compute, given the clock and an explicit force flag.
 *
 * The window gate stays the default -- outside IST 06-07 / 17-23 the engine's inputs are
 * provably static and recomputing is waste. But the gate alone leaves no way to CATCH UP after
 * a window is missed, and a missed window is routine: a deploy, a restart, or a maintenance
 * pause all skip one, after which confluence_signals ages from its healthy ~9h maximum to ~22h
 * and the critical freshness check pages until the next window opens hours later.
 *
 * Guards on `=== true` rather than truthiness: job data round-trips through Redis as JSON, so a
 * stray `force: "false"` or `force: 0` must not silently defeat the gate.
 */
export function shouldComputeConfluence(
  opts: { now?: Date; force?: unknown } = {},
): boolean {
  if (opts.force === true) return true;
  return isConfluenceComputeWindow(opts.now ?? new Date());
}

/**
 * Whether the newest `confluence_signals` row predates the last compute window that has ALREADY
 * FULLY PASSED — i.e. a scheduled window produced no write (host asleep, deploy, restart) and the
 * table is overdue for a catch-up. Keys on the artifact's own age against a window boundary, not a
 * fixed duration: a fixed threshold cannot separate a missed morning (8.5h old at 08:03 IST) from a
 * healthy pre-evening gap (legitimately 9.5h old at 16:59 IST), so only "did the last elapsed window
 * write?" is decidable. Mirrors pg-backup's `_catch_up_due` (AF-20261015-08) — a schedule-window
 * guard must pair with an overdue catch-up keyed on the artifact, and still refuse market hours
 * (processConfluenceCompute's `isMarketOpen()` guard runs first, so this is only ever asked with the
 * market closed, and only out-of-window, so it can never compete with the intraday pipeline).
 *
 * Windows are IST: morning [06:00,08:00), evening [17:00,24:00).
 *   - IST 08:00–17:00 → the morning window has passed; expect a row from >= 06:00 IST today.
 *   - IST 00:00–06:00 → the evening window has passed; expect a row from >= 17:00 IST yesterday.
 *   - IST 06:00–08:00 / 17:00–24:00 → a window is still open, so `shouldComputeConfluence` is
 *     already true and this is never asked; returns false there (the window itself will write).
 *
 * Found 2026-10-17: the host slept 01:00–08:03 IST, entirely covering the morning window. Every
 * out-of-window tick skipped, nothing set `force`, and `confluence_signals` reached 15h stale —
 * critical `confluence-signals-freshness` FAILed with no recovery until 17:00 IST.
 */
export function isConfluenceOverdue(newestComputedAt: Date | null, now = new Date()): boolean {
  if (!newestComputedAt) return true;   // table empty → compute (aggregate MAX() is NULL, not missing)
  const IST_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_MS);
  const h = ist.getUTCHours();
  const istMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  let windowStartIstAsUtc: number;
  if (h >= 8 && h < 17)       windowStartIstAsUtc = istMidnight + 6 * 60 * 60 * 1000;  // morning 06:00 IST
  else if (h < 6)             windowStartIstAsUtc = istMidnight - 7 * 60 * 60 * 1000;  // evening 17:00 IST y'day
  else                        return false;                                            // window still open
  return newestComputedAt.getTime() < windowStartIstAsUtc - IST_MS;
}

/**
 * Overdue catch-ups per stale artifact. `isConfluenceOverdue` keys on the newest row, so a compute
 * that exits 0 but writes nothing leaves it overdue and, at the 30-min cadence, the whole-universe
 * job would re-run ~17x a day outside its window (it ran 0x before the catch-up existed). Allow
 * CONFLUENCE_CATCHUP_MAX_ATTEMPTS forced runs per distinct newest value -- enough to ride out a
 * transient failure (~1.5h of retries), not a loop. A write moves the newest row, which is a new key
 * and so a fresh budget; a process restart also resets it, which only ever grants a few more tries.
 * pg-backup's `_catch_up_due` has no counter: it is bounded by launches (pm2 start / one nightly
 * cron_restart), not ticks, so a per-tick job needs the explicit limit.
 */
export const CONFLUENCE_CATCHUP_MAX_ATTEMPTS = 3;
let catchupAttempts = { key: '', count: 0 };
export function resetConfluenceCatchupAttempts(): void { catchupAttempts = { key: '', count: 0 }; }

export async function processConfluenceCompute(job: Job): Promise<{ computed: number; elite: number; strong: number; skipped?: boolean }> {
  // Positional signal (whole-universe, heavy). Skip during market hours so it doesn't compete with
  // the intraday pipeline for CPU/DB — its consumers (positional dashboards + the post-close
  // unified_ranker) don't need intraday freshness. The pre-open compute carries through the session
  // and the 30-min cadence resumes after close.
  //
  // These return `skipped: true` so registerJob.ts declines to stamp a heartbeat. They previously
  // returned a bare zero-result to "keep the heartbeat fresh", which meant a genuine failure inside
  // the work window was overwritten by the next out-of-window skip within 30 minutes — on a job
  // marked critical. Lateness across the (long) skip window is handled by this job's
  // lateDeadlineCronPatterns in jobRegistry.ts, not by faking a success here.
  if (await isMarketOpen()) {
    console.log('[QUEUE] confluence-compute skipped — market hours (positional signal runs off-hours)');
    return { computed: 0, elite: 0, strong: 0, skipped: true };
  }
  if (!shouldComputeConfluence({ force: (job?.data as any)?.force })) {
    // The window guard alone can't express "catch up after a missed window", and a missed window
    // is routine: a host sleep, a deploy or a restart silently loses one. On 2026-10-17 the host
    // slept 01:00–08:03 IST straight through the morning window, so confluence_signals reached
    // 15h stale and the critical confluence-signals-freshness check FAILed until 17:00 IST. Before
    // giving up, ask whether the artifact itself says the last elapsed window produced no write.
    // market guard above already ran, so this only ever fires with the market closed.
    const row = await dbGet<{ newest: Date | null }>('SELECT MAX(computed_at) AS newest FROM confluence_signals');
    if (!isConfluenceOverdue(row?.newest ?? null)) {
      console.log('[QUEUE] confluence-compute skipped — outside the evening-landing/pre-open window (inputs are static)');
      return { computed: 0, elite: 0, strong: 0, skipped: true };
    }
    const key = String(row?.newest?.getTime() ?? 'empty');
    if (catchupAttempts.key !== key) catchupAttempts = { key, count: 0 };
    if (catchupAttempts.count >= CONFLUENCE_CATCHUP_MAX_ATTEMPTS) {
      console.log(`[QUEUE] confluence-compute skipped — overdue catch-up already attempted ${catchupAttempts.count}x without a new write`);
      return { computed: 0, elite: 0, strong: 0, skipped: true };
    }
    catchupAttempts.count++;
    console.log('[QUEUE] confluence-compute FORCED — no write in the last elapsed window (overdue catch-up)');
  }
  if ((job?.data as any)?.force === true && !isConfluenceComputeWindow()) {
    console.log('[QUEUE] confluence-compute FORCED outside its window — catch-up for a missed window');
  }
  const { computeConfluenceSignals, runMLProbabilityOverlay } = await import('../confluenceEngine');
  const result = await computeConfluenceSignals();
  runMLProbabilityOverlay().catch((err: any) =>
    console.warn('[CONFLUENCE] ML overlay failed (non-blocking):', err?.message ?? err)
  );
  return result;
}

async function processConfluenceOutcomes(job: Job): Promise<{ success: boolean; skipped?: boolean; failedSteps?: string[]; monitorAlreadyRecorded?: boolean } | void> {
  // 2026-08-06: skip entirely on a trading holiday, no morning replacement -- confluence
  // outcomes/reliability are graded against price action that didn't happen (exchange never
  // opened), and confluence_ml_engine --train would just refit on an unchanged dataset.
  // Deliberately does NOT return { skipped: true } (unlike processConfluenceCompute above):
  // getLateJobs() is not holiday-aware, so see HOLIDAY_SKIP_NOTE at the foot of this file.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] confluence-outcomes skipped — trading holiday, nothing new to grade');
    return { success: true, skipped: true };
  }
  // Sequential, not Promise.all: confluence_ml_engine --train is CPU-heavy (multiprocessing)
  // and the old concurrent 120s budget both starved the tracker AND timeout-killed the
  // trainer (its real runtime is several minutes) — 10 of its last 11 runs failed this way.
  // Per-step .catch keeps a failure in one from aborting the other.
  // Was 5 min -- job-runtime-audit (2026-08-14) found this budget had been blown every single
  // scheduled run for 11 consecutive days as stock_ohlcv's unbounded full-table OHLCV load grew
  // past what any fixed budget survives. Fixed the query to bound by date (confluence_outcome_
  // tracker.py), but the first catch-up run against the 11-day backlog still took 17m24s
  // (652,679 outcomes tracked) -- bumped to 20 min for real headroom against a normal day's
  // incremental volume plus margin, matching the "give real headroom" precedent already used for
  // alphaQuant's own daily scoring job (see alphaQuantClient.ts).
  // Per-step .catch keeps a failure in one from aborting the other -- but it used to end in
  // console.warn, so both could fail and this job still reported success. T.fail preserves the
  // don't-abort-the-sibling property and degrades the job verdict.
  const T = new StepTracker('confluence-outcomes');
  // 20 -> 40 min (2026-10-02, measured). Killed at exactly its own 1200000ms cap on 2026-10-01
  // ("Timed out after 1200000ms"), and a standalone run measured **1144.2s = 19.1 min** to
  // complete -- a **56-second margin**, i.e. the budget was already inside the runtime's own
  // variance and could only ever pass on a fully idle box. The workload grows daily (it loads an
  // OHLCV cache "date >= 2026-07-02" -- 158,062 closing prices over 2,415 symbols on the measured
  // run, and that window keeps widening), so this is recurring-bugs.md's budget-sized-once-never-
  // revisited class. 40 min = the measured 19.1 min plus ~2x contention headroom for an evening
  // run; deliberately NOT "just over 20", since a completed measurement is a floor for a
  // monotonically growing input, not a ceiling.
  await runPython('confluence_outcome_tracker.py', [], 40 * 60_000)
    .catch(e => T.fail('confluence_outcome_tracker', e));
  await runPython('confluence_ml_engine.py', ['--train'], 15 * 60_000)
    .catch(e => T.fail('confluence_ml_engine_train', e));
  const verdict = T.finish();
  return { success: verdict.ok, failedSteps: verdict.failedSteps,
    monitorAlreadyRecorded: verdict.monitorAlreadyRecorded };
}

export async function registerConfluenceJobs() {
  const compute = await registerRepeatableJob({
    connection: makeConnection(),
    queueName: QUEUE_CONFLUENCE_COMPUTE,
    jobName: 'confluence-compute',
    repeat: { every: 30 * 60 * 1000 },
    // No jobId in the original registration -- do not invent one; the repeatable-cleanup loop
    // still matches by jobName.
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processConfluenceCompute,
    monitorName: 'confluence-compute',
    concurrency: 1,
    // No lockDuration previously -- fell back to BullMQ's 30s default despite this
    // in-process computation running across the whole stock universe every 30 minutes.
    lockDuration: 10 * 60_000,
    suppressLockErrors: true,
  });

  const outcomes = await registerRepeatableJob({
    connection: makeConnection(),
    queueName: QUEUE_CONFLUENCE_OUTCOMES,
    jobName: 'confluence-outcomes-daily',
    // 9:10 PM IST (15:40 UTC), Mon-Fri after quant scoring
    repeat: { pattern: '40 15 * * 1-5' },
    // No jobId in the original registration -- see the note on confluence-compute above.
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processConfluenceOutcomes,
    monitorName: 'confluence-outcomes',
    concurrency: 1,
    // lockDuration must exceed the processor's sequential runs (tracker + 15min trainer); the
    // BullMQ default 30s lock marked every real run "stalled more than allowable limit".
    // The comment previously read "5min tracker + 15min trainer = 20min worst case" -- already
    // stale before this pass, since the tracker's budget was 20 min, not 5.
    // 25 -> 70 min (2026-10-02): tracker 20 -> 40 (measured 19.1 min standalone, was being killed
    // at 20) plus the 15-min trainer = 55 min of step budget, so the lock must exceed that. Left at
    // 25 it would have expired inside the tracker step and BullMQ would re-deliver a HEALTHY job
    // into a concurrent double execution -- the same invariant enforced for screener-performance
    // (AF-20260912-16). +15 over the sum, matching the margin convention used there.
    lockDuration: 70 * 60 * 1000,
  });

  return { compute, outcomes };
}

/**
 * HOLIDAY_SKIP_NOTE — the trading-holiday skip / heartbeat / lateness interplay, recorded so
 * the next reader doesn't re-derive it.
 *
 * registerJob.ts declines to stamp a heartbeat for any processor returning { skipped: true },
 * so a skip can never erase a real failure. processConfluenceCompute uses the marker because it
 * no-ops for ~9 hours EVERY day: a genuine failure inside its work window was being overwritten
 * by the next out-of-window skip within 30 minutes, on a job marked critical.
 *
 * A trading-holiday skip was a different risk profile, and the reason processConfluenceOutcomes'
 * holiday skip originally could NOT use the marker: with getLateJobs() holiday-blind, declining
 * the heartbeat on the ~10 NSE holidays a year would flag this job — and its identically-shaped
 * siblings processStockScoring, processMcScreenerSync, processEtnowScreenerSync,
 * processEtMarketstatsSync, processTrendlyneScreenerSync, processScreenerPerf, several of them
 * critical — as 'late' on exactly the days they are correctly idle (the phantom-alert class
 * recurring-bugs.md records 6 times).
 *
 * That blocker is RESOLVED 2026-09-14: jobHeartbeat.ts's getRecentTradingSessions()/
 * computeCronLateness() now judge the occurrence's IST date against the exchange's own session
 * record (stock_ohlcv sessions + a technical_signals probe for the ambiguous newest-session-to-
 * today band + the live holiday feed for today) and forgive weekday-only jobs on proven closed
 * days — gated so 24/7 cadences and weekend-anchored weekly jobs can never be pardoned
 * (src/server/__tests__/holidayLatenessForgiveness.test.ts pins every rule). Which is why the
 * holiday skip above now safely returns { success: true, skipped: true }: the declined heartbeat
 * leaves a provable-idle day behind, not a false 'late'.
 *
 * The one bounded trade-off that remains: a REAL failure landing on the holiday slot itself is
 * only surfaced from the next real session's occurrence (≤1 day), because a skip still erases
 * the failure's verdict for that one occurrence — the same erasure-window bound this note has
 * always recorded, now the only inaccuracy left standing.
 */
