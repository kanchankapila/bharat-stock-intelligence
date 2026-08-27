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

async function processConfluenceCompute(_job: Job): Promise<{ computed: number; elite: number; strong: number; skipped?: boolean }> {
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
  if (!isConfluenceComputeWindow()) {
    console.log('[QUEUE] confluence-compute skipped — outside the evening-landing/pre-open window (inputs are static)');
    return { computed: 0, elite: 0, strong: 0, skipped: true };
  }
  const { computeConfluenceSignals, runMLProbabilityOverlay } = await import('../confluenceEngine');
  const result = await computeConfluenceSignals();
  runMLProbabilityOverlay().catch((err: any) =>
    console.warn('[CONFLUENCE] ML overlay failed (non-blocking):', err?.message ?? err)
  );
  return result;
}

async function processConfluenceOutcomes(job: Job): Promise<void> {
  // 2026-08-06: skip entirely on a trading holiday, no morning replacement -- confluence
  // outcomes/reliability are graded against price action that didn't happen (exchange never
  // opened), and confluence_ml_engine --train would just refit on an unchanged dataset.
  // Deliberately does NOT return { skipped: true } (unlike processConfluenceCompute above):
  // getLateJobs() is not holiday-aware, so see HOLIDAY_SKIP_NOTE at the foot of this file.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] confluence-outcomes skipped — trading holiday, nothing new to grade');
    return;
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
  await runPython('confluence_outcome_tracker.py', [], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] confluence_outcome_tracker failed:', (e as Error).message));
  await runPython('confluence_ml_engine.py', ['--train'], 15 * 60_000)
    .catch(e => console.warn('[QUEUE] confluence_ml_engine --train failed:', (e as Error).message));
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
    // lockDuration must exceed the processor's now-sequential runs (5min tracker +
    // 15min trainer = 20min worst case); the BullMQ default 30s lock marked every
    // real run "stalled more than allowable limit"
    lockDuration: 25 * 60 * 1000,
  });

  return { compute, outcomes };
}

/**
 * HOLIDAY_SKIP_NOTE — why processConfluenceOutcomes does NOT return { skipped: true }.
 *
 * registerJob.ts now declines to stamp a heartbeat for any processor returning that marker, so a
 * skip can no longer erase a real failure. processConfluenceCompute uses it because it no-ops for
 * ~9 hours EVERY day: a genuine failure inside its work window was being overwritten by the next
 * out-of-window skip within 30 minutes, on a job marked critical.
 *
 * A trading-holiday skip is a different risk profile and must NOT be converted piecemeal.
 * getLateJobs() has no holiday awareness, so declining the heartbeat on the ~10 NSE holidays a
 * year would flag this job — and its identically-shaped siblings processStockScoring,
 * processMcScreenerSync, processEtnowScreenerSync, processEtMarketstatsSync,
 * processTrendlyneScreenerSync, processScreenerPerf, several of them critical — as 'late' on
 * exactly the days they are correctly idle. That is the phantom-alert class recurring-bugs.md
 * records 6 times, so it would trade one recurring bug for another.
 *
 * The correct order is: make getLateJobs() holiday-aware, THEN convert all of these together.
 * Until then they stamp success on a holiday skip, which is a known, bounded inaccuracy — the
 * erasure window is one holiday landing directly after a failed run, not 30 minutes every day.
 */
