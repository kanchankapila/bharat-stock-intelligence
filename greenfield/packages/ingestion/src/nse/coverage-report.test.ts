// Task 2.5 Verify: "run against a scratch database seeded with known
// contents and assert the report matches the known values."
//
// Isolation, post-incident (2026-08-13): this file used to write real-format
// dates (2025-12-30..2026-01-03, inside the real backfill's actual range)
// under the shared 'nse'/'nse.bhavcopy' identifiers, and buildCoverageReport
// reads aggregate across the WHOLE source='nse' table by design -- so this
// test would have silently mixed its own known-seed assertions with
// whatever real data coexisted. Now uses a distinct test-only source/job_id
// AND dates far outside any real range, so it can never interact with real
// backfilled data by either mechanism.
import { beforeEach, afterEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, closeRun, openRun } from '@greenfield/db';
import { deriveSecurityMaster } from './security-master.js';
import { buildCoverageReport, formatCoverageReport } from './coverage-report.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_SOURCE = 'zzzcov';
const TEST_JOB_ID = 'zzzcov.bhavcopy';
const TEST_ENDPOINT_KEY = 'zzzcov.bhavcopy';
const TEST_PROVIDER = 'zzzcov';

let pool: pg.Pool;

function metrics(seen: number, accepted: number, rejected: number) {
  return { rowsSeen: seen, rowsAccepted: accepted, rowsRejected: rejected, rowsWritten: accepted, symbolsCovered: accepted, inputWatermark: null, outputWatermark: null };
}

beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ($1, 'ZZZ Coverage Test Provider', '{}', 'none', 'permitted') ON CONFLICT DO NOTHING`,
    [TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ($1, $2, 'ingestion', 'fixture', 'v1') ON CONFLICT DO NOTHING`,
    [TEST_ENDPOINT_KEY, TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ($1, 'coverage test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`,
    [TEST_JOB_ID],
  );
  await pool.query(
    `INSERT INTO security (symbol, name, exchange, status) VALUES
       ('ZZZCOVA', 'A', 'NSE', 'listed'),
       ('ZZZCOVB', 'B', 'NSE', 'listed'),
       ('ZZZCOVC', 'C', 'NSE', 'listed')`,
  );

  // Known session map, pinned to Dec 2026 / Jan 2027 -- future relative to
  // the real backfill's current progress (only ever reaches "yesterday"),
  // so it can never collide with real data, but still inside an EXISTING
  // market_bar partition (migration 004 only creates partitions through
  // 2027 -- a genuinely future year like 2031 has no partition to route
  // into at all, which Postgres correctly rejects; caught by this file's
  // own first re-run after the 2026-08-13 incident):
  //   2026-12-30: A, B          2026-12-31: A, B
  //   2027-01-01: A, B          2027-01-02: A
  //   2027-01-03: A, C
  // -> A: 5 sessions (present at latest -> listed)
  //    B: 3 sessions, last seen 2027-01-01 (NOT latest -> delisted)
  //    C: 1 session, only at latest (2027-01-03) -> listed
  const sessions: Array<[string, string[]]> = [
    ['2026-12-30', ['ZZZCOVA', 'ZZZCOVB']],
    ['2026-12-31', ['ZZZCOVA', 'ZZZCOVB']],
    ['2027-01-01', ['ZZZCOVA', 'ZZZCOVB']],
    ['2027-01-02', ['ZZZCOVA']],
    ['2027-01-03', ['ZZZCOVA', 'ZZZCOVC']],
  ];
  const client = await pool.connect();
  try {
    for (const [date, symbols] of sessions) {
      const runId = await openRun(client, { jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY, codeCommit: 'test' });
      for (const symbol of symbols) {
        await client.query(
          `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
           VALUES ($1, $2, '1d', $4, 100, now(), $3)`,
          [symbol, date, runId, TEST_SOURCE],
        );
      }
      await closeRun(client, runId, { status: 'succeeded', metrics: metrics(symbols.length, symbols.length, 0) });
    }

    // Known reject-reason tallies across two runs.
    const run1 = await openRun(client, { jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY, codeCommit: 'test' });
    await closeRun(client, run1, { status: 'succeeded', metrics: metrics(4, 0, 4) });
    await client.query(`UPDATE ingestion_run SET error_summary = $1 WHERE run_id = $2`, [
      JSON.stringify({ rejectReasons: { 'series-excluded': 3, 'invalid-close-price': 1 } }), run1,
    ]);
    const run2 = await openRun(client, { jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY, codeCommit: 'test' });
    await closeRun(client, run2, { status: 'succeeded', metrics: metrics(2, 0, 2) });
    await client.query(`UPDATE ingestion_run SET error_summary = $1 WHERE run_id = $2`, [
      JSON.stringify({ rejectReasons: { 'series-excluded': 2 } }), run2,
    ]);
  } finally {
    client.release();
  }

  await deriveSecurityMaster(pool, TEST_SOURCE);
});

