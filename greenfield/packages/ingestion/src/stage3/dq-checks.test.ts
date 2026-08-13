// Task 3.7 Verify: each check negative-controlled -- inject a violating row,
// confirm fail, remove it, confirm pass. Freshness checks (corporate-actions,
// fii-dii, screener-membership) read MAX() ACROSS THE WHOLE TABLE, which
// already has real, fresh production data from Tasks 3.2-3.4 -- an unscoped
// injected stale row would be silently masked (the exact incident class in
// recurring-bugs.md). Every freshness check here takes a distinct fake
// source/provider scope for that reason, mirroring nse/dq-checks.test.ts.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, closeRun, openRun } from '@greenfield/db';
import {
  checkCorporateActionsFreshness, checkFiiDiiFreshness, checkFundamentalsCoverage,
  checkFundamentalsLagFloor, checkScreenerMembershipFreshness,
} from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_SOURCE = 'zzzdq3';
const TEST_PROVIDER = 'zzzdq3';
const TEST_JOB_ID = 'zzzdq3.test';
const TEST_ENDPOINT_KEY = 'zzzdq3.test';
const REAL_SYMBOL = 'RELIANCE'; // FK-required, must exist; never mutated, only referenced.

let pool: pg.Pool;
let runId: string;

function metrics() {
  return { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null };
}

beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ($1, 'ZZZ DQ3 Test Provider', '{}', 'none', 'permitted') ON CONFLICT DO NOTHING`,
    [TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ($1, $2, 'ingestion', 'fixture', 'v1') ON CONFLICT DO NOTHING`,
    [TEST_ENDPOINT_KEY, TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ($1, 'dq3 test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`,
    [TEST_JOB_ID],
  );
  const client = await pool.connect();
  try {
    runId = await openRun(client, { jobId: TEST_JOB_ID, endpointKey: TEST_ENDPOINT_KEY, codeCommit: 'test' });
    await closeRun(client, runId, { status: 'succeeded', metrics: metrics() });
  } finally {
    client.release();
  }
});

