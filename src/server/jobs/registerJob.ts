/**
 * Shared BullMQ registration primitives, extracted out of queues.ts.
 *
 * queues.ts's initQueues() wires ~35 Queue/Worker pairs by hand, each repeating the same
 * ~15-line shape (create Queue -> clear stale repeatables -> addJobWithCatchup -> create
 * Worker -> wire completed/failed to recordHeartbeat) with only the schedule, processor, and
 * worker options actually varying. registerRepeatableJob() is that shape, parameterized, so
 * new call sites stop hand-copying it — see src/server/jobs/screeners.jobs.ts for the first
 * jobs migrated onto it. This is a mechanical extraction: same Queue name, same cron pattern,
 * same worker options, same jobId as the code it replaces — not a behavior change.
 *
 * addJobWithCatchup lives here too (moved verbatim from queues.ts) since every job registered
 * through this module needs it, and it has no dependency on anything else in queues.ts.
 */
import { Queue, Worker, Job } from 'bullmq';
import { CronExpressionParser } from 'cron-parser';
import { recordHeartbeat } from '../jobHeartbeat';

/** Standard "ignore benign lock-contention noise" filter shared by several jobs' error
 *  handlers — a stalled-lock race (-2) or "Missing lock" message isn't a real error. */
function isBenignLockError(err: any): boolean {
  return err?.code === -2 || (typeof err?.message === 'string' && err.message.includes('Missing lock'));
}

// Staggers catch-up job delays globally across every addJobWithCatchup call site (not just
// the ones going through registerRepeatableJob) so a restart doesn't fire every missed job's
// catch-up in the same instant.
const CATCHUP_STAGGER_MS = 5 * 60_000;
let _catchupSlot = 0;

/**
 * Adds a repeatable BullMQ job, replacing any existing repeatable registration for the same
 * jobId/jobName, and queues an immediate one-off "catch-up" run if the schedule's last expected
 * fire time was missed (e.g. the process was down across it) — including the case where BullMQ
 * was already holding a not-yet-fired slot whose time has since passed, which a naive
 * remove+re-add would otherwise silently forfeit (`staleNextMissed` below).
 */
