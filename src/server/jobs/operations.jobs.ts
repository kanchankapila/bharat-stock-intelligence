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
import { retryOnConnectionError } from '../localServiceRetry';
import { shouldSkipOnTradingHoliday } from '../marketStatusService';
import { StepTracker } from '../jobSteps';

export const QUEUE_RESEARCH_PREMARKET = 'research-premarket';
export const QUEUE_RESEARCH_POSTCLOSE = 'research-postclose';
export const QUEUE_OUTCOME_RESOLVER   = 'outcome-resolver';
export const QUEUE_ONTOLOGY_REFRESH   = 'ontology-refresh';
export const QUEUE_STUCK_SIGNAL_RESOLVER = 'stuck-signal-resolver';

/**
 * Resolve outcomes at the given horizon. Prefer the in-process ml-api HTTP call (:8000),
 * but if it is unreachable fall back to spawning outcome_resolver.py directly — the
 * resolver is self-contained (connects straight to Postgres via db_compat), so resolution
 * must NOT silently no-op just because ml-api happens to be down.
 *
 * THROWS when the fallback fails too (2026-09-04). It used to .catch(console.error) there, which
 * meant "ml-api is down AND the fallback is broken" — i.e. nothing resolved this horizon at all —
 * returned normally and left every caller reporting success. Both callers already handle a throw:
 * queues.ts's processMlDailyOps wraps these in T.run/T.fail, and processOutcomeResolver below now
 * does too, so raising here surfaces the failure without aborting the sibling horizons.
 */
export async function resolveOutcomesResilient(horizon: number): Promise<void> {
  try {
    await pythonApi.resolveOutcomes(horizon);
  } catch (e) {
    // A client timeout leaves the server-side run going; a fallback would be a second resolver
    // on the same rows (AF-20260930-29). Only an unreachable/erroring ml-api gets the fallback.
    if ((e as { code?: string }).code === 'ECONNABORTED') {
      throw new Error(`resolve-outcomes(${horizon}) timed out client-side; still running in ml-api, not duplicated`);
    }
    console.warn(`[API] resolve-outcomes(${horizon}) failed, falling back to runPython:`, (e as Error).message);
    await runPython('outcome_resolver.py', ['--horizon', String(horizon)], 180_000);
  }
}

async function processResearchPremarket(_job: Job): Promise<{ success: boolean; skipped?: boolean }> {
  const { generateDailyReport } = await import('../researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'PRE_MARKET');
  return { success: true };
}

async function processResearchPostclose(_job: Job): Promise<{ success: boolean; skipped?: boolean }> {
  const { generateDailyReport } = await import('../researchEngine');
  const today = new Date().toISOString().split('T')[0];
  await generateDailyReport(today, 'POST_CLOSE');
  return { success: true };
}

async function processOutcomeResolver(job: Job): Promise<{ success: boolean; skipped?: boolean; failedSteps?: string[] }> {
  // 2026-08-06: skip the standalone 09:30 IST trigger on a trading holiday -- closed-day-early-
  // batch already dispatches a 'closed-day-early'-named run at ~07:10 IST that morning.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] outcome-resolver skipped — trading holiday (closed-day-early-batch already ran this morning)');
    return { success: true, skipped: true };
  }
  // Every step below is best-effort but no longer silent: two of them used to end in
  // .catch(console.warn/error), and the three resolveOutcomesResilient() calls swallowed their
  // own fallback failure internally, so this job reported success even when nothing resolved.
  const T = new StepTracker('outcome-resolver');
  // Flag bad-print OHLCV bars first so outcome labels skip them (ohlcv_quality.is_suspect).
  await runPython('ohlcv_quality.py', ['--no-ingest'], 180_000)
    .catch(e => T.fail('ohlcv_quality', e));

  // 5d/15d are real registered monitor ids (jobRegistry.ts, monitorScripts.ts) fed by BOTH this
  // job and ml-daily-ops, so T.run writes their true per-horizon state -- exactly as
  // queues.ts's processMlDailyOps already does. 1d has no monitor id of its own, so it stays
  // quiet and surfaces only through this job's verdict (same as queues.ts:1111).
  await T.runQuiet('outcome-resolver-1d', () => resolveOutcomesResilient(1));
  await T.run('outcome-resolver-5d', () => resolveOutcomesResilient(5));
  await T.run('outcome-resolver-15d', () => resolveOutcomesResilient(15));

  // Now a windowed batch-resolve (was per-row N+1, routinely blew the old 180s
  // timeout on any real backlog) — give it real headroom.
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(err => T.fail('live_screener_resolver', err));

  // Grades market_decision_event (the ranker's decision contracts) into market_decision_outcome.
  // Had no caller until 2026-09-30. ~2k decisions/day x 3 horizons; a first live run took <1 min.
  await runPython('decision_outcome_resolver.py', [], 10 * 60_000)
    .catch(err => T.fail('decision_outcome_resolver', err));

  const verdict = T.finish();
  return { success: verdict.ok, failedSteps: verdict.failedSteps };
}

export const QUEUE_CHATBOT_REINGEST = 'chatbot-reingest';