afterEach(async () => {
  await pool.query(`DELETE FROM event_fact WHERE source = $1`, [TEST_SOURCE]);
  await pool.query(`DELETE FROM market_flow WHERE source = $1`, [TEST_SOURCE]);
  await pool.query(`DELETE FROM screener_membership WHERE provider = $1`, [TEST_PROVIDER]);
  await pool.query(`DELETE FROM screener_definition WHERE provider = $1`, [TEST_PROVIDER]);
  await pool.query(`DELETE FROM fundamental_fact WHERE source = $1`, [TEST_SOURCE]);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = $1`, [TEST_ENDPOINT_KEY]);
  await pool.query(`DELETE FROM provider WHERE provider = $1`, [TEST_PROVIDER]);
  await pool.query(`UPDATE dq_check SET spec = '{"minCoveragePct": 95}'::jsonb WHERE check_id = 'fundamentals-coverage'`);
  await pool.end();
});

test('corporate-actions-freshness: fails when stale, passes once fresh -- scoped so real InvestSights/legacy data cannot mask it', async () => {
  await pool.query(
    `INSERT INTO event_fact (source, source_event_id, kind, available_at, run_id)
     VALUES ($1, 'zzz-stale', 'announcement', now() - interval '20 days', $2)`,
    [TEST_SOURCE, runId],
  );
  const stale = await checkCorporateActionsFreshness(pool, TEST_SOURCE);
  expect(stale.status).toBe('fail');

  await pool.query(
    `INSERT INTO event_fact (source, source_event_id, kind, available_at, run_id)
     VALUES ($1, 'zzz-fresh', 'announcement', now(), $2)`,
    [TEST_SOURCE, runId],
  );
  const fresh = await checkCorporateActionsFreshness(pool, TEST_SOURCE);
  expect(fresh.status).toBe('info');
});

test('fii-dii-freshness: fails when stale, passes once fresh -- scoped so real NSE data cannot mask it', async () => {
  await pool.query(
    `INSERT INTO market_flow (scope, segment, flow_date, source, available_at, run_id)
     VALUES ('market', 'cash', CURRENT_DATE - 10, $1, now(), $2)`,
    [TEST_SOURCE, runId],
  );
  const stale = await checkFiiDiiFreshness(pool, TEST_SOURCE);
  expect(stale.status).toBe('fail');

  await pool.query(
    `INSERT INTO market_flow (scope, segment, flow_date, source, available_at, run_id)
     VALUES ('market', 'cash', CURRENT_DATE, $1, now(), $2) ON CONFLICT DO NOTHING`,
    [TEST_SOURCE, runId],
  );
  const fresh = await checkFiiDiiFreshness(pool, TEST_SOURCE);
  expect(fresh.status).toBe('info');
});

test('screener-membership-freshness: fails when stale, passes once fresh -- scoped so real kayal data cannot mask it', async () => {
  await pool.query(
    `INSERT INTO screener_definition (provider, provider_id, version, name, request_hash, enabled)
     VALUES ($1, 'zzz-pk', 1, 'zzz test screener', 'zzzhash', false)`,
    [TEST_PROVIDER],
  );
  await pool.query(
    `INSERT INTO screener_membership (provider, provider_id, version, symbol, observed_at, run_id)
     VALUES ($1, 'zzz-pk', 1, $2, now() - interval '10 days', $3)`,
    [TEST_PROVIDER, REAL_SYMBOL, runId],
  );
  const stale = await checkScreenerMembershipFreshness(pool, TEST_PROVIDER);
  expect(stale.status).toBe('fail');

  await pool.query(
    `INSERT INTO screener_membership (provider, provider_id, version, symbol, observed_at, run_id)
     VALUES ($1, 'zzz-pk', 1, $2, now(), $3)`,
    [TEST_PROVIDER, REAL_SYMBOL, runId],
  );
  const fresh = await checkScreenerMembershipFreshness(pool, TEST_PROVIDER);
  expect(fresh.status).toBe('info');
});

test('fundamentals-lag-floor: fails on a genuine lag violation, passes once removed -- unscoped is correct here, a single violation anywhere is the real signal', async () => {
  await pool.query(
    `INSERT INTO fundamental_fact (symbol, metric, period_end, period_type, source, value, available_at, run_id)
     VALUES ($1, 'zzz_test_metric', '2026-01-01', 'FY', $2, 1.0, '2026-01-01T00:00:00Z', $3)`,
    [REAL_SYMBOL, TEST_SOURCE, runId],
  );
  const violating = await checkFundamentalsLagFloor(pool);
  expect(violating.status).toBe('fail');

  await pool.query(`DELETE FROM fundamental_fact WHERE source = $1`, [TEST_SOURCE]);
  const clean = await checkFundamentalsLagFloor(pool);
  expect(clean.status).toBe('info');
});

test('fundamentals-coverage: warns when the threshold is set unreachably high, passes at the real threshold -- spec-adjustment negative control, same style as nse/dq-checks.test.ts', async () => {
  // Default 5s timeout is too tight now that fundamental_fact holds ~4.9M
  // real rows -- the coverage query's LEFT JOIN + COUNT DISTINCT genuinely
  // takes longer than that at this scale, not a hang.
  await pool.query(`UPDATE dq_check SET spec = '{"minCoveragePct": 100.01}'::jsonb WHERE check_id = 'fundamentals-coverage'`);
  const impossible = await checkFundamentalsCoverage(pool);
  expect(impossible.status).toBe('warn');

  await pool.query(`UPDATE dq_check SET spec = '{"minCoveragePct": 0}'::jsonb WHERE check_id = 'fundamentals-coverage'`);
  const trivial = await checkFundamentalsCoverage(pool);
  expect(trivial.status).toBe('info');
}, 20_000);
