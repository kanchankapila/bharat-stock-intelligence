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
    const jobs = await queue.getJobs(['completed', 'failed'], 0, 1, false);
    const lastJob = jobs.length > 0 ? jobs[0] : null;
    const lastRunTime = lastJob?.timestamp || null;

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
  monitorFn?: (name: string, status: 'success' | 'failed', detail?: string) => void;
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

  const worker = new Worker(cfg.queueName, cfg.processor, {
    connection: cfg.connection,
    concurrency: cfg.concurrency,
    lockDuration: cfg.lockDuration,
    lockRenewTime: cfg.lockRenewTime,
    stalledInterval: cfg.stalledInterval,
    maxStalledCount: cfg.maxStalledCount,
  });

  const monitor = cfg.monitorFn ?? recordHeartbeat;

  worker.on('completed', (_job, result) => {
    console.log(`[QUEUE] ${cfg.monitorName} completed`);
    monitor(cfg.monitorName, 'success');
    cfg.onCompleted?.(result);
  });
  worker.on('failed', (_job, err) => {
    console.error(`[QUEUE] ${cfg.monitorName} failed:`, err?.message);
    monitor(cfg.monitorName, 'failed', err?.message);
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