afterEach(async () => {
  // market_bar's only index is the PK (symbol, session_date, interval,
  // source) -- `source` alone isn't a leading column, so on the real
  // 3M+-row table this was a full sequential scan that intermittently blew
  // vitest's 10s hook timeout. Symbols are always 'ZZZCOV%' (see beforeEach)
  // so restoring that prefix filter makes it a sargable index range scan
  // again, same shape as security-master.test.ts's working delete.
  await pool.query(`DELETE FROM market_bar WHERE source = $1 AND symbol LIKE 'ZZZCOV%'`, [TEST_SOURCE]);
  await pool.query(`DELETE FROM raw_object WHERE endpoint_key = $1`, [TEST_ENDPOINT_KEY]);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM security WHERE symbol LIKE 'ZZZCOV%'`);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = $1`, [TEST_ENDPOINT_KEY]);
  await pool.query(`DELETE FROM provider WHERE provider = $1`, [TEST_PROVIDER]);
  await pool.end();
});

test('per-year distinct sessions and symbols match the known seed exactly', async () => {
  const report = await buildCoverageReport(pool, { source: TEST_SOURCE, jobId: TEST_JOB_ID });
  expect(report.perYear).toEqual([
    { year: 2026, distinctSessions: 2, distinctSymbols: 2 },
    { year: 2027, distinctSessions: 3, distinctSymbols: 3 },
  ]);
});

test('per-symbol session span is DENSE (min/median/max), not a min/max date range', async () => {
  const report = await buildCoverageReport(pool, { source: TEST_SOURCE, jobId: TEST_JOB_ID });
  // A=5, B=3, C=1 -- known exactly from the seed.
  expect(report.perSymbolSessionCounts).toEqual({ min: 1, median: 3, max: 5 });
});

test('rejected-row counts by reason are aggregated correctly across runs', async () => {
  const report = await buildCoverageReport(pool, { source: TEST_SOURCE, jobId: TEST_JOB_ID });
  expect(report.rejectedByReason).toEqual({ 'series-excluded': 5, 'invalid-close-price': 1 });
});

test('delisted symbol count matches the known seed: B is delisted, A and C are listed', async () => {
  const report = await buildCoverageReport(pool, { source: TEST_SOURCE, jobId: TEST_JOB_ID });
  expect(report.delistedSymbolCount).toBe(1);
  expect(report.listedSymbolCount).toBe(2);
});

test('formatCoverageReport renders a readable summary containing the known values', async () => {
  const report = await buildCoverageReport(pool, { source: TEST_SOURCE, jobId: TEST_JOB_ID });
  const text = formatCoverageReport(report);
  expect(text).toContain('2026: 2 sessions, 2 distinct symbols');
  expect(text).toContain('2027: 3 sessions, 3 distinct symbols');
  expect(text).toContain('min=1 median=3 max=5');
  expect(text).toContain('series-excluded: 5');
  expect(text).toContain('Delisted symbols (survivorship-free evidence): 1');
});
