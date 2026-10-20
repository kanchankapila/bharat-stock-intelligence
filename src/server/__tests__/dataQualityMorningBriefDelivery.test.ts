import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `morning-brief-delivery`: runs the check's real SQL against the vitest throwaway schema with a
 * pinned as-of instant (the SQL takes it as its only parameter, defaulting to now()). Covers the
 * part evaluate() cannot see: which trading day's brief is DUE (weekends and NSE holidays are not
 * sessions, and today's brief is not due until after the 08:20 send window), and which ranking
 * that brief would have carried.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityMorningBriefDelivery.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const KEY = 'morning_brief_last_sent_ranking';
const check = () => {
  const c = DATA_QUALITY_CHECKS.find(x => x.id === 'morning-brief-delivery');
  expect(c, 'morning-brief-delivery is registered').toBeDefined();
  return c!;
};
const asOf = (istWallClock: string) => `${istWallClock.replace(' ', 'T')}+05:30`;

async function run(istWallClock: string) {
  const row = await dbGet<Record<string, any>>(check().sql, [asOf(istWallClock)]);
  return { row, result: check().evaluate(row, new Date(asOf(istWallClock))) };
}
async function ranking(istWallClock: string) {
  await dbRun(
    `INSERT INTO "${SCHEMA}".unified_recommendations (symbol, unified_score, regime, conviction_level, computed_at, generated_at)
     VALUES ('ACME', 70, 'neutral', 'medium', ?, CAST(? AS timestamptz))`, [istWallClock, asOf(istWallClock)]);
}
async function receipt(value: string) {
  await dbRun(`INSERT INTO "${SCHEMA}".app_settings (key, value) VALUES (?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [KEY, value]);
}
// The job stores the ranking's generated_at as Postgres renders it (MAX(generated_at)::text).
const receiptOf = async (istWallClock: string) =>
  (await dbGet<{ v: string }>(`SELECT CAST(CAST(? AS timestamptz) AS text) AS v`, [asOf(istWallClock)]))!.v;
async function session(date: string) {
  await dbRun(`INSERT INTO "${SCHEMA}".nse_universe_history (date, symbol, series, close) VALUES (CAST(? AS date), 'ACME', 'EQ', 1)`, [date]);
}

describe('morning-brief-delivery (real SQL)', () => {
  beforeEach(async () => {
    for (const t of ['unified_recommendations', 'nse_universe_history', 'stock_ohlcv', 'technical_signals', 'market_holidays']) {
      await dbRun(`DELETE FROM "${SCHEMA}".${t}`);
    }
    await dbRun(`DELETE FROM "${SCHEMA}".app_settings WHERE key = ?`, [KEY]);
  });

  it("passes on Tuesday afternoon when Monday-night's ranking was briefed", async () => {
    await session('2026-10-19');
    await ranking('2026-10-19 22:30');
    await receipt(await receiptOf('2026-10-19 22:30'));
    const { row, result } = await run('2026-10-20 13:30');
    expect(row!.brief_day).toBe('2026-10-20');
    expect(result.status).toBe('pass');
  });

  it('FAILS NOT DELIVERED when the receipt is an older ranking than the one the due brief would carry', async () => {
    await session('2026-10-19');
    await ranking('2026-10-15 22:30');
    await ranking('2026-10-19 22:30');
    await receipt(await receiptOf('2026-10-15 22:30'));
    const { result } = await run('2026-10-20 13:30');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('NOT DELIVERED');
  });

  it("does not demand a brief on Saturday: the due session is Friday, whose brief carried Thursday night's ranking", async () => {
    await session('2026-10-15');
    await ranking('2026-10-15 22:30');
    await ranking('2026-10-16 22:30');
    await receipt(await receiptOf('2026-10-15 22:30'));
    const { row, result } = await run('2026-10-17 12:00');
    expect(row!.brief_day).toBe('2026-10-16');
    expect(result.status).toBe('pass');
  });

  it('does not demand a brief on a listed NSE holiday: Monday holiday means Friday is still the due session', async () => {
    await dbRun(`INSERT INTO "${SCHEMA}".market_holidays (date, exchange) VALUES (DATE '2026-10-19', 'NSE')`);
    await session('2026-10-15');
    await ranking('2026-10-15 22:30');
    await ranking('2026-10-16 22:30');
    await receipt(await receiptOf('2026-10-15 22:30'));
    const { row, result } = await run('2026-10-19 12:00');
    expect(row!.brief_day).toBe('2026-10-16');
    expect(result.status).toBe('pass');
  });

  it('a non-NSE holiday row does not suppress a session', async () => {
    await dbRun(`INSERT INTO "${SCHEMA}".market_holidays (date, exchange) VALUES (DATE '2026-10-19', 'BSE')`);
    const { row } = await run('2026-10-19 12:00');
    expect(row!.brief_day).toBe('2026-10-19');
  });

  it("today's brief is not due until the send window has closed (08:00 IST names the previous session)", async () => {
    const early = await run('2026-10-20 08:00');
    expect(early.row!.brief_day).toBe('2026-10-19');
    const late = await run('2026-10-20 09:45');
    expect(late.row!.brief_day).toBe('2026-10-20');
  });

  it('a ranking generated after the 08:20 send is not the one the brief should have carried', async () => {
    await session('2026-10-19');
    await ranking('2026-10-19 22:30');
    await ranking('2026-10-20 11:00');
    await receipt(await receiptOf('2026-10-19 22:30'));
    const { row, result } = await run('2026-10-20 13:30');
    expect(row!.ranking_at).toContain('2026-10-19');
    expect(result.status).toBe('pass');
  });

  it('FAILS DEGRADED when delivered on a ranking two sessions behind the latest completed session', async () => {
    await session('2026-10-19');
    await ranking('2026-10-14 22:30');
    await receipt(await receiptOf('2026-10-14 22:30'));
    const { result } = await run('2026-10-20 13:30');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('DEGRADED');
    expect(result.detail).not.toContain('NOT DELIVERED');
  });

  it('takes the latest completed session as the MAX over the three EOD tables, strictly before the brief day', async () => {
    await session('2026-10-19');
    await dbRun(`INSERT INTO "${SCHEMA}".nse_universe_history (date, symbol, series, close) VALUES (DATE '2026-10-20', 'ACME', 'EQ', 1)`);
    await dbRun(`INSERT INTO "${SCHEMA}".technical_signals (symbol, date) VALUES ('ACME', DATE '2026-10-18')`);
    const { row } = await run('2026-10-20 13:30');
    expect(row!.session_date).toBe('2026-10-19');
  });

  it.each(['not-a-timestamp', '2026-13-45 99:99:99', '2026-10-15'])(
    'a malformed receipt (%s) yields a clear failing verdict instead of throwing',
    async (bad) => {
      await session('2026-10-19');
      await ranking('2026-10-19 22:30');
      await receipt(bad);
      const { row, result } = await run('2026-10-20 13:30');
      expect(row!.receipt_malformed).toBe(true);
      expect(result.status).toBe('fail');
      expect(result.detail).toContain('MALFORMED RECEIPT');
      expect(result.detail).toContain(bad);
    });

  it('an empty: receipt on the brief day is a degraded delivery, not a healthy one', async () => {
    await session('2026-10-19');
    await receipt('empty:2026-10-20');
    const { result } = await run('2026-10-20 13:30');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('DEGRADED');
  });
});
