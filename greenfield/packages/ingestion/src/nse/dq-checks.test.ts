// Task 2.4 Verify: "each check is negative-controlled -- inject a violating
// row into a scratch database, confirm the check reports failure, remove
// it." Configurable checks (symbol-count, reject-rate, calendar-continuity)
// are negative-controlled by adjusting dq_check.spec directly -- the
// registry IS the threshold, so this is a real test of the same code path a
// production threshold change would take, not a workaround.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, closeRun, openRun } from '@greenfield/db';
import {
  checkBhavcopyFreshness,
  checkBhavcopySymbolCount,
  checkBhavcopyRejectRate,
  checkMarketBarOhlcSanity,
  checkDeliveryPctRange,
  checkCalendarContinuity,
} from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

let pool: pg.Pool;

function metrics(seen: number, accepted: number, rejected: number) {
  return { rowsSeen: seen, rowsAccepted: accepted, rowsRejected: rejected, rowsWritten: accepted, symbolsCovered: accepted, inputWatermark: null, outputWatermark: null };
}

/** Same weekday-reference logic as checkBhavcopyFreshness's SQL, so the test
 * is deterministic regardless of which real day it runs on. */
function todayRefWeekday(): string {
  const now = new Date();
  const isoDow = ((now.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun, matching ISODOW
  const d = new Date(now);
  if (isoDow === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (isoDow === 7) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ('nse', 'NSE Archives', '{}', 'none', 'permitted') ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ('nse.bhavcopy', 'nse', 'ingestion', 'fixture', 'v1') ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('nse.bhavcopy', 'dq test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`,
  );
});

afterEach(async () => {
  await pool.query(`DELETE FROM market_bar WHERE source = 'nse'`);
  await pool.query(`DELETE FROM delivery_stat WHERE source = 'nse'`);
  await pool.query(`DELETE FROM trading_session WHERE exchange = 'NSE'`);
  await pool.query(`DELETE FROM raw_object WHERE endpoint_key = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM security WHERE symbol LIKE 'ZZZDQ%'`);
  await pool.query(`DELETE FROM job_definition WHERE job_id = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM provider WHERE provider = 'nse'`);
  // Restore the registry to what migration 006 seeded, in case a test edited it.
  await pool.query(`UPDATE dq_check SET spec = '{"minSymbols": 1000, "maxSymbols": 3500}'::jsonb WHERE check_id = 'bhavcopy-symbol-count'`);
  await pool.query(`UPDATE dq_check SET spec = '{"maxRejectRate": 0.5}'::jsonb WHERE check_id = 'bhavcopy-reject-rate'`);
  await pool.query(`UPDATE dq_check SET spec = '{"maxConsecutiveWeekdayGap": 4}'::jsonb WHERE check_id = 'calendar-continuity'`);
  await pool.end();
});

test('bhavcopy-freshness: fails when stale, passes once caught up', async () => {
  const ref = todayRefWeekday();
  await pool.query(
    `INSERT INTO trading_session (exchange, session_date, open_at, close_at, is_holiday)
     VALUES ('NSE', $1::date - 10, now(), now(), false)`,
    [ref],
  );
  const stale = await checkBhavcopyFreshness(pool);
  expect(stale.status).toBe('fail');

  await pool.query(
    `INSERT INTO trading_session (exchange, session_date, open_at, close_at, is_holiday)
     VALUES ('NSE', $1::date, now(), now(), false) ON CONFLICT DO NOTHING`,
    [ref],
  );
  const fresh = await checkBhavcopyFreshness(pool);
  expect(fresh.status).toBe('info');
});

test('bhavcopy-symbol-count: warns below the registry band, passes once the band is widened', async () => {
  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status) VALUES ('ZZZDQ1', 'x', 'NSE', 'listed') ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
     VALUES ('ZZZDQ1', '2026-08-12', '1d', 'nse', 100, now(), $1)`,
    [runId],
  );
  await closeRun(client, runId, { status: 'succeeded', metrics: metrics(1, 1, 0) });
  client.release();

  const belowBand = await checkBhavcopySymbolCount(pool); // 1 symbol vs default band 1000-3500
  expect(belowBand.status).toBe('warn');

  await pool.query(`UPDATE dq_check SET spec = '{"minSymbols": 1, "maxSymbols": 3500}'::jsonb WHERE check_id = 'bhavcopy-symbol-count'`);
  const inBand = await checkBhavcopySymbolCount(pool);
  expect(inBand.status).toBe('info');
});

test('bhavcopy-reject-rate: warns over threshold, passes once the threshold is raised', async () => {
  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
  await closeRun(client, runId, { status: 'succeeded', metrics: metrics(10, 1, 9) }); // 90% rejected
  client.release();

  const overThreshold = await checkBhavcopyRejectRate(pool); // default max 0.5
  expect(overThreshold.status).toBe('warn');

  await pool.query(`UPDATE dq_check SET spec = '{"maxRejectRate": 0.99}'::jsonb WHERE check_id = 'bhavcopy-reject-rate'`);
  const underRaisedThreshold = await checkBhavcopyRejectRate(pool);
  expect(underRaisedThreshold.status).toBe('info');
});

test('market-bar-ohlc-sanity: fails on a non-positive close, passes once removed', async () => {
  // No table-level CHECK on close>0 (unlike delivery_pct below), so a direct
  // insert can genuinely violate it -- this is the real gap the check exists
  // to catch defense-in-depth, on top of the parser's own reject-on-ingest.
  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status) VALUES ('ZZZDQ2', 'x', 'NSE', 'listed') ON CONFLICT DO NOTHING`,
  );
  await client.query(
    `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
     VALUES ('ZZZDQ2', '2026-08-12', '1d', 'nse', 0, now(), $1)`,
    [runId],
  );
  await closeRun(client, runId, { status: 'succeeded', metrics: metrics(1, 1, 0) });
  client.release();

  const violating = await checkMarketBarOhlcSanity(pool);
  expect(violating.status).toBe('fail');
  expect(violating.observed.violatingRows).toBe(1);

  await pool.query(`DELETE FROM market_bar WHERE symbol = 'ZZZDQ2'`);
  const clean = await checkMarketBarOhlcSanity(pool);
  expect(clean.status).toBe('info');
});

