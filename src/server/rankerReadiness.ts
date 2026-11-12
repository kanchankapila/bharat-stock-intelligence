/**
 * The 22:30 IST unified-ranker reads what ml-daily-ops (technical grid, post-close scan, bhavcopy
 * reconcile, ML scoring) and quant-eod-sync (quality/crowding inputs) write. It ran on a cron
 * offset: ml-daily-ops finished after it started on 2026-10-28 and one minute before it on 11-06;
 * quant-eod-sync finished 3-8 minutes ahead. A slow night ranked on the previous session's inputs.
 * So the ranker waits, bounded, for each upstream to finish its run for today.
 */
import { dbAll } from './dbAsync';
import { JOB_REGISTRY } from './jobRegistry';

export const RANKER_UPSTREAM = ['ml-daily-ops', 'quant-eod-sync'] as const;

function dowMatches(field: string, dow: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? a === dow : dow >= a && dow <= b;
  });
}

/** Today's UTC instant of a plain "M H * * DOW" cron, or null when it does not fire today. */
export function todaysSlotMs(cron: string, now: Date): number | null {
  const [m, h, , , dow] = cron.trim().split(/\s+/);
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h) || !dowMatches(dow ?? '*', now.getUTCDay())) return null;
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(h), Number(m));
}

/** Upstream jobs due today that have not finished (heartbeat last_run_at) since today's slot. */
export function pendingUpstream(lastRunAt: Record<string, number | null | undefined>, now: Date): string[] {
  return RANKER_UPSTREAM.filter((job) => {
    const cron = JOB_REGISTRY.find((j) => j.jobName === job)?.cronPattern;
    const slot = cron ? todaysSlotMs(cron, now) : null;
    if (slot === null || now.getTime() < slot) return false;
    const last = lastRunAt[job];
    return !(last != null && last >= slot);
  });
}

/** Poll until the upstream jobs have finished today, or the wait budget runs out. Returns what is
 *  still pending, so the caller can say it ranked without them. A failed upstream run counts as
 *  finished: its heartbeat moves, and waiting longer would not change what it wrote. */
export async function waitForRankerInputs(maxWaitMs = 40 * 60_000, pollMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const rows = await dbAll<{ job_name: string; last_run_at: number | string | null }>(
      `SELECT job_name, last_run_at FROM job_heartbeat WHERE job_name IN (?, ?)`, [...RANKER_UPSTREAM]);
    const last = Object.fromEntries(rows.map((r) => [r.job_name, r.last_run_at == null ? null : Number(r.last_run_at)]));
    const pending = pendingUpstream(last, new Date());
    if (pending.length === 0 || Date.now() >= deadline) return pending;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The ranker's call site: wait, and say so when ranking without an upstream. */
export async function waitForRankerInputsLogged(): Promise<void> {
  const pending = await waitForRankerInputs();
  if (pending.length) {
    console.warn(`[QUEUE] unified-ranker: ranking WITHOUT today's ${pending.join(', ')} (not finished after 40 min)`);
  }
}
