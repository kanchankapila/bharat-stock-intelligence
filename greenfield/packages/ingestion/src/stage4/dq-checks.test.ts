// Task 4.5 Verify: each check negative-controlled. feature_snapshot already
// holds ~3.27M real 'v1' rows from Task 4.2's backfill -- an unscoped test
// fixture would be diluted by (or dilute) that real data, the exact
// incident class documented for Stage 2/3. Every fixture here uses a
// distinct feature_set_version ('zztest'), which every Stage 4 query
// function already filters on -- real isolation, not a workaround.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, closeRun, openRun } from '@greenfield/db';
import { computeRankerArtifactHash } from './artifact-hash.js';
import {
  checkFeatureSnapshotCoverage, checkFeatureSnapshotFreshness, checkFeatureSuspectExclusion, checkModelArtifactHash,
} from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_FSV = 'zztest';
const TEST_JOB_ID = 'zztest.dq4';
const REAL_SYMBOL = 'RELIANCE';

let pool: pg.Pool;
let runId: string;

beforeEach(async () => {
  pool = createPool();
  await pool.query(`INSERT INTO job_definition (job_id, description, timezone, catalog_version) VALUES ($1, 'dq4 test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`, [TEST_JOB_ID]);
  await pool.query(`INSERT INTO feature_set (feature_set_version, spec, code_commit) VALUES ($1, '{}'::jsonb, 'test') ON CONFLICT DO NOTHING`, [TEST_FSV]);
  const client = await pool.connect();
  try {
    runId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, runId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  } finally {
    client.release();
  }
}, 30_000);

afterEach(async () => {
  // A plain `feature_set_version = $1` filter can't use partition pruning
  // (feature_snapshot is partitioned by as_of_session, and fixtures here
  // span both 2027 and CURRENT_DATE), so this scans all 7 partitions /
  // ~3.27M real rows to find a handful of 'zztest' ones -- measured ~10s,
  // hence the generous per-test timeout below rather than a fragile
  // per-test date allowlist.
  await pool.query(`DELETE FROM feature_snapshot WHERE feature_set_version = $1`, [TEST_FSV]);
  await pool.query(`DELETE FROM feature_set WHERE feature_set_version = $1`, [TEST_FSV]);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM model_version WHERE model = 'zztest-model'`);
  await pool.query(`UPDATE dq_check SET spec = '{"minMedianCoverage": 0.8}'::jsonb WHERE check_id = 'feature-snapshot-coverage'`);
  await pool.end();
}, 30_000);

test('feature-snapshot-coverage: warns on low median coverage, passes once healthy -- scoped so the real ~3.27M v1 rows cannot mask it', async () => {
  await pool.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     VALUES ($1, '2027-06-01', $2, now(), '{}'::jsonb, 0.1, $3)`,
    [REAL_SYMBOL, TEST_FSV, runId],
  );
  const low = await checkFeatureSnapshotCoverage(pool, TEST_FSV);
  expect(low.status).toBe('warn');

  await pool.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     VALUES ($1, '2027-06-02', $2, now(), '{}'::jsonb, 0.95, $3)`,
    [REAL_SYMBOL, TEST_FSV, runId],
  );
  const healthy = await checkFeatureSnapshotCoverage(pool, TEST_FSV);
  expect(healthy.status).toBe('info');
}, 30_000);

test('feature-snapshot-freshness: fails when stale, passes once fresh -- scoped so the real v1 backfill cannot mask it', async () => {
  await pool.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     VALUES ($1, CURRENT_DATE - 20, $2, now(), '{}'::jsonb, 1.0, $3)`,
    [REAL_SYMBOL, TEST_FSV, runId],
  );
  const stale = await checkFeatureSnapshotFreshness(pool, TEST_FSV);
  expect(stale.status).toBe('fail');

  await pool.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     VALUES ($1, CURRENT_DATE, $2, now(), '{}'::jsonb, 1.0, $3) ON CONFLICT DO NOTHING`,
    [REAL_SYMBOL, TEST_FSV, runId],
  );
  const fresh = await checkFeatureSnapshotFreshness(pool, TEST_FSV);
  expect(fresh.status).toBe('info');
}, 30_000);

test('feature-suspect-exclusion: fails when a snapshot row was built from an is_suspect market_bar row', async () => {
  const suspect = await pool.query(`SELECT symbol, session_date::text FROM market_bar WHERE source='nse' AND is_suspect = true LIMIT 1`);
  if (suspect.rows.length === 0) {
    // No quarantined bars in this environment -- assert the clean path only.
    const clean = await checkFeatureSuspectExclusion(pool, 'nse', TEST_FSV);
    expect(clean.status).toBe('info');
    return;
  }
  const { symbol, session_date: sessionDate } = suspect.rows[0];
  await pool.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     VALUES ($1, $2, $3, now(), '{}'::jsonb, 1.0, $4)`,
    [symbol, sessionDate, TEST_FSV, runId],
  );
  const violating = await checkFeatureSuspectExclusion(pool, 'nse', TEST_FSV);
  expect(violating.status).toBe('fail');

  await pool.query(`DELETE FROM feature_snapshot WHERE feature_set_version = $1`, [TEST_FSV]);
  const clean = await checkFeatureSuspectExclusion(pool, 'nse', TEST_FSV);
  expect(clean.status).toBe('info');
}, 30_000);

