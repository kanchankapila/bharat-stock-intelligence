import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  columns: [{ column_name: 'job_name' }, { column_name: 'last_alert_sent_at' }],
  exec: vi.fn(async () => {}),
  txRun: vi.fn(async (_sql: string) => ({ changes: 0, lastInsertRowid: 0 })),
  transaction: vi.fn(),
}));
vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async (sql: string) => sql.includes('information_schema.columns') ? mocks.columns : []),
  dbRun: vi.fn(async () => ({})),
  dbExec: mocks.exec,
  dbTransaction: mocks.transaction,
}));
vi.mock('../jobRegistry', () => ({ JOB_REGISTRY: [], HOLIDAY_ACTIVE_JOB_NAMES: new Set() }));
vi.mock('../monitorScripts', () => ({ MONITOR_SCRIPTS: [] }));
vi.mock('../dataQualityChecks', () => ({ DATA_QUALITY_CHECKS: [], tradingDaysStale: () => 0 }));
vi.mock('../marketStatusService', () => ({ isTradingHolidayToday: async () => false }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.columns = [{ column_name: 'job_name' }, { column_name: 'last_alert_sent_at' }];
  mocks.transaction.mockImplementation(async (fn: any) => fn({ run: mocks.txRun }));
});

describe('heartbeat schema readiness without backup-blocking DDL', () => {
  it('issues no DDL when the live schema already has the alert column', async () => {
    const { wasAlreadyAlerted } = await import('../jobHeartbeat');
    expect(await wasAlreadyAlerted('schema-control', new Date())).toBe(false);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('bounds genuine legacy repair in one transaction and tolerates a concurrent repair', async () => {
    mocks.columns = [{ column_name: 'job_name' }];
    const { wasAlreadyAlerted } = await import('../jobHeartbeat');
    await wasAlreadyAlerted('schema-control', new Date());
    const sql = mocks.txRun.mock.calls.map(args => String(args[0]));
    expect(sql[0]).toContain("lock_timeout = '2s'");
    expect(sql[1]).toContain("statement_timeout = '5s'");
    expect(sql[2]).toMatch(/ALTER TABLE job_heartbeat ADD COLUMN IF NOT EXISTS last_alert_sent_at/);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('creates a missing table with the complete contract, without a redundant ALTER', async () => {
    mocks.columns = [];
    const { wasAlreadyAlerted } = await import('../jobHeartbeat');
    await wasAlreadyAlerted('schema-control', new Date());
    const sql = mocks.txRun.mock.calls.map(args => String(args[0]));
    expect(sql.some(s => s.includes('CREATE TABLE IF NOT EXISTS job_heartbeat'))).toBe(true);
    expect(sql.some(s => s.includes('ALTER TABLE'))).toBe(false);
  });

  it('retries readiness after a bounded repair fails instead of caching false success', async () => {
    mocks.columns = [{ column_name: 'job_name' }];
    mocks.transaction.mockRejectedValueOnce(new Error('lock timeout control'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { wasAlreadyAlerted } = await import('../jobHeartbeat');
      await wasAlreadyAlerted('schema-control', new Date());
      await wasAlreadyAlerted('schema-control', new Date());
      expect(mocks.transaction).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});
