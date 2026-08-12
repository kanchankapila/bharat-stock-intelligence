// Task 2.5 Verify: "run against a scratch database seeded with known
// contents and assert the report matches the known values."
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

let pool: pg.Pool;

function metrics(seen: number, accepted: number, rejected: number) {
  return { rowsSeen: seen, rowsAccepted: accepted, rowsRejected: rejected, rowsWritten: accepted, symbolsCovered: accepted, inputWatermark: null, outputWatermark: null };
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
     VALUES ('nse.bhavcopy', 'coverage test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO security (symbol, name, exchange, status) VALUES
       ('ZZZCOVA', 'A', 'NSE', 'listed'),
       ('ZZZCOVB', 'B', 'NSE', 'listed'),
       ('ZZZCOVC', 'C', 'NSE', 'listed')`,
  );

  // Known session map:
  //   2025-12-30: A, B          2025-12-31: A, B
  //   2026-01-01: A, B          2026-01-02: A
  //   2026-01-03: A, C
  // -> A: 5 sessions (present at latest -> listed)
  //    B: 3 sessions, last seen 2026-01-01 (NOT latest -> delisted)
  //    C: 1 session, only at latest (2026-01-03) -> listed
  const sessions: Array<[string, string[]]> = [
    ['2025-12-30', ['ZZZCOVA', 'ZZZCOVB']],
    ['2025-12-31', ['ZZZCOVA', 'ZZZCOVB']],
    ['2026-01-01', ['ZZZCOVA', 'ZZZCOVB']],
    ['2026-01-02', ['ZZZCOVA']],
    ['2026-01-03', ['ZZZCOVA', 'ZZZCOVC']],
  ];
  const client = await pool.connect();
  try {
    for (const [date, symbols] of sessions) {
      const runId = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
      for (const symbol of symbols) {
        await client.query(
          `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
           VALUES ($1, $2, '1d', 'nse', 100, now(), $3)`,
          [symbol, date, runId],
        );
      }
      await closeRun(client, runId, { status: 'succeeded', metrics: metrics(symbols.length, symbols.length, 0) });
    }

    // Known reject-reason tallies across two runs.
    const run1 = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
    await closeRun(client, run1, { status: 'succeeded', metrics: metrics(4, 0, 4) });
    await client.query(`UPDATE ingestion_run SET error_summary = $1 WHERE run_id = $2`, [
      JSON.stringify({ rejectReasons: { 'series-excluded': 3, 'invalid-close-price': 1 } }), run1,
    ]);
    const run2 = await openRun(client, { jobId: 'nse.bhavcopy', endpointKey: 'nse.bhavcopy', codeCommit: 'test' });
    await closeRun(client, run2, { status: 'succeeded', metrics: metrics(2, 0, 2) });
    await client.query(`UPDATE ingestion_run SET error_summary = $1 WHERE run_id = $2`, [
      JSON.stringify({ rejectReasons: { 'series-excluded': 2 } }), run2,
    ]);
  } finally {
    client.release();
  }

  await deriveSecurityMaster(pool);
});

afterEach(async () => {
  await pool.query(`DELETE FROM market_bar WHERE source = 'nse' AND symbol LIKE 'ZZZCOV%'`);
  await pool.query(`DELETE FROM raw_object WHERE endpoint_key = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM security WHERE symbol LIKE 'ZZZCOV%'`);
  await pool.query(`DELETE FROM job_definition WHERE job_id = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = 'nse.bhavcopy'`);
  await pool.query(`DELETE FROM provider WHERE provider = 'nse'`);
  await pool.end();
});

test('per-year distinct sessions and symbols match the known seed exactly', async () => {
  const report = await buildCoverageReport(pool);
  expect(report.perYear).toEqual([
    { year: 2025, distinctSessions: 2, distinctSymbols: 2 },
    { year: 2026, distinctSessions: 3, distinctSymbols: 3 },
  ]);
});

test('per-symbol session span is DENSE (min/median/max), not a min/max date range', async () => {
  const report = await buildCoverageReport(pool);
  // A=5, B=3, C=1 -- known exactly from the seed.
  expect(report.perSymbolSessionCounts).toEqual({ min: 1, median: 3, max: 5 });
});

test('rejected-row counts by reason are aggregated correctly across runs', async () => {
  const report = await buildCoverageReport(pool);
  expect(report.rejectedByReason).toEqual({ 'series-excluded': 5, 'invalid-close-price': 1 });
});

test('delisted symbol count matches the known seed: B is delisted, A and C are listed', async () => {
  const report = await buildCoverageReport(pool);
  expect(report.delistedSymbolCount).toBe(1);
  expect(report.listedSymbolCount).toBe(2);
});

test('formatCoverageReport renders a readable summary containing the known values', async () => {
  const report = await buildCoverageReport(pool);
  const text = formatCoverageReport(report);
  expect(text).toContain('2025: 2 sessions, 2 distinct symbols');
  expect(text).toContain('2026: 3 sessions, 3 distinct symbols');
  expect(text).toContain('min=1 median=3 max=5');
  expect(text).toContain('series-excluded: 5');
  expect(text).toContain('Delisted symbols (survivorship-free evidence): 1');
});
