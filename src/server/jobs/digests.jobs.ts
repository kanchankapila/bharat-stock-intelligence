/**
 * Telegram notification digest jobs (daily job-health digest, daily stock-recommendation
 * digest), migrated out of queues.ts's initQueues() as the eighth slice of the queues.ts
 * decomposition (see CLAUDE.md architecture review, Phase 3 — earlier slices: screeners.jobs.ts,
 * agents.jobs.ts, operations.jobs.ts, sync.jobs.ts, dl.jobs.ts, trendlyneWeekly.jobs.ts).
 *
 * Both queues were originally local `const`s inside initQueues() (not module-level `export
 * let`s like every other job in this file) — nothing outside initQueues() ever referenced
 * them, confirmed via a full-repo grep before migrating, so this module doesn't need to
 * export a registration result back into queues.ts's module-level bindings the way earlier
 * slices did; the caller can discard registerDigestJobs()'s return value if it has no use
 * for the live Queue/Worker instances.
 */
import { buildDailyDigest } from '../jobWatchdog';
import { telegramService } from '../telegramService';
import { registerRepeatableJob } from './registerJob';

export const QUEUE_JOB_DIGEST = 'job-digest';
export const QUEUE_RECOMMENDATIONS_DIGEST = 'recommendations-digest';

async function processJobDigest(): Promise<void> {
  const digest = await buildDailyDigest();
  const ok = await telegramService.sendMarkdownMessage(digest);
  if (!ok) {
    // Same reasoning as processRecommendationsDigest below: a swallowed Telegram failure here
    // would let job_heartbeat mark this critical daily digest 'success' on a send nobody received.
    throw new Error('job digest failed to send to Telegram');
  }
}

async function processRecommendationsDigest(): Promise<void> {
  const { sendRecommendationsDigest } = await import('../telegramRecommendations');
  const res = await sendRecommendationsDigest();
  if (!res.sent && res.picks > 0) {
    // Picks existed but Telegram rejected the send -- fail loudly so the heartbeat marks
    // it failed rather than reporting success on a digest nobody received.
    throw new Error('recommendations digest failed to send to Telegram');
  }
}

export async function registerDigestJobs(connection: any) {
  const jobDigest = await registerRepeatableJob({
    connection,
    queueName: QUEUE_JOB_DIGEST,
    jobName: 'job-digest-daily',
    repeat: { pattern: '20 17 * * *' }, // 10:50 PM IST (17:20 UTC), covers daily post-market jobs
    jobId: 'job-digest-daily-repeatable',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processJobDigest,
    monitorName: 'job-digest',
    concurrency: 1,
    // No lockDuration previously -- fell back to BullMQ's 30s default while
    // buildDailyDigest() aggregates job_heartbeat status across every registered job.
    lockDuration: 5 * 60_000,
    onCompleted: () => console.log('[QUEUE] job-digest sent'),
  });

  // Second daily send (added 2026-09-02, user request: digest morning AND night). 02:45 UTC =
  // 08:15 IST, pre-open — reports what changed overnight (post-close jobs, catch-ups) before
  // the trading day starts. Same queue/processor as the night send; its OWN monitorName so
  // job_heartbeat tracks each schedule separately (one heartbeat row cannot serve two crons
  // without lateness detection reading the wrong boundary). A separate repeatable jobId so
  // BullMQ keeps both schedules independently.
  const jobDigestMorning = await registerRepeatableJob({
    connection,
    queueName: QUEUE_JOB_DIGEST,
    jobName: 'job-digest-morning',
    repeat: { pattern: '45 2 * * *' }, // 08:15 IST (02:45 UTC)
    jobId: 'job-digest-morning-repeatable',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processJobDigest,
    monitorName: 'job-digest-morning',
    concurrency: 1,
    lockDuration: 5 * 60_000,
    onCompleted: () => console.log('[QUEUE] job-digest (morning) sent'),
  });

  const recommendationsDigest = await registerRepeatableJob({
    connection,
    queueName: QUEUE_RECOMMENDATIONS_DIGEST,
    jobName: 'recommendations-digest-daily',
    // 10:40 PM IST (17:10 UTC), Mon-Fri -- scheduled after unified-ranker
    // ('0 17 * * 1-5' = 22:30 IST) so it reads that day's freshly-built ranking
    repeat: { pattern: '10 17 * * 1-5' },
    jobId: 'recommendations-digest-daily-repeatable',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processRecommendationsDigest,
    monitorName: 'recommendations-digest',
    concurrency: 1,
    lockDuration: 5 * 60_000,
    onCompleted: () => console.log('[QUEUE] recommendations-digest sent'),
  });

  return { jobDigest, jobDigestMorning, recommendationsDigest };
}
