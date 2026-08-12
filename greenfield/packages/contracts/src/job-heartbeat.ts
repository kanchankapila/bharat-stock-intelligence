// "The heartbeat writer must accept only 'succeeded'. Enforce this in the
// writer itself, not in each job's handler." (BUILD_STAGE_0_2_SPEC.md Task
// 1.3) -- and recurring-bugs.md documents FIVE separate recurrences of a skip
// path being stamped as success in the predecessor system.
//
// Rather than a separately-mutated `job_heartbeat` table (a second summary
// that can drift from the truth, exactly the "mutable history" failure class
// GREENFIELD_STOCK_ANALYSIS_ARCHITECTURE.md's mistake #4 names), heartbeat
// state is DERIVED from the append-only ingestion_run history. There is
// nothing to "accept skipped into" because there is no separate write path
// at all -- the derivation itself is the enforcement.
export interface RunRecord {
  status: 'succeeded' | 'failed' | 'skipped' | 'degraded' | 'running';
  startedAt: string; // ISO timestamp
}

export function lastSuccessAt(runs: readonly RunRecord[]): string | null {
  const successTimes = runs
    .filter((r) => r.status === 'succeeded')
    .map((r) => r.startedAt);
  if (successTimes.length === 0) return null;
  return successTimes.reduce((max, t) => (t > max ? t : max));
}
