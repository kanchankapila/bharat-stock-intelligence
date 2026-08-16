import { updateMonitorState } from './monitoringService';

interface StepRec { name: string; ok: boolean; error?: string; ms: number; }

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
    const t0 = Date.now();
    try {
      const r = await fn();
      this.recs.push({ name: monitorName, ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      const error = (e as Error)?.message ?? String(e);
      this.recs.push({ name: monitorName, ok: false, error, ms: Date.now() - t0 });
      console.warn(`[QUEUE] ${this.jobName}:${monitorName} failed:`, error);
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
    for (const r of this.recs) updateMonitorState(r.name, r.ok ? 'success' : 'failed', r.error);

    const names = failed.map(r => r.name);
    const line = `${this.recs.length - failed.length} ok, ${failed.length} failed`
      + (failed.length ? `: ${names.join(', ')}` : '');
    console.log(`[QUEUE] ${this.jobName}: ${line}`);
    updateMonitorState(
      this.jobName,
      failed.length ? 'failed' : 'success',
      failed.length ? `${failed.length} steps failed: ${names.join(',')}` : undefined,
    );
    return { ok: failed.length === 0, failedSteps: names };
  }
}
