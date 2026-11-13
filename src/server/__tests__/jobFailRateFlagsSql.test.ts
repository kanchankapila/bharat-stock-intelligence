import { describe, it, expect, beforeEach } from 'vitest';

// AF-20261113-21: the digest's runtime-health SQL itself, run against the test schema (the
// jobWatchdog.test.ts cases mock dbAll, so they never execute it). Rows are seeded with explicit
// ran_at so each case is a real history.
const { getJobFailRateFlags } = await import('../jobWatchdog');
const { dbRun } = await import('../dbAsync');

const P = 'zzfrtest-';
async function seed(job: string, runs: Array<[string, number]>) {
  for (const [status, hoursAgo] of runs) {
    await dbRun(
      `INSERT INTO job_run_history (job_name, status, ran_at) VALUES (?, ?, now() - (? || ' hours')::interval)`,
      [P + job, status, String(hoursAgo)],
    );
  }
}
const flagsFor = async (job: string) => (await getJobFailRateFlags()).filter(f => f.includes(P + job));

describe('getJobFailRateFlags (real SQL)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM job_run_history WHERE job_name LIKE '${P}%'`);
  });

  it('flags a weekday job below the 5-run floor whose last two runs failed a day apart', async () => {
    await seed('weekday', [['success', 96], ['success', 72], ['failed', 48], ['failed', 24]]);
    const f = await flagsFor('weekday');
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('failed its last 2 runs');
  });

  it('does not count a retry burst inside one incident as two failed runs', async () => {
    await seed('burst', [['success', 72], ['success', 48], ['failed', 0.2], ['failed', 0.1]]);
    expect(await flagsFor('burst')).toEqual([]);
  });

  it('does not flag a job below the floor whose latest run recovered', async () => {
    await seed('recovered', [['success', 72], ['failed', 48], ['failed', 24], ['success', 1]]);
    expect(await flagsFor('recovered')).toEqual([]);
  });

  it('keeps the 25% rule for a job with 5 or more runs', async () => {
    await seed('frequent', [['success', 6], ['failed', 5], ['success', 4], ['failed', 3], ['success', 2], ['success', 1]]);
    const f = await flagsFor('frequent');
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('latest run recovered; 2/6');
  });

  it('ignores a job with a single run in the window', async () => {
    await seed('single', [['failed', 2]]);
    expect(await flagsFor('single')).toEqual([]);
  });
});