test('feature-suspect-exclusion: fails when facts_cutoff is after the session close', async () => {
  await pool.query(
    `INSERT INTO feature_snapshot (symbol, as_of_session, feature_set_version, facts_cutoff, values, coverage, run_id)
     VALUES ($1, '2027-06-01', $2, '2027-06-05T00:00:00Z', '{}'::jsonb, 1.0, $3)`,
    [REAL_SYMBOL, TEST_FSV, runId],
  );
  const violating = await checkFeatureSuspectExclusion(pool, 'nse', TEST_FSV);
  expect(violating.status).toBe('fail');
}, 30_000);

test('model-artifact-hash: reports "no active model" honestly, then verifies a real one by recomputation -- never fabricates a pass', async () => {
  const none = await checkModelArtifactHash(pool);
  // Could be 'info: no active model' OR reference a REAL Stage-5 model if
  // one has since been promoted -- either way must never crash or fabricate.
  expect(none.status).toBe('info');

  const variant = 'weighted';
  const version = 'v1';
  const factors = [{ factor: 'zztest_factor', rebalanceDays: 5, netTStat: 3.2, weight: 3.2, direction: 1 }];
  const correctHash = computeRankerArtifactHash({ variant, version, factors });
  const metrics = { variant, factors, unvalidated: false, rationale: 'zztest fixture' };

  await pool.query(
    `INSERT INTO model_version (model, version, state, artifact_uri, artifact_hash, trained_at, train_window, embargo_days, metrics, code_commit)
     VALUES ('zztest-model', $1, 'active', 'local://test', $2, now(), daterange('2021-01-01','2021-01-02'), 0, $3::jsonb, 'test')`,
    [version, correctHash, JSON.stringify(metrics)],
  );
  const matching = await checkModelArtifactHash(pool);
  expect(matching.status).toBe('info');
  expect(matching.detail).toContain('zztest-model');
  expect(matching.detail).toContain('matches a recomputation');

  // Negative control: corrupt the stored hash without touching the spec it
  // was computed from -- the check must now fail, not keep reporting 'info'.
  await pool.query(`UPDATE model_version SET artifact_hash = 'deadbeef' WHERE model = 'zztest-model'`);
  const tampered = await checkModelArtifactHash(pool);
  expect(tampered.status).toBe('fail');
  expect(tampered.detail).toContain('does NOT match');
}, 30_000);

test('model-artifact-hash: fails (never passes silently) when the active row has no reconstructable spec', async () => {
  await pool.query(
    `INSERT INTO model_version (model, version, state, artifact_uri, artifact_hash, trained_at, train_window, embargo_days, code_commit)
     VALUES ('zztest-model', 'v1', 'active', 'local://test', 'deadbeef', now(), daterange('2021-01-01','2021-01-02'), 0, 'test')`,
  );
  const outcome = await checkModelArtifactHash(pool);
  expect(outcome.status).toBe('fail');
  expect(outcome.detail).toContain('no reconstructable spec');
}, 30_000);
