import { describe, it, expect, vi } from 'vitest';

// Mutable per-test fixture so individual `it` blocks can simulate a job_heartbeat row
// without redefining the whole vi.mock factory (hoisting rules require the mock itself to
// stay static, but the closed-over object it reads can be reassigned per test).
const jobHeartbeatRows: any[] = [];

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return undefined;
    // trendlyne-midweek's getLastRunAt reads a bare 'YYYY-MM-DD' (no time) from
    // MIN(MAX(date)) over two DATE columns -- simulate a genuinely successful run on the
    // expected Tuesday occurrence to exercise the date-only-vs-cron-time comparison below.
    if (sql.includes('trendlyne_adv_tech_daily') || sql.includes('trendlyne_price_analysis')) {
      return { t: '2026-08-04' };
    }
    if (sql.includes('market_regimes')) return { t: '2026-07-05T11:12:07.704Z' };
    return { t: null };
  }),
  dbAll: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return [];
    if (sql.includes('job_heartbeat')) return jobHeartbeatRows;
    return [];
  }),
  dbRun: vi.fn(async () => {}),
}));

import { getSystemStatus } from '../routers/monitor.router';
import { MONITOR_SCRIPTS } from '../routers/monitor.router';

describe('getSystemStatus (extracted)', () => {
  it('returns one entry per MONITOR_SCRIPTS item with a runState', async () => {
    const status = await getSystemStatus();
    expect(status.length).toBe(MONITOR_SCRIPTS.length);
    for (const s of status) {
      expect(['never', 'running', 'success', 'failed', 'stale']).toContain(s.runState);
    }
  });

  it('does not permanently flag a date-only cron entry stale on the same day as its own success', async () => {
    // 2026-08-09 (Sunday) is before the NEXT Tuesday occurrence (08-11) of trendlyne-midweek's
    // '30 14 * * 2' cron -- the most recent expected occurrence is 08-04, which is exactly what
    // the mocked success date is. A date-only value compared as UTC midnight (< the cron's own
    // 14:30 UTC fire time on that same date) would incorrectly read as 'stale' forever; end-of-day
    // is the fix under test.
    const status = await getSystemStatus(new Date('2026-08-09T06:00:00Z'));
    const midweek = status.find(s => s.id === 'trendlyne-midweek');
    expect(midweek).toBeDefined();
    expect(midweek!.runState).not.toBe('stale');
  });

  // 2026-08-11: runState used to be computed purely from app_settings.monitor_<id> (rawState),
  // which only triggerScript's manual "run now" tRPC path ever writes -- a script driven by its
  // normal BullMQ schedule (regime-detector included) never touches it. That script's real
  // failures land in job_heartbeat via recordHeartbeat()/updateMonitorState() instead, a
  // completely different store this computation never consulted, so a genuinely failed
  // scheduled run always degraded to a bare 'stale' label with the real error hidden. Fixed by
  // also reading job_heartbeat.last_status/last_error.
  it('surfaces a real job_heartbeat failure as runState "failed", not just "stale" (regression 2026-08-11)', async () => {
    jobHeartbeatRows.length = 0;
    jobHeartbeatRows.push({
      job_name: 'regime-detector',
      last_status: 'failed',
      // Attempted (and failed) well after market_regimes' last real write (2026-07-05 per the
      // dbGet mock above) -- i.e. this failure is genuinely why nothing fresher landed.
      last_run_at: new Date('2026-08-11T05:00:00Z').getTime(),
      last_success_at: null,
      last_error: '[HMM] No model at .../hmm_regime.pkl — run --mode train first',
      run_count: 40,
      fail_count: 6,
    });

    const status = await getSystemStatus(new Date('2026-08-11T09:00:00Z'));
    const regime = status.find(s => s.id === 'regime-detector');
    expect(regime).toBeDefined();
    expect(regime!.runState).toBe('failed');
    expect(regime!.error).toMatch(/run --mode train first/);
  });

  it('still reports "stale" (not "failed") when job_heartbeat has no failure evidence at all', async () => {
    jobHeartbeatRows.length = 0; // no heartbeat row -- e.g. a script that never once recorded one
    const status = await getSystemStatus(new Date('2026-08-11T09:00:00Z'));
    const regime = status.find(s => s.id === 'regime-detector');
    expect(regime).toBeDefined();
    expect(regime!.runState).toBe('stale');
  });

  it('does not let a STALE prior failure (superseded by a later heartbeat-less success) mask as "failed"', async () => {
    jobHeartbeatRows.length = 0;
    jobHeartbeatRows.push({
      job_name: 'regime-detector',
      last_status: 'failed',
      // This failed attempt predates market_regimes' last real write (2026-07-05) -- a later,
      // real success happened without going through the heartbeat path again, so the failure
      // is stale evidence, not the reason for today's staleness.
      last_run_at: new Date('2026-06-01T05:00:00Z').getTime(),
      last_success_at: null,
      last_error: 'some older, since-resolved error',
      run_count: 10,
      fail_count: 1,
    });

    const status = await getSystemStatus(new Date('2026-08-11T09:00:00Z'));
    const regime = status.find(s => s.id === 'regime-detector');
    expect(regime).toBeDefined();
    expect(regime!.runState).toBe('stale');
  });
});
