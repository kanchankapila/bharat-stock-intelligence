import { describe, it, expect, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return undefined;
    // trendlyne-midweek's getLastRunAt reads a bare 'YYYY-MM-DD' (no time) from
    // MIN(MAX(date)) over two DATE columns -- simulate a genuinely successful run on the
    // expected Tuesday occurrence to exercise the date-only-vs-cron-time comparison below.
    if (sql.includes('trendlyne_adv_tech_daily') || sql.includes('trendlyne_price_analysis')) {
      return { t: '2026-08-04' };
    }
    return { t: null };
  }),
  dbAll: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return [];
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
});
