import { describe, it, expect } from 'vitest';
import { JOB_REGISTRY } from '../jobRegistry';
import { MONITOR_SCRIPTS } from '../routers/monitor.router';

/**
 * These 11 ids are intentional, verified-safe overlaps, not an accidental naming clash.
 * ml-daily-ops/ml-weekly-retrain's StepTracker (jobSteps.ts) writes a job_heartbeat row per
 * sub-step (e.g. 'fii-dii-fetcher') via updateMonitorState -> recordHeartbeat, which
 * jobRegistry.ts's entries need for cron-aware lateness (see its own header comment on why).
 * MONITOR_SCRIPTS' entries of the same id (monitorScripts.ts) independently track the exact
 * same underlying script via DB-table freshness (e.g. MAX(fetched_at) FROM fii_dii_flow) and
 * app_settings state -- confirmed monitor.router.ts never calls recordHeartbeat/
 * updateMonitorState, so the two mechanisms never read or write the same row. Both were built
 * (in separate sessions/PRs) to solve the exact same false-alarm problem for these sub-steps,
 * so today's coverage is redundant but not corrupting. Only listed here, rather than allowing
 * ALL collisions, so a genuinely new/accidental clash on a different id still fails this test.
 */
const KNOWN_SAFE_OVERLAPS = new Set([
  'fii-dii-fetcher', 'finbert-scorer', 'outcome-resolver-5d', 'outcome-resolver-15d',
  'performance-tracker', 'ml-ensemble-score', 'reward-engine', 'rl-agent-update',
  'signal-type-stats', 'ml-ensemble-train', 'strategy-optimizer',
]);

describe('JOB_REGISTRY vs MONITOR_SCRIPTS', () => {
  it('has no *unexpected* job names colliding with a MONITOR_SCRIPTS id (would double-cover the same job)', () => {
    const registryNames = new Set(JOB_REGISTRY.map(j => j.jobName));
    const scriptIds = new Set<string>(MONITOR_SCRIPTS.map(s => s.id));
    const collisions = [...registryNames].filter(n => scriptIds.has(n));
    const unexpected = collisions.filter(n => !KNOWN_SAFE_OVERLAPS.has(n));
    expect(unexpected).toEqual([]);
  });

  it('does not have a KNOWN_SAFE_OVERLAPS entry that has silently stopped colliding (list gone stale)', () => {
    // If a name in the allowlist no longer collides (e.g. one side renamed it), the
    // allowlist itself is stale and should shrink -- otherwise it stops being a real check.
    const registryNames = new Set(JOB_REGISTRY.map(j => j.jobName));
    const scriptIds = new Set<string>(MONITOR_SCRIPTS.map(s => s.id));
    const stillColliding = [...KNOWN_SAFE_OVERLAPS].filter(n => registryNames.has(n) && scriptIds.has(n));
    expect(stillColliding.sort()).toEqual([...KNOWN_SAFE_OVERLAPS].sort());
  });
});
