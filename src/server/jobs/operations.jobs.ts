/**
 * Research-report and outcome-resolution jobs, migrated out of queues.ts's initQueues() as
 * the third slice of the queues.ts decomposition (see CLAUDE.md architecture review, Phase 3
 * — earlier slices: screeners.jobs.ts, agents.jobs.ts).
 *
 * resolveOutcomesResilient() lives here (not duplicated) even though queues.ts's own
 * processMlDailyOps() also calls it — that function stays in queues.ts (its StepTracker-driven
 * ~500-line body is out of scope for this slice), so queues.ts imports this helper back from
 * here rather than the reverse, keeping the dependency graph one-directional
 * (queues.ts -> jobs/*.jobs.ts, never back).
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (researchPremarketQueue, outcomeResolverQueue, ...) — research.router.ts imports
 * researchPremarketQueue/researchPostcloseQueue directly (statically), and
 * monitor.router.ts's queue-health dashboard reaches into all three — so this module only
 * owns the *registration logic*.
 */
import { Job } from 'bullmq';
import { runPython } from '../pythonRunner';
import { pythonApi } from '../pythonApi';
import { updateMonitorState } from '../monitoringService';
import { registerRepeatableJob } from './registerJob';

export const QUEUE_RESEARCH_PREMARKET = 'research-premarket';
export const QUEUE_RESEARCH_POSTCLOSE = 'research-postclose';
export const QUEUE_OUTCOME_RESOLVER   = 'outcome-resolver';

/**
 * Resolve outcomes at the given horizon. Prefer the in-process Python API (port 8002),
 * but if it is unreachable fall back to spawning outcome_resolver.py directly — the
 * resolver is self-contained (connects straight to SQLite), so resolution must NOT
 * silently no-op just because the AlphaQuant service happens to be down.
 */
export async function resolveOutcomesResilient(horizon: number): Promise<void> {
  try {
    await pythonApi.resolveOutcomes(horizon);
  } catch (e) {
    console.warn(`[API] resolve-outcomes(${horizon}) failed, falling back to runPython:`, (e as Error).message);
    await runPython('outcome_resolver.py', ['--horizon', String(horizon)], 180_000)
      .catch(err => console.error(`[QUEUE] outcome_resolver.py fallback(${horizon}) failed:`, (err as Error).message));
  }
}

async function processResearchPremarket(_job: Job): Promise<{ success: boolean }> {
  const { generateDailyReport } = await import('../researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'PRE_MARKET');
  return { success: true };
}

async function processResearchPostclose(_job: Job): Promise<{ success: boolean }> {
  const { generateDailyReport } = await import('../researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'POST_CLOSE');
  return { success: true };
}

async function processOutcomeResolver(_job: Job): Promise<{ success: boolean }> {
  // Flag bad-print OHLCV bars first so outcome labels skip them (ohlcv_quality.is_suspect).
  await runPython('ohlcv_quality.py', ['--no-ingest'], 180_000)
    .catch(e => console.warn('[QUEUE] ohlcv_quality flag failed:', (e as Error).message));

  await resolveOutcomesResilient(1);
  await resolveOutcomesResilient(5);
  await resolveOutcomesResilient(15);

  // Now a windowed batch-resolve (was per-row N+1, routinely blew the old 180s
  // timeout on any real backlog) — give it real headroom.
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(err => console.error('[QUEUE] live_screener_resolver.py failed:', err.message));

  return { success: true };
}

export async function registerOperationsJobs(connection: any) {
  const researchPremarket = await registerRepeatableJob({
    connection,
    queueName: QUEUE_RESEARCH_PREMARKET,
    jobName: 'research-premarket-daily',
    repeat: { pattern: '0 3 * * 1-5' },
    jobId: 'research-premarket-repeatable',
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    processor: processResearchPremarket,
    monitorName: 'research-premarket',
    concurrency: 1,
    lockDuration: 15 * 60 * 1000,
    // Preserves the original '[QUEUE] research-premarket done' text (the standard helper logs
    // '... completed' instead) as an additional line rather than changing established log text.
    onCompleted: () => console.log('[QUEUE] research-premarket done'),
  });

  const researchPostclose = await registerRepeatableJob({
    connection,
    queueName: QUEUE_RESEARCH_POSTCLOSE,
    jobName: 'research-postclose-daily',
    repeat: { pattern: '45 10 * * 1-5' },
    jobId: 'research-postclose-repeatable',
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    processor: processResearchPostclose,
    monitorName: 'research-postclose',
    concurrency: 1,
    lockDuration: 15 * 60 * 1000,
    onCompleted: () => console.log('[QUEUE] research-postclose done'),
  });

  const outcomeResolver = await registerRepeatableJob({
    connection,
    queueName: QUEUE_OUTCOME_RESOLVER,
    jobName: 'outcome-resolver-daily',
    repeat: { pattern: '0 4 * * 1-5' },
    jobId: 'outcome-resolver-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processOutcomeResolver,
    monitorName: 'outcome-resolver',
    concurrency: 1,
    // processOutcomeResolver's worst case: 180s (ohlcv_quality) + 3x resolveOutcomesResilient
    // (each up to 180s fallback, on top of its own pythonApi call) + 1200s
    // (live_screener_resolver) -- comfortably over 30 min, well past the previous 10-min
    // lockDuration that caused "job stalled" failures (2026-07-04).
    lockDuration: 45 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
    // outcome-resolver-daily also drives 3 downstream monitor ids that have no BullMQ queue of
    // their own (they're graded as part of this job, not separately scheduled).
    onCompleted: () => {
      updateMonitorState('outcome-resolver-5d', 'success');
      updateMonitorState('outcome-resolver-15d', 'success');
      updateMonitorState('performance-tracker', 'success');
    },
    onFailed: (err: any) => {
      updateMonitorState('outcome-resolver-5d', 'failed', err.message);
      updateMonitorState('outcome-resolver-15d', 'failed', err.message);
      updateMonitorState('performance-tracker', 'failed', err.message);
    },
  });

  return { researchPremarket, researchPostclose, outcomeResolver };
}
