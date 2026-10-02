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
import { dbGet, dbRun } from '../dbAsync';

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
 * logical trading date (or — on an exchange HOLIDAY weekday, when technical_signals never
 * writes the day — the calendar day the ranking was generated on, bounded by an age check;
 * session-matching path keeps the original 6h bound). Today's date is taken from
 * technical_signals (written by ml-daily-ops and the technical scanner), NOT
 * date.today(), so a Friday-evening server in any TZ still matches the platform's own
 * trading-day notion. If the gate still fails AFTER the poll-wait in
 * processRecommendationsDigest below, the digest records a FAILED verdict whose message
 * names the gate — there is nothing wrong with the digest; its INPUT never became ready —
 * instead of sending a stale ranking with no marker at all.
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
    const ageMs = Date.now() - new Date(ur.generated_at.endsWith('Z') ? ur.generated_at : ur.generated_at + 'Z').getTime();
    if (!(ageMs >= 0)) return false;
    // Calendar-today path (2026-09-22): on a holiday there is no technical_signals row for
    // the day, so MAX(date) stays at the last session (D-1) while closed-day-early-batch's
    // morning ranker run legitimately stamps generated_at with calendar day D — judging that
    // only against sig.d failed the gate on every holiday (and, symmetrically, a weekday
    // whose technical-scan write was missing failed a genuinely fresh evening rank).
    // Generated-on-today bounded by <24h is sufficient: nothing but the ranker writes this table.
    const istToday = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (ur.d === istToday) return ageMs < 24 * 60 * 60 * 1000;
    // Session-match path: the newest rank belongs to the platform's current trading date AND
    // is recent enough to be this evening's run, not yesterday's (6h, as before).
    if (ur.d !== sig?.d) return false;
    return ageMs < 6 * 60 * 60 * 1000;
  } catch (e) {
    // If the gate itself cannot run, do NOT block the digest on it — degrade to the old
    // behaviour and say so in the log. A monitoring outage must not silence the digest.
    console.warn('[QUEUE] recommendations-digest freshness gate errored, sending anyway:', (e as Error).message);
    return true;
  }
}

// The ranking a digest was built from, recorded only after a fully successful send. A server
// restart replays the closed-day batch and re-fires this job, and the scheduled 22:40 slot then
// repeats a ranking that was already delivered -- 2026-10-02 sent three digests, the last two from
// the same 14:24 ranking (AF-20261002-01). Sending identical content again carries no information.
const DIGEST_LAST_SENT_KEY = 'recommendations_digest_last_sent_ranking';

export async function processRecommendationsDigest(job?: { data?: { force?: boolean } }): Promise<void> {
  // 2026-09-22: the 17:10 UTC cron races unified-ranker's own 17:00 UTC slot BY DESIGN —
  // measured completions 17:11 / 17:21 / 17:39 / 17:42, and after a failed attempt the
  // bounded make-up (AF-20260917-20: 45min budget + 15min delay) can land around 18:18.
  // Failing the gate the instant the input isn't ready produced the recurring reds on 09-18
  // and 09-22 (the latter: the host woke from Modern Standby at 17:21:04 UTC and the gate
  // query beat the ranker's commit by seconds). Instead: POLL for freshness until the wait
  // budget expires. Waiting on the TABLE alone (not the ranker's heartbeat) is safe because
  // unified_ranker.py persists unified_recommendations in a SINGLE commit at the end of its
  // persist loop — one run is one generated_at, so a passing gate means a COMPLETE ranking,
  // never a partial one. Budget stays under this registration's lockDuration (80min) and
  // under the registry graceMinutes (17:10 + 90 = 18:40 deadline).
  const RANK_WAIT_MS = 75 * 60_000;
  const RANK_WAIT_POLL_MS = 60_000;
  const giveUpAt = Date.now() + RANK_WAIT_MS;
  let fresh = await unifiedRankingIsFresh();
  let waited = false;
  while (!fresh && Date.now() < giveUpAt) {
    if (!waited) { waited = true; console.log('[QUEUE] recommendations-digest: unified ranking not fresh yet -- waiting for unified-ranker (poll up to 75min)'); }
    await new Promise((resolve) => setTimeout(resolve, RANK_WAIT_POLL_MS));
    fresh = await unifiedRankingIsFresh();
  }
  if (!fresh) {
    const msg = `SKIPPED: unified_recommendations did not become fresh for the current `
      + `trading date within ${Math.round(RANK_WAIT_MS / 60_000)}min `
      + '(unified-ranker still running or failed — see its heartbeat; AF-20260917-20 gate)';
    console.warn('[QUEUE] recommendations-digest', msg);
    // Return the StepTracker-style verdict rather than throwing: registerRepeatableJob's
    // completed handler turns { success:false, failedSteps } into a 'failed' heartbeat whose
    // message names the gate, distinguishing "input not ready" from "nothing sent" — the same
    // surface AF-20260910-03 gave company-profiles-sync.
    return { success: false, failedSteps: [msg] } as unknown as void;
  }
  const ranking = await dbGet<{ g: string | null }>(`SELECT MAX(generated_at)::text AS g FROM unified_recommendations`);
  const rankingKey = ranking?.g ?? null;
  if (rankingKey && !job?.data?.force) {
    const last = await dbGet<{ value: string }>(`SELECT value FROM app_settings WHERE key = ?`, [DIGEST_LAST_SENT_KEY]);
    if (last?.value === rankingKey) {
      // A normal return, not a { skipped: true } marker: that would stamp no heartbeat, and on a
      // holiday evening (ranking unchanged since an earlier send) the critical job's last success
      // would sit before the 22:40 slot and raise a false "late" alert. The outcome this job
      // exists for -- this ranking is delivered -- already holds, and the key is only ever
      // written after a fully successful send, so this cannot hide an earlier failure.
      console.log(`[QUEUE] recommendations-digest: ranking ${rankingKey} was already delivered -- not re-sending`);
      return;
    }
  }
  const { sendRecommendationsDigest } = await import('../telegramRecommendations');
  const res = await sendRecommendationsDigest();
  if (!res.sent && res.picks > 0) {
    // Picks existed but Telegram rejected the send -- fail loudly so the heartbeat marks
    // it failed rather than reporting success on a digest nobody received.
    throw new Error('recommendations digest failed to send to Telegram');
  }
  if (res.sent && rankingKey) {
    await dbRun(
      `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [DIGEST_LAST_SENT_KEY, rankingKey],
    );
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
    // 5min -> 80min (2026-09-22): the processor poll-waits up to 75min for the ranker's
    // freshness gate (see processRecommendationsDigest) -- the repo convention (queues.ts
    // withJobTimeout docstring) is the self-imposed budget must stay under the Worker's
    // lockDuration so the timeout fires before stall detection. 80 > 75 and
    // jobRegistryGraceMinutesConsistency still holds: registry grace 90 >= lock 80.
    lockDuration: 80 * 60_000,
    onCompleted: () => console.log('[QUEUE] recommendations-digest sent'),
  });

  return { jobDigest, jobDigestMorning, recommendationsDigest };
}