export async function addJobWithCatchup(
  queue: Queue,
  jobName: string,
  data: any,
  opts: any = {}
) {
  if (opts.repeat && (opts.repeat.pattern || opts.repeat.cron) && !opts.repeat.tz) {
    opts.repeat.tz = 'Etc/UTC';
  }

  const now = Date.now();
  const repeatables = await queue.getRepeatableJobs();
  let staleNextMissed = false;
  for (const r of repeatables) {
    if (r.id === opts.jobId || r.name === jobName) {
      if (typeof r.next === 'number' && r.next < now) staleNextMissed = true;
      await queue.removeRepeatableByKey(r.key);
    }
  }

  await queue.add(jobName, data, opts);

  if (!opts.repeat || (!opts.repeat.pattern && !opts.repeat.every && !opts.repeat.cron)) {
    return;
  }

  try {
    // Regression 2026-08-29: a single combined getJobs(['completed','failed'], 0, 1) call was
    // used to find "the last run", but BullMQ interleaves statuses in that combined form in
    // whatever order it stores them, not by recency -- live for ml-weekly-retrain, it returned a
    // month-old FAILED job as "the last run" on a day the job had actually completed successfully
    // ~11 hours earlier, so every bharat-server restart concluded the weekly schedule was missed
    // and queued a redundant catch-up (three restarts in one afternoon, three catch-ups, which is
    // what starved exit_policy.py --train of its Python-subprocess slot budget). Query each status
    // separately (BullMQ returns newest-first within a single status) and take whichever of the
    // two is actually more recent -- neither a stale failure nor an absent history should shadow
    // a genuinely recent run of the other kind.
    const [completedJobs, failedJobs] = await Promise.all([
      queue.getJobs(['completed'], 0, 1, false),
      queue.getJobs(['failed'], 0, 1, false),
    ]);
    const candidateTimes = [completedJobs[0], failedJobs[0]]
      .filter((j): j is Job => Boolean(j))
      .map(j => j.finishedOn ?? j.timestamp)
      .filter((t): t is number => typeof t === 'number');
    const lastRunTime = candidateTimes.length > 0 ? Math.max(...candidateTimes) : null;

    let missed = staleNextMissed;

    if (!missed && lastRunTime) {
      if (opts.repeat.pattern || opts.repeat.cron) {
        const pattern = opts.repeat.pattern || opts.repeat.cron;
        const parserOpts: any = { currentDate: new Date(now) };
        if (opts.repeat.tz) {
          parserOpts.tz = opts.repeat.tz;
        } else {
          parserOpts.utc = true;
        }
        const interval = CronExpressionParser.parse(pattern, parserOpts);
        const prevExpected = interval.prev().getTime();

        if (lastRunTime < prevExpected && prevExpected < now) {
          missed = true;
        }
      } else if (opts.repeat.every) {
        if (now - lastRunTime > opts.repeat.every) {
          missed = true;
        }
      }
    }

    if (missed) {
      // Guard against a second restart queuing a duplicate catchup while one from an earlier
      // restart is still in flight: getJobs(['completed','failed']) above only sees FINISHED
      // work, so a still-running (active/waiting/delayed) catchup from a prior restart is
      // invisible to the "missed" check -- a second restart minutes later independently
      // concludes "missed" too and queues its own. Confirmed live 2026-08-02/03: two
      // ml-weekly-retrain catchups ~30min apart from two restarts ran concurrently, and the
      // resulting resource contention made exit_policy.py --train time out on every attempt
      // that weekend (it has no dedicated timeout headroom for two full retrains competing for
      // the same 5-concurrent-Python-subprocess cap). Same risk for every other queue this
      // helper serves, not just ml-weekly-retrain, so the guard is generic.
      // Must match on data.isCatchup, not just name -- a repeatable job's own perpetually-
      // scheduled NEXT occurrence always sits in 'delayed' with this same jobName (that's how
      // BullMQ repeatables work), so a bare name match makes `alreadyPending` true forever and
      // this guard silently swallows every real catch-up permanently. Confirmed live 2026-08-09:
      // trendlyne-ratios-monthly missed its whole Sunday run and three separate restarts each
      // logged "already active/waiting/delayed -- skipping" against nothing but its own next-
      // Sunday placeholder. Only a job actually queued via the catch-up path below carries
      // isCatchup: true, so that's the correct signal for "a catch-up from an earlier restart
      // is still in flight" -- the thing this guard was actually built to detect.
      //
      // ALSO must match a currently-ACTIVE run of this jobName even without isCatchup: true --
      // the legitimate scheduled occurrence counts too, not just a prior catch-up. Without this,
      // a restart that lands while the real run is still executing (routine for a long job like
      // ml-daily-ops, observed 13:20->22:05 UTC in production) sees no *catchup* pending, "missed"
      // stays true, and queues a duplicate that -- since these queues run at concurrency:1 --
      // waits behind the live run and then re-executes the entire chain a second time same-day.
      // Confirmed live 2026-08-19: ml-daily-ops job_heartbeat showed two runs on 2026-08-18 (a
      // success at 14:50 UTC, a failure at 22:05 UTC on nse-bhavcopy-fetcher -- the second run's
      // late-night steps hit a bhavcopy date NSE hadn't published yet), and trendlyne-midweek (a
      // Tuesday-only job) queued three separate catch-ups on a single Wednesday, each burning
      // into its own finite per-session WAF request budget against the provider.
      const inFlight = await queue.getJobs(['active', 'waiting', 'delayed'], 0, -1, false);
      const activeNow = await queue.getJobs(['active'], 0, -1, false);
      const alreadyPending =
        activeNow.some(j => j.name === jobName) ||
        inFlight.some(j => j.name === jobName && j.data?.isCatchup === true);
      if (alreadyPending) {
        console.log(
          `[QUEUE] Job ${jobName} in ${queue.name} missed its scheduled run, but an instance ` +
          `is already active/waiting/delayed -- skipping duplicate catch-up.`,
        );
      } else {
        const delay = _catchupSlot++ * CATCHUP_STAGGER_MS;
        console.log(
          `[QUEUE] Job ${jobName} in ${queue.name} missed its scheduled run. ` +
          `Catch-up queued with a ${delay / 60_000}min stagger.`,
        );
        const catchupOpts = { ...opts };
        delete catchupOpts.repeat;
        catchupOpts.jobId = `${opts.jobId || jobName}-catchup-${now}`;
        catchupOpts.delay = delay;
        await queue.add(jobName, { ...data, isCatchup: true }, catchupOpts);
      }
    }
  } catch (err) {
    console.warn(`[QUEUE] Failed to determine catch-up for ${jobName}:`, err);
  }
}

