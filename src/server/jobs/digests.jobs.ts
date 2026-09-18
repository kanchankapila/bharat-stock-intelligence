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
import { dbGet } from '../dbAsync';

export const QUEUE_JOB_DIGEST = 'job-digest';
export const QUEUE_JOB_DIGEST_MORNING = 'job-digest-morning';
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

/**
 * AF-20260917-20: the digest's SQL reads MAX(substring(computed_at,1,10)) — whichever DATE is
 * newest in unified_recommendations, however old. The ranker (17:00 UTC) regularly finishes
 * 15-40+ min after this digest's 17:10 UTC slot (measured: 17:11:07 success stamp on 09-15,
 * 17:42:57 on 09-16, timeout 17:30+45min on 09-17), so the digest raced it by design and
 * silently shipped YESTERDAY's ranking whenever the ranker ran long or failed — exactly what
 * happened 2026-09-17 (zero 09-17 rows; digest sent anyway at 17:10).
 *
 * Gate: before sending, require that the newest unified_recommendations date is TODAY's
 * logical trading date AND was generated within the last 6 hours (a morning generated_at
 * with today's date, e.g. a closed-day-early run, is also acceptable). Today's date is taken
 * from technical_signals (written by ml-daily-ops and the technical scanner), NOT
 * date.today(), so a Friday-evening server in any TZ still matches the platform's own
 * trading-day notion. If the gate fails, the digest records a SKIP (heartbeat 'success' with
 * the reason — there is nothing wrong with the digest; its INPUT is not ready) instead of
 * sending a stale ranking with no marker at all.
 */
async function unifiedRankingIsFresh(): Promise<boolean> {
  try {
    const ur = await dbGet<{ generated_at: string; d: string }>(
      `SELECT MAX(generated_at)::text AS generated_at,
              (MAX(generated_at) AT TIME ZONE 'Asia/Kolkata')::date::text AS d
       FROM unified_recommendations`);
    if (!ur?.d || !ur.generated_at) return false;
    const sig = await dbGet<{ d: string }>(
      `SELECT MAX(date)::text AS d FROM technical_signals`);
    // Both must agree on the trading date, and the rank must be younger than 6h.
    if (ur.d !== sig?.d) return false;
    const ageMs = Date.now() - new Date(ur.generated_at.endsWith('Z') ? ur.generated_at : ur.generated_at + 'Z').getTime();
    return ageMs >= 0 && ageMs < 6 * 60 * 60 * 1000;
  } catch (e) {
    // If the gate itself cannot run, do NOT block the digest on it — degrade to the old
    // behaviour and say so in the log. A monitoring outage must not silence the digest.
    console.warn('[QUEUE] recommendations-digest freshness gate errored, sending anyway:', (e as Error).message);
    return true;
  }
}

async function processRecommendationsDigest(): Promise<void> {
  const fresh = await unifiedRankingIsFresh();
  if (!fresh) {
    const msg = 'SKIPPED: unified_recommendations does not hold a fresh ranking for the current '
      + 'trading date (unified-ranker still running or failed — see its heartbeat; AF-20260917-20 gate)';
    console.warn('[QUEUE] recommendations-digest', msg);
    // Return the StepTracker-style verdict rather than throwing: registerRepeatableJob's
    // completed handler turns { success:false, failedSteps } into a 'failed' heartbeat whose
    // message names the gate, distinguishing "input not ready" from "nothing sent" — the same
    // surface AF-20260910-03 gave company-profiles-sync.
    return { success: false, failedSteps: [msg] } as unknown as void;
  }
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
  // the trading day starts. Same processor as the night send; its OWN monitorName so
  // job_heartbeat tracks each schedule separately (one heartbeat row cannot serve two crons
  // without lateness detection reading the wrong boundary). Its OWN queue too: it shared the
  // night send's queue until 2026-09-11, and registerRepeatableJob clears every repeatable on its
  // queue before adding its own -- so this registration deleted the night schedule on every
  // boot, and the 22:50 digest only ever ran as a boot-time catch-up.
  const jobDigestMorning = await registerRepeatableJob({
    connection,
    queueName: QUEUE_JOB_DIGEST_MORNING,
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
