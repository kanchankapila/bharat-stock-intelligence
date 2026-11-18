import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The real SQL of recPlanAlerts / planEvents against the vitest throwaway schema (column types from
 * db/schema.postgres.sql). The mocked tests beside them could not see either defect:
 *  - STRONG_BUY plans (the highest conviction) were excluded by `rec_type = 'BUY'`;
 *  - `record_date LIKE ...` on a DATE column raises in Postgres, and fetchPlanEvents' callers swallow
 *    the error, so every plan silently showed no ex-date tag.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('planAlertsAndEventsDb.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('../telegramService', () => ({
  sanitizeMarkdown: (s: string) => s,
  telegramService: { sendMarkdownMessage: mockSend },
}));
const { dbRun } = await import('../dbAsync');
const { checkRecPlanHits } = await import('../recPlanAlerts');
const { fetchPlanEvents } = await import('../planEvents');

const NOW = new Date('2026-11-19T06:00:00Z'); // 11:30 IST

describe('recPlanAlerts SQL (AF-20261117-15)', () => {
  beforeEach(async () => {
    mockSend.mockReset();
    await dbRun(`DELETE FROM "${SCHEMA}".recommendation_log WHERE symbol IN ('SBUY', 'PBUY')`);
    await dbRun(`DELETE FROM "${SCHEMA}".intraday_ohlcv WHERE symbol IN ('SBUY', 'PBUY')`);
  });

  it('alerts a STRONG_BUY plan as well as a BUY plan', async () => {
    await dbRun(
      `INSERT INTO "${SCHEMA}".recommendation_log
         (symbol, rec_type, signal_date, generated_at, timeframe, source, status, entry_price, stop_loss, target_1)
       VALUES ('SBUY', 'STRONG_BUY', '2026-11-18', now(), 'swing', 't', 'ACTIVE', 100, 95, 110),
              ('PBUY', 'BUY',        '2026-11-18', now(), 'swing', 't', 'ACTIVE', 100, 95, 110)`);
    await dbRun(
      `INSERT INTO "${SCHEMA}".intraday_ohlcv (symbol, datetime, open, high, low, close, volume, interval)
       VALUES ('SBUY', '2026-11-19T04:00:00Z', 96, 97, 94, 96, 10, '15m'),
              ('PBUY', '2026-11-19T04:00:00Z', 96, 97, 94, 96, 10, '15m')`);
    mockSend.mockResolvedValue(true);
    const res = await checkRecPlanHits(NOW);
    expect(res.alerted).toBe(2);
    expect(String(mockSend.mock.calls[0][0])).toContain('SBUY');
  });
});

describe('fetchPlanEvents SQL (AF-20261117-14)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".stock_corporate_action_history WHERE symbol = 'EVT'`);
  });

  it('reads a DATE record_date and tags the ex-date inside the plan window', async () => {
    await dbRun(
      `INSERT INTO "${SCHEMA}".stock_corporate_action_history (symbol, action_type, event_key, record_date)
       VALUES ('EVT', 'dividend', 'k1', '2026-11-24'), ('EVT', 'split', 'k2', '2026-12-15')`);
    const events = await fetchPlanEvents([{ symbol: 'EVT', validUntil: '2026-11-28' }], NOW);
    expect(events.get('EVT')).toEqual(['Ex-dividend 24 Nov']);
  });
});