export interface RepeatableJobConfig {
  connection: any;
  queueName: string;
  /** Name of the job added to the queue (distinct from the queue name itself). */
  jobName: string;
  data?: any;
  repeat: { pattern: string } | { every: number };
  /** Optional — matches addJobWithCatchup/BullMQ's own API. A few original call sites (e.g.
   *  confluence-compute/outcomes) never set one; the repeatable-cleanup loop still matches by
   *  jobName in that case, so omitting it is safe and must not be defaulted to an invented value. */
  jobId?: string;
  removeOnComplete?: number | { age?: number; count?: number };
  removeOnFail?: number | { age?: number; count?: number };
  attempts?: number;
  backoff?: { type: string; delay: number };
  processor: (job: Job) => Promise<any>;
  /** Passed to recordHeartbeat() and used in the standard `[QUEUE] <name> completed/failed`
   *  log lines. Matches the job's id in JOB_REGISTRY / MONITOR_SCRIPTS. */
  monitorName: string;
  concurrency: number;
  lockDuration: number;
  lockRenewTime?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
  /** Optional extra logging fired after the standard completed log+heartbeat, for jobs whose
   *  original handler logged a detail from the processor's return value (e.g. agent-data-scientist's
   *  `grade`). Additive only — never replaces the standard log line or the heartbeat call. */
  onCompleted?: (result: any) => void;
  /** Same as onCompleted, fired after the standard failed log+heartbeat — for jobs whose
   *  original handler also updated other monitor ids on failure (e.g. outcome-resolver's
   *  outcome-resolver-5d/-15d/performance-tracker sub-states). Additive only. */
  onFailed?: (err: any) => void;
  /** recordHeartbeat() (job_heartbeat table, JOB_REGISTRY-driven lateness checks) by default.
   *  Several jobs instead use updateMonitorState() (monitoringService.ts, MONITOR_SCRIPTS-driven
   *  DB-freshness checks) — a genuinely different mechanism, not interchangeable, so this must be
   *  passed explicitly per job rather than defaulted or guessed. */
  monitorFn?: (name: string, status: 'success' | 'failed', detail?: string, durationMs?: number) => void;
  /** Wires the standard `.on('error', ...)` handler several jobs already had by hand: ignore
   *  benign lock-contention noise (stalled-lock race / "Missing lock"), log anything else as
   *  `[QUEUE] <monitorName> error: <message>`. Off by default — most jobs never had this handler
   *  at all, and adding it where the original had none would be a (harmless but real) behavior
   *  change: an extra 'error' listener on a Worker that previously had zero. */
  suppressLockErrors?: boolean;
}

/**
 * The standard shape repeated ~35 times in queues.ts's initQueues(): create the Queue, drop
 * any stale repeatable registration, register the (possibly-catch-up) repeatable job, create
 * the Worker, and wire completed/failed to a `[QUEUE] <name> completed/failed` log line plus
 * recordHeartbeat(). Only covers jobs using that standard pair of event handlers with no extra
 * log detail (job result fields, custom monitor mechanism, stalled/error handlers) — several
 * jobs in queues.ts (stock-refresh, ai-signals, technical-signals, nse-sync, ...) need those
 * and are not yet migrated onto this helper; do not force them through it as-is.
 */
