import { describe, it, expect, beforeEach } from 'vitest';

const { recordHeartbeat } = await import('../jobHeartbeat');
const { dbAll, dbRun } = await import('../dbAsync');

const JOB = '__test_job_run_history';

describe('recordHeartbeat appends run-level history', () => {
  beforeEach(async () => {
    await dbRun('DELETE FROM job_run_history WHERE job_name = ?', [JOB]);
    await dbRun('DELETE FROM job_heartbeat WHERE job_name = ?', [JOB]);
  });

  // job_heartbeat carries only LIFETIME counters, so a fail rate from it cannot be scoped to
  // a window -- i.e. it cannot answer "is this still failing after the fix?". Live example:
  // ml-daily-ops read 47.9% cumulative while the duplicate-catch-up bug behind most of those
  // failures had already been fixed on 2026-08-19, and the table could not say either way.
  it('writes one row per run, capturing BOTH outcomes', async () => {
    await recordHeartbeat(JOB, 'success');
    await recordHeartbeat(JOB, 'failed', 'boom');
    await recordHeartbeat(JOB, 'success');

    const rows = await dbAll<{ status: string; error: string | null }>(
      'SELECT status, error FROM job_run_history WHERE job_name = ? ORDER BY id', [JOB],
    );
    expect(rows.map(r => r.status)).toEqual(['success', 'failed', 'success']);
    // The failure's message must survive -- a history row that loses WHY is much less useful
    // than one that keeps it.
    expect(rows[1].error).toBe('boom');
    expect(rows[0].error).toBeNull();
  });

  it('supports the windowed fail-rate query the table exists for', async () => {
    await recordHeartbeat(JOB, 'failed', 'old');
    await recordHeartbeat(JOB, 'success');

    const [agg] = await dbAll<{ runs: string; fails: string }>(
      `SELECT count(*) AS runs, count(*) FILTER (WHERE status = 'failed') AS fails
         FROM job_run_history
        WHERE job_name = ? AND ran_at > now() - interval '1 hour'`, [JOB],
    );
    expect(Number(agg.runs)).toBe(2);
    expect(Number(agg.fails)).toBe(1);
  });

  it('still records the lifetime heartbeat alongside the history row', async () => {
    await recordHeartbeat(JOB, 'failed', 'x');
    const [hb] = await dbAll<{ run_count: number; fail_count: number }>(
      'SELECT run_count, fail_count FROM job_heartbeat WHERE job_name = ?', [JOB],
    );
    expect(hb.run_count).toBe(1);
    expect(hb.fail_count).toBe(1);
  });

  // 2026-09-04, scheduler-review finding: job_run_history had status + ran_at but no
  // duration, so nothing could answer "which step got slower this month" without a
  // hand-run stopwatch. duration_ms is nullable/additive -- a caller with no cheap start
  // time (the default 3-arg call) must still write a row, just with NULL duration.
  it('records duration_ms when the caller has one, and leaves it NULL when it does not', async () => {
    await recordHeartbeat(JOB, 'success', undefined, 4321);
    await recordHeartbeat(JOB, 'failed', 'boom');

    const rows = await dbAll<{ status: string; duration_ms: number | null }>(
      'SELECT status, duration_ms FROM job_run_history WHERE job_name = ? ORDER BY id', [JOB],
    );
    expect(rows[0].duration_ms).toBe(4321);
    expect(rows[1].duration_ms).toBeNull();
  });
});
