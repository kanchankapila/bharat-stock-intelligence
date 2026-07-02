import { describe, it, expect, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return undefined;
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
});