test('delivery-pct-range: the TABLE ITSELF rejects an out-of-range value (defense in depth); check passes on clean data', async () => {
  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status) VALUES ('ZZZDQ3', 'x', 'NSE', 'listed') ON CONFLICT DO NOTHING`,
  );

  // Cannot insert delivery_pct=150 normally -- delivery_stat's own CHECK
  // (delivery_pct BETWEEN 0 AND 100) rejects it before the DQ check ever
  // runs. Proving THAT is itself the negative control: temporarily drop the
  // constraint, prove the row can then exist and the DQ check catches it,
  // then restore the constraint (never leaving the schema weakened).
  await pool.query(`ALTER TABLE delivery_stat DROP CONSTRAINT delivery_stat_delivery_pct_check`);
  try {
    await client.query(
      `INSERT INTO delivery_stat (symbol, session_date, source, delivery_pct, available_at, run_id)
       VALUES ('ZZZDQ3', '2026-08-12', 'nse', 150, now(), $1)`,
      [runId],
    );
    const violating = await checkDeliveryPctRange(pool);
    expect(violating.status).toBe('fail');
    expect(violating.observed.violatingRows).toBe(1);
  } finally {
    await pool.query(`DELETE FROM delivery_stat WHERE symbol = 'ZZZDQ3'`);
    await pool.query(`ALTER TABLE delivery_stat ADD CONSTRAINT delivery_stat_delivery_pct_check CHECK (delivery_pct BETWEEN 0 AND 100)`);
  }
  await closeRun(client, runId, { status: 'succeeded', metrics: metrics(0, 0, 0) });
  client.release();

  const clean = await checkDeliveryPctRange(pool);
  expect(clean.status).toBe('info');

  // And the constraint really is back: a fresh violating insert now throws.
  await expect(
    pool.query(
      `INSERT INTO delivery_stat (symbol, session_date, source, delivery_pct, available_at, run_id)
       VALUES ('ZZZDQ3', '2026-08-13', 'nse', -5, now(),
         (SELECT run_id FROM ingestion_run WHERE job_id='nse.bhavcopy' ORDER BY started_at DESC LIMIT 1))`,
    ),
  ).rejects.toThrow(/violates check constraint/);
});

test('calendar-continuity: warns on any weekday gap when the threshold is tight, passes when relaxed', async () => {
  // Two weekday sessions with a real gap between them (e.g. a Monday and the
  // following Wednesday, skipping Tuesday) -- a genuine 1-weekday gap.
  await pool.query(
    `INSERT INTO trading_session (exchange, session_date, open_at, close_at, is_holiday) VALUES
       ('NSE', '2026-08-10', now(), now(), false),
       ('NSE', '2026-08-12', now(), now(), false)`, // 2026-08-11 (Tue) missing
  );

  await pool.query(`UPDATE dq_check SET spec = '{"maxConsecutiveWeekdayGap": 0}'::jsonb WHERE check_id = 'calendar-continuity'`);
  const tight = await checkCalendarContinuity(pool);
  expect(tight.status).toBe('warn');
  expect(tight.observed.longestGapWeekdays).toBe(1);

  await pool.query(`UPDATE dq_check SET spec = '{"maxConsecutiveWeekdayGap": 10}'::jsonb WHERE check_id = 'calendar-continuity'`);
  const relaxed = await checkCalendarContinuity(pool);
  expect(relaxed.status).toBe('info');
});