/**
 * Re-embeds the chatbot's ChromaDB index from Postgres.
 *
 * app.py's POST /ingest has carried the docstring "called by nightly BullMQ job" since it was
 * written, and NO SUCH JOB EXISTED -- grepping every .ts in src/server for the endpoint, the
 * word ingest, or port 8001 found only the frontend's StockChatbot.tsx talking to the service
 * directly. app.py's startup path only ingests when the chroma_store directory is EMPTY, so
 * the index was written exactly once and then frozen.
 *
 * Measured 2026-08-16, every embedding in the store was created 2026-06-20 -- ~8 weeks stale:
 *
 *   collection               indexed   live table rows   newest embedding
 *   news_articles              1,000            55,230   2026-06-20
 *   screener_descriptions      1,521             2,539   2026-06-20
 *   stock_profiles             2,366             2,366   2026-06-20
 *
 * The news collection is the worst of the three: a RAG index whose entire value is recency,
 * holding 1.8% of the articles and nothing newer than June. Nothing was broken in a way any
 * monitor could see -- the store is populated, the service answers, the tests pass.
 *
 * run_full_ingest upserts per collection (see ingest.py's news_articles note), so this is an
 * incremental refresh, not a full re-embed every night.
 */
const CHATBOT_BASE =
  process.env.CHATBOT_URL ?? `http://127.0.0.1:${process.env.CHATBOT_PORT ?? 8001}`;

async function processChatbotReingest(_job: Job) {
  const res = await retryOnConnectionError(
    () => fetch(`${CHATBOT_BASE}/ingest`, { method: 'POST' }), { label: 'chatbot /ingest' });
  if (!res.ok) {
    // Thrown, not logged-and-swallowed: a chatbot that is down must surface as a failed job
    // rather than a silent success, which is how this went unnoticed for eight weeks.
    throw new Error(`chatbot /ingest returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  console.log('[QUEUE] chatbot-reingest done', body);
  return body;
}

export async function registerOperationsJobs(connection: any) {
  const chatbotReingest = await registerRepeatableJob({
    connection,
    queueName: QUEUE_CHATBOT_REINGEST,
    jobName: 'chatbot-reingest-daily',
    // 20:00 UTC / 01:30 IST — after stock-scoring (17:00 UTC) and ml-daily-ops have written the
    // day's scores, so the embedded stock profiles carry that day's numbers rather than
    // yesterday's. Every day, not 1-5: news_articles accrues on weekends too.
    repeat: { pattern: '0 20 * * *' },
    jobId: 'chatbot-reingest-repeatable',
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    processor: processChatbotReingest,
    monitorName: 'chatbot-reingest',
    concurrency: 1,
    // Embedding thousands of documents on CPU is slow; well above the observed full-ingest time.
    lockDuration: 30 * 60 * 1000,
  });

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
    // outcome-resolver-5d/-15d are written by processOutcomeResolver's own StepTracker now, per
    // horizon and per outcome (2026-09-04). They used to be stamped HERE, blanket 'success' on
    // any completion -- so a run where resolveOutcomesResilient(5) failed outright still marked
    // outcome-resolver-5d green, the same false-healthy shape as the skip-as-success class.
    //
    // 'performance-tracker' was stamped here too and is now dropped entirely: this job never
    // runs performance_tracker.py (only ml-daily-ops does, queues.ts:1130), so both the success
    // AND failure stamps were reporting on work that happens in a different job. The test suite
    // already encodes that -- monitorScriptsGraceMinutesConsistency's `driving` map lists
    // ml-daily-ops as performance-tracker's sole source.
    onFailed: (err: any) => {
      updateMonitorState('outcome-resolver-5d', 'failed', err.message);
      updateMonitorState('outcome-resolver-15d', 'failed', err.message);
    },
  });

  // The semantic identity/contract layer (market_issuer .. market_graph_edge, kg_*,
  // market_data_contract, semantic_feature_definition) had writers but no schedule, so its nine
  // freshness checks sat on "not materialized yet" every day since 2026-09-25. ~2 min, DB only.
  const ontologyRefresh = await registerRepeatableJob({
    connection,
    queueName: QUEUE_ONTOLOGY_REFRESH,
    jobName: 'ontology-refresh-daily',
    // 21:50 UTC / 03:20 IST — nse_stocks (the identity master) has settled; 21:30 is data-quality-daily.
    repeat: { pattern: '50 21 * * *' },
    jobId: 'ontology-refresh-repeatable',
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
    processor: async () => {
      await runPython('ontology_refresh.py', [], 20 * 60_000);
      return { success: true };
    },
    monitorName: 'ontology-refresh',
    concurrency: 1,
    lockDuration: 25 * 60 * 1000,
  });

  // Close published unified_signals by first target/stop touch or the source's expiry window
  // (AF-20261001-37). The job keeps its original identity for schedule/heartbeat continuity;
  // signal_lifecycle.py handles both path-based exits and time-based expiry. The older
  // resolve_stuck_unified_signals.py repair script is a one-off backfill, not the live lifecycle.
  //
  // 20:30 UTC = 02:00 IST next day, after ml-daily-ops (13:20 UTC) has finished its
  // outcome work and after confluence-outcomes (15:40 UTC): this resolves STATUS on the signal
  // rows, which is independent of outcome grading but must not compete with it for the table.
  // --max-age-days 90 (the script's own default) keeps the LATERAL scan off the ~26k historical
  // rows that are legitimately still open; the pre-existing backlog was cleared once by hand.
  const stuckSignalResolver = await registerRepeatableJob({
    connection,
    queueName: QUEUE_STUCK_SIGNAL_RESOLVER,
    jobName: 'stuck-signal-resolver',
    repeat: { pattern: '30 20 * * 1-5' },
    jobId: 'stuck-signal-resolver',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: async () => {
      await runPython('signal_lifecycle.py', [], 30 * 60_000);
      return { success: true };
    },
    monitorName: 'stuck-signal-resolver',
    concurrency: 1,
    lockDuration: 45 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
  });

  return { researchPremarket, researchPostclose, outcomeResolver, chatbotReingest, ontologyRefresh, stuckSignalResolver };
}
