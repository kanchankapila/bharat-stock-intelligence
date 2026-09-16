import { updateMonitorState } from './monitoringService';

interface StepRec { name: string; ok: boolean; error?: string; ms: number; quiet?: boolean; }

/**
 * Tracks the outcome of individual steps inside a multi-step job so a step failure is
 * surfaced instead of swallowed. Each step still runs best-effort (run() never throws, so
 * one failing step can't abort the chain), but finish() writes the *actual* per-step monitor
 * state and a job-level summary that degrades to 'failed' when any step failed — replacing the
 * old pattern where the worker's 'completed' handler blanket-marked every sub-task 'success'.
 */
export class StepTracker {
  private recs: StepRec[] = [];
  constructor(private jobName: string) {}

  /** Run one step under a monitor name, recording its outcome. Returns the step's value, or
   *  undefined if it threw (the error is captured, logged, and reported by finish()). */
  async run<T>(monitorName: string, fn: () => Promise<T>): Promise<T | undefined> {
    return this._exec(monitorName, fn, false);
  }

  /**
   * Same as run(), but does NOT write a per-step monitor heartbeat — the failure still counts
   * toward finish()'s failedSteps list and the job-level 'failed' verdict.
   *
   * This exists so that NO step failure is swallowed, which was the pre-2026-09-03 state: ~159
   * sub-steps across queues.ts and jobs/*.ts ended in `.catch(e => console.warn(...))`, so a
   * fetcher could stop writing entirely and its parent job still reported success. That is how
   * mc_index_oi_fetcher sat 3 days stale unnoticed.
   *
   * Why not just use run() for those too: getStaleJobs() (jobHeartbeat.ts) applies a generic
   * 26h-staleness warning to EVERY job_heartbeat row whose name isn't in JOB_REGISTRY /
   * MONITOR_SCRIPTS / DATA_QUALITY_CHECKS. Creating ~159 new per-step heartbeat names would
   * therefore emit a permanent flood of false STALE warnings — the exact "deleting/adding a
   * thing does not update the checks pointing at it" class that file already documents. Quiet
   * steps surface through the job's own verdict and the failed-step alert instead, which is
   * where a non-dashboarded sub-step belongs.
   */
  async runQuiet<T>(stepName: string, fn: () => Promise<T>): Promise<T | undefined> {
    return this._exec(stepName, fn, true);
  }

  /**
   * Record an already-caught step failure, for in-place conversion of the legacy
   * `.catch(e => console.warn('[QUEUE] x failed:', ...))` sites:
   *
   *     await runPython('x.py', [], 60_000).catch(e => T.fail('x', e));
   *
   * Deliberately shaped to be a drop-in replacement for the console.warn handler so the
   * surrounding control flow (await / void / chained .then) is untouched — the ONLY change is
   * that the failure now reaches finish()'s verdict instead of dying in the log. Quiet by
   * design, for the getStaleJobs() reason in runQuiet's docstring.
   */
  fail(stepName: string, e: unknown): void {
    const error = (e as Error)?.message ?? String(e);
    this.recs.push({ name: stepName, ok: false, error, ms: 0, quiet: true });
    if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
      console.warn(`[QUEUE] ${this.jobName}:${stepName} failed:`, error);
    }
  }

  private async _exec<T>(name: string, fn: () => Promise<T>, quiet: boolean): Promise<T | undefined> {
    const t0 = Date.now();
    try {
      const r = await fn();
      this.recs.push({ name, ok: true, ms: Date.now() - t0, quiet });
      return r;
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      this.recs.push({ name, ok: false, error, ms: Date.now() - t0, quiet });
      if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
        console.warn(`[QUEUE] ${this.jobName}:${name} failed:`, error);
      }
      return undefined;
    }
  }

  /** Write each tracked step's true monitor state, then a job-level summary heartbeat that
   *  is 'failed' (with the failing step names) when any step failed, else 'success'.
   *
   *  Returns that same verdict so the CALLER can report it too. The monitor state has been
   *  correct here for a while, but every processor still ended `return { success: true }`
   *  unconditionally, so a run where every Python step failed completed green at the BullMQ
   *  level while the dashboard showed it red -- two sources of truth disagreeing about the
   *  same run (ACTION_ITEMS #16). Deliberately returned rather than thrown: these are
   *  multi-hour jobs, and throwing would hand them to BullMQ's retry machinery and re-run the
   *  whole chain over one failed step. */
  finish(): { ok: boolean; failedSteps: string[] } {
    const failed = this.recs.filter(r => !r.ok);
    // Quiet steps deliberately get no per-step heartbeat (see runQuiet's docstring) but DO
    // count toward the failed list and the job-level verdict below.
    for (const r of this.recs) {
      if (!r.quiet) updateMonitorState(r.name, r.ok ? 'success' : 'failed', r.error, r.ms);
    }

    const names = failed.map(r => r.name);
    const line = `${this.recs.length - failed.length} ok, ${failed.length} failed`
      + (failed.length ? `: ${names.join(', ')}` : '');
    if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
      console.log(`[QUEUE] ${this.jobName}: ${line}`);
    }
    // Steps run sequentially (each T.run()/runQuiet() call is awaited before the next), so
    // summing their own ms is the job-level wall time for the tracked portion -- an
    // approximation (any untracked gap between steps isn't counted) but far better than the
    // NULL this row got before 2026-09-04.
    const totalMs = this.recs.reduce((sum, r) => sum + r.ms, 0);
    updateMonitorState(
      this.jobName,
      failed.length ? 'failed' : 'success',
      failed.length ? `${failed.length} steps failed: ${names.join(',')}` : undefined,
      totalMs,
    );
    return { ok: failed.length === 0, failedSteps: names };
  }
}