export async function registerRepeatableJob(
  cfg: RepeatableJobConfig,
): Promise<{ queue: Queue; worker: Worker }> {
  const queue = new Queue(cfg.queueName, { connection: cfg.connection });

  const repeatables = await queue.getRepeatableJobs();
  for (const r of repeatables) {
    await queue.removeRepeatableByKey(r.key);
  }

  await addJobWithCatchup(queue, cfg.jobName, cfg.data ?? {}, {
    repeat: cfg.repeat,
    jobId: cfg.jobId,
    removeOnComplete: cfg.removeOnComplete,
    removeOnFail: cfg.removeOnFail,
    attempts: cfg.attempts,
    backoff: cfg.backoff,
  });

  // BullMQ's Worker constructor validates several of its options (observed live:
  // maxStalledCount specifically throws "must be greater or equal than 0") rather than
  // treating an explicit `undefined` the same as an omitted key and falling back to its own
  // internal default. Most callers of registerRepeatableJob don't set lockRenewTime/
  // stalledInterval/maxStalledCount at all, so passing them through unconditionally (as
  // `undefined`) broke the Worker constructor for every one of those jobs -- and because
  // this all happens inside initQueues()'s single try block, one bad Worker construction
  // took down BullMQ initialization for the ENTIRE server (confirmed live: a restart on
  // 2026-08-03 fell back to setInterval-only mode for every scheduled job, not just the
  // one whose config happened to omit these fields). Only include a key when the caller
  // actually set it, so BullMQ's own defaults apply otherwise.
  const workerOpts: any = {
    connection: cfg.connection,
    concurrency: cfg.concurrency,
    lockDuration: cfg.lockDuration,
  };
  if (cfg.lockRenewTime !== undefined) workerOpts.lockRenewTime = cfg.lockRenewTime;
  if (cfg.stalledInterval !== undefined) workerOpts.stalledInterval = cfg.stalledInterval;
  if (cfg.maxStalledCount !== undefined) workerOpts.maxStalledCount = cfg.maxStalledCount;

  const worker = new Worker(cfg.queueName, cfg.processor, workerOpts);

  const monitor = cfg.monitorFn ?? recordHeartbeat;

  worker.on('completed', (job, result) => {
    console.log(`[QUEUE] ${cfg.monitorName} completed`);
    // duration_ms (2026-09-04): BullMQ already stamps processedOn when the worker picked the
    // job up, free for the taking here -- no new bookkeeping needed.
    const durationMs = job.processedOn ? Date.now() - job.processedOn : undefined;
    // A skip is not a success: stamping one erases the day's real failures. The four jobs fixed
    // for this in 2026-08-12 each hand-rolled this guard in queues.ts's own completed handlers;
    // every job routed through THIS helper was still missing it. Skip paths return
    // { skipped: true } and must leave the heartbeat (and onCompleted's result logging) alone.
    const r = result as { skipped?: boolean; success?: boolean; failedSteps?: string[] } | null | undefined;
    if (r?.skipped) return;
    // Sibling bug, same shape (ml-promotion-gate-review, 2026-08-19): a processor that already
    // tracks its own internal steps via StepTracker and returns { success, failedSteps } (the
    // ml-daily-ops/ml-weekly-retrain pattern, hand-rolled outside this helper specifically to
    // avoid this) must not have that verdict overwritten by a blanket 'success' either -- the
    // exact ACTION_ITEMS #16 bug this repo already fixed once for those two jobs, generalized so
    // any FUTURE job wired through this shared helper doesn't have to bypass it to get the fix.
    // Strict `=== false` (not falsy) so a processor that never reports success/failedSteps at
    // all -- every existing caller, today -- keeps behaving exactly as before.
    if (r?.success === false) {
      monitor(cfg.monitorName, 'failed',
        r.failedSteps?.length ? `${r.failedSteps.length} step(s) failed: ${r.failedSteps.join(', ')}` : undefined,
        durationMs);
      cfg.onCompleted?.(result);
      return;
    }
    monitor(cfg.monitorName, 'success', undefined, durationMs);
    cfg.onCompleted?.(result);
  });
  worker.on('failed', (job, err) => {
    console.error(`[QUEUE] ${cfg.monitorName} failed:`, err?.message);
    const durationMs = job?.processedOn ? Date.now() - job.processedOn : undefined;
    monitor(cfg.monitorName, 'failed', err?.message, durationMs);
    cfg.onFailed?.(err);
  });
  if (cfg.suppressLockErrors) {
    worker.on('error', (err) => {
      if (isBenignLockError(err)) return;
      console.error(`[QUEUE] ${cfg.monitorName} error:`, err.message);
    });
  }

  return { queue, worker };
}
