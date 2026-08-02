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
import { isMarketOpen } from '../marketStatusService';
import { registerRepeatableJob } from './registerJob';
import { makeConnection } from '../queues';

export const QUEUE_CONFLUENCE_COMPUTE = 'confluence-compute';
export const QUEUE_CONFLUENCE_OUTCOMES = 'confluence-outcomes';

async function processConfluenceCompute(_job: Job): Promise<{ computed: number; elite: number; strong: number }> {
  // Positional signal (whole-universe, heavy). Skip during market hours so it doesn't compete with
  // the intraday pipeline for CPU/DB — its consumers (positional dashboards + the post-close
  // unified_ranker) don't need intraday freshness. The pre-open compute carries through the session
  // and the 30-min cadence resumes after close. Returning normally keeps the heartbeat fresh.
  if (await isMarketOpen()) {
    console.log('[QUEUE] confluence-compute skipped — market hours (positional signal runs off-hours)');
    return { computed: 0, elite: 0, strong: 0 };
  }
  const { computeConfluenceSignals, runMLProbabilityOverlay } = await import('../confluenceEngine');
  const result = await computeConfluenceSignals();
  runMLProbabilityOverlay().catch((err: any) =>
    console.warn('[CONFLUENCE] ML overlay failed (non-blocking):', err?.message ?? err)
  );
  return result;
}

async function processConfluenceOutcomes(_job: Job): Promise<void> {
  // Sequential, not Promise.all: confluence_ml_engine --train is CPU-heavy (multiprocessing)
  // and the old concurrent 120s budget both starved the tracker AND timeout-killed the
  // trainer (its real runtime is several minutes) — 10 of its last 11 runs failed this way.
  // Per-step .catch keeps a failure in one from aborting the other.
  await runPython('confluence_outcome_tracker.py', [], 5 * 60_000)
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
    // 11:30 PM IST (18:00 UTC). Moved off 11:00 PM (2026-07-31) so it no longer shares a
    // slot with quant-scoring; the evening tail is now one job per 30 min.
    repeat: { pattern: '0 18 * * 1-5' },
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
