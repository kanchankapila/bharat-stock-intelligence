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
import { isTradingHolidayToday } from '../marketStatusService';

export const QUEUE_JOB_DIGEST = 'job-digest';
export const QUEUE_JOB_DIGEST_MORNING = 'job-digest-morning';
export const QUEUE_RECOMMENDATIONS_DIGEST = 'recommendations-digest';
export const QUEUE_MORNING_BRIEF = 'morning-brief';

type DigestFailureVerdict = { success: false; failedSteps: string[] };
type DigestJobResult = DigestFailureVerdict | { skipped: true } | void;

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

export async function processRecommendationsDigest(job?: { data?: { force?: boolean } }): Promise<DigestJobResult> {
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
    return { success: false, failedSteps: [msg] };
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

/**
 * Pre-open brief (08:20 IST). Deliberately does NOT reuse `unifiedRankingIsFresh()`: that gate
 * demands a ranking generated TODAY or within 6h of the current session, which is correct for
 * the 22:40 send and structurally impossible at 08:20 — nothing re-ranks overnight, so the
 * morning brief's input is *supposed* to be last night's 22:30 ranking. What it must refuse is a
 * ranking from the session BEFORE that, i.e. the evening ranker having failed outright.
 *
 * Freshness is trading-session based, not elapsed-hour based. A Monday 08:20 send accepts
 * Friday's 22:30 ranking because Friday is still the latest completed NSE session. A seven-day
 * calendar sanity cap prevents a stale session table from blessing an arbitrarily old ranking.
 */
const MORNING_BRIEF_MAX_CALENDAR_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MORNING_BRIEF_LAST_SENT_KEY = 'morning_brief_last_sent_ranking';

export async function processMorningBrief(job?: { data?: { force?: boolean } }): Promise<DigestJobResult> {
  // A missed 08:20 slot may be replayed hours later after a restart. Once the NSE opens,
  // the prior-evening list is no longer a pre-open call and must not be sent under that label.
  const istClock = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const istToday = istClock.toISOString().slice(0, 10);
  // Catch-up jobs can run on a weekend even though the cron itself is weekday-only. A known
  // exchange holiday is likewise not a pre-open session. Keep expected closed days as a skip,
  // not a failed delivery; the shared worker leaves the heartbeat untouched for {skipped:true}.
  if (istClock.getUTCDay() === 0 || istClock.getUTCDay() === 6) {
    console.log('[QUEUE] morning-brief skipped — no NSE session on the weekend');
    return { skipped: true };
  }
  const knownHoliday = await dbGet<{ is_holiday: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM market_holidays WHERE exchange = 'NSE' AND date = ?) AS is_holiday`,
    [istToday],
  );
  if (knownHoliday?.is_holiday || await isTradingHolidayToday()) {
    console.log('[QUEUE] morning-brief skipped — NSE trading holiday');
    return { skipped: true };
  }
  const istMinutes = istClock.getUTCHours() * 60 + istClock.getUTCMinutes();
  if (istMinutes >= 9 * 60 + 15) {
    const msg = 'SKIPPED: market open has passed; pre-open brief cannot be sent after 09:15 IST';
    console.warn('[QUEUE] morning-brief', msg);
    return { success: false, failedSteps: [msg] };
  }
  const ur = await dbGet<{ g: string | null; d: string | null }>(
    `SELECT MAX(generated_at)::text AS g,
            (MAX(generated_at) AT TIME ZONE 'Asia/Kolkata')::date::text AS d
       FROM unified_recommendations`);
  // Missing or untrustworthy ranking is a message to the user, not a silent failed job: a
  // degraded brief says so, instead of leaving "no ranking" indistinguishable from "no trade".
  let degradedReason: string | null = null;
  if (!ur?.g || !ur.d) {
    degradedReason = 'no ranking available — unified_recommendations is empty';
    console.warn('[QUEUE] morning-brief degraded:', degradedReason);
  }
  // MAX across independently written EOD tables prevents one stale source from blessing an
  // older ranking; excluding today avoids treating a partially written morning as completed.
  const session = degradedReason ? undefined : await dbGet<{ d: string | null }>(
    `SELECT MAX(d)::text AS d
       FROM (
         SELECT MAX(date)::date AS d FROM nse_universe_history
          WHERE date < (now() AT TIME ZONE 'Asia/Kolkata')::date
         UNION ALL
         SELECT MAX(date)::date AS d FROM stock_ohlcv
          WHERE date < (now() AT TIME ZONE 'Asia/Kolkata')::date
         UNION ALL
         SELECT MAX(date)::date AS d FROM technical_signals
          WHERE date < (now() AT TIME ZONE 'Asia/Kolkata')::date
       ) completed_sessions`);
  const rankingKey = ur?.g ?? `empty:${istToday}`;
  const ageMs = ur?.g ? Date.now() - new Date(ur.g.endsWith('Z') ? ur.g : `${ur.g}Z`).getTime() : NaN;
  // Two legitimate inputs, mirroring unifiedRankingIsFresh's two paths:
  //  (a) session-match — the evening rank stamped with the latest COMPLETED session's date
  //      (this is the Monday→Friday case the docstring calls out), or
  //  (b) calendar-today — an early-morning ranker run that legitimately stamps today's date
  //      before the session's EOD tables land (2026-10-14 07:11 IST rank stamped 2026-10-14
  //      while the latest completed session was still 2026-10-13). Judging (b) only against
  //      session.d skipped the brief on every such morning; the 7-day cap still guards staleness.
  //  (c) a ranking dated on a non-trading day BETWEEN the latest completed session and today. The
  //      gate's purpose is refusing a ranking from the session BEFORE the latest completed one, so
  //      the predicate is session.d <= ranking.d <= today (IST date strings sort lexically), which
  //      subsumes (a) and (b). 2026-10-21: Dussehra (10-20, an NSE holiday) ranked at 07:30 IST, so
  //      ranking.d 10-20 matched neither the completed session 10-19 nor today, and the first morning
  //      after a mid-week holiday got no brief. A null session keeps the old behaviour (only
  //      calendar-today passes). Mirrored by `morning-brief-delivery` in dataQualityChecks.ts.
  const rankingIsCurrent = ur?.d != null
    && (ur.d === istToday || (!!session?.d && ur.d >= session.d && ur.d <= istToday));
  if (!degradedReason && (!(ageMs >= 0) || ageMs > MORNING_BRIEF_MAX_CALENDAR_AGE_MS || !rankingIsCurrent)) {
    degradedReason = `ranking session ${ur?.d} matches neither the latest completed NSE `
      + `session ${session?.d ?? 'unknown'} nor calendar-today ${istToday} (age `
      + `${Math.round(ageMs / 3_600_000)}h) — the latest session has no completed unified `
      + 'ranking; see unified-ranker heartbeat';
    console.warn('[QUEUE] morning-brief degraded:', degradedReason);
  }
  // Same recurrence this queue already has a ledger row for (AF-20261002-01): a server restart
  // replays the boot catch-up and re-fires this job, and re-sending an identical brief carries
  // no information. Its OWN key — sharing recommendations-digest's would make the evening send
  // suppress the morning one, which is the entire point of having both.
  if (!job?.data?.force) {
    const last = await dbGet<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = ?`, [MORNING_BRIEF_LAST_SENT_KEY]);
    if (last?.value === rankingKey) {
      console.log(`[QUEUE] morning-brief: ranking ${rankingKey} already briefed — not re-sending`);
      return;
    }
  }
  const { sendMorningBrief } = await import('../morningBrief');
  const res = await (degradedReason ? sendMorningBrief('degraded', degradedReason) : sendMorningBrief());
  if (!res.sent) throw new Error('morning brief failed to send to Telegram');
  await dbRun(
    `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [MORNING_BRIEF_LAST_SENT_KEY, rankingKey],
  );
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

  // The pre-open stock-recommendation send the evening digest cannot be (see processMorningBrief).
  // 02:50 UTC = 08:20 IST — after job-digest-morning's 08:15 slot so the two Telegram sends do
  // not land in the same minute, and 55 min before the 09:15 open. Mon-Fri only: there is no
  // session to brief for on a weekend.
  const morningBrief = await registerRepeatableJob({
    connection,
    queueName: QUEUE_MORNING_BRIEF,
    jobName: 'morning-brief-daily',
    repeat: { pattern: '50 2 * * 1-5' },
    jobId: 'morning-brief-daily-repeatable',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processMorningBrief,
    monitorName: 'morning-brief',
    concurrency: 1,
    lockDuration: 5 * 60_000,
    onCompleted: () => console.log('[QUEUE] morning-brief sent'),
  });

  return { jobDigest, jobDigestMorning, recommendationsDigest, morningBrief };
}
