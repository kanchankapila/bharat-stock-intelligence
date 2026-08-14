// Task 5.1.2 Verify, against real Postgres per this project's dq-checks.test.ts
// convention: scoped fixtures under a distinct ranker_version/feature_set_version
// ('zztest'), real production symbols, the real writer functions -- never a
// reimplementation (recurring-bugs.md: "a test that reimplements the logic
// under test passes against the unfixed source").
//
// HDFCBANK, not RELIANCE: nse/backfill.test.ts's own afterEach unconditionally
// deletes RELIANCE (among a handful of other real symbols) as part of ITS
// fixture cleanup -- a pre-existing cross-file collision, not something Stage
// 5 introduced. Using a symbol outside that list keeps this file's fixtures
// independent of suite run order.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import {
  bulkInsertFeatureSnapshot, bulkInsertRecommendations, closeRun, createPool, insertAuditMetric, openRun,
  queryFactsCutoffViolations, queryRecommendationsForSession, queryShadowProgress, upsertModelVersion,
} from '@greenfield/db';
import { buildRankerSpec, rankSession, selectSurvivingFactors } from './ranker.js';
// NOT from run-ranker.ts: that file has an unconditional top-level
// `main().catch(...)` (the operational entrypoint), so importing anything
// from it would run the whole script against the real pool as an import-time
// side effect -- write-recommendations.ts is the split-out logic module with
// no such side effect, same convention as compute-features.ts/
// run-compute-features.ts. (Caught live: the first version of this test file
// imported buildSpecFromEvidence from run-ranker.ts and every test run
// printed "[ranker] FAILED: ..." to stderr from main() executing unbidden.)
import { buildSpecFromEvidence, writeRecommendationsForSession } from './write-recommendations.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_FSV = 'zztest5';
const TEST_JOB_ID = 'zztest.ranker5';
const SESSION = '2027-06-01';
const SYMBOL_A = 'HDFCBANK';
const SYMBOL_B = 'INFY';

let pool: pg.Pool;
let snapshotRunId: string;

beforeEach(async () => {
  pool = createPool();
  await pool.query(`INSERT INTO job_definition (job_id, description, timezone, catalog_version) VALUES ($1, 'ranker5 test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`, [TEST_JOB_ID]);
  await pool.query(`INSERT INTO feature_set (feature_set_version, spec, code_commit) VALUES ($1, '{}'::jsonb, 'test') ON CONFLICT DO NOTHING`, [TEST_FSV]);
  const client = await pool.connect();
  try {
    snapshotRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, snapshotRunId, { status: 'succeeded', metrics: { rowsSeen: 2, rowsAccepted: 2, rowsRejected: 0, rowsWritten: 2, symbolsCovered: 2, inputWatermark: null, outputWatermark: null } });
    await bulkInsertFeatureSnapshot(client, [
      { symbol: SYMBOL_A, asOfSession: SESSION, featureSetVersion: TEST_FSV, factsCutoff: `${SESSION}T10:00:00Z`, values: { momentum_63d: 9 }, coverage: 1, runId: snapshotRunId },
      { symbol: SYMBOL_B, asOfSession: SESSION, featureSetVersion: TEST_FSV, factsCutoff: `${SESSION}T10:00:00Z`, values: { momentum_63d: 1 }, coverage: 1, runId: snapshotRunId },
    ]);
  } finally {
    client.release();
  }
}, 30_000);

afterEach(async () => {
  // Ordered so a test that threw before reaching its OWN inline cleanup can't
  // leave a dangling audit_metric row FK'd to an ingestion_run this hook is
  // about to delete -- resilience the individual tests' own cleanup can't
  // provide on a failure path. ranker_version LIKE 'zztest5%' (not tied to
  // one specific session date) so this covers every session any test in this
  // file uses, including the end-to-end test's own distinct E2E_SESSION.
  await pool.query(`DELETE FROM recommendation WHERE ranker_version LIKE 'zztest5%'`);
  await pool.query(`DELETE FROM feature_snapshot WHERE feature_set_version = $1`, [TEST_FSV]);
  await pool.query(`DELETE FROM feature_set WHERE feature_set_version = $1`, [TEST_FSV]);
  await pool.query(`DELETE FROM model_version WHERE model IN ('zztest5-model', 'stage5_ranker')`);
  await pool.query(`DELETE FROM audit_metric WHERE params_hash = 'zztest' OR run_id IN (SELECT run_id FROM ingestion_run WHERE job_id = $1)`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.end();
}, 30_000);

/** Writes and returns the ranked rows for SESSION under the zero-survivor
 * (null-ranker) spec that matches this panel's ACTUAL Task 5.0 finding --
 * exercising the real write path exactly as run-ranker.ts's main() does,
 * just without its process-level plumbing. */
async function writeOneRankingPass(generatedAt: string, rankerVersion: string, recRunId: string) {
  const spec = buildRankerSpec([]); // zero survivors, matches this project's real Task 5.0 result
  const rows = [
    { symbol: SYMBOL_A, values: { momentum_63d: 9 }, factsCutoff: `${SESSION}T10:00:00Z` },
    { symbol: SYMBOL_B, values: { momentum_63d: 1 }, factsCutoff: `${SESSION}T10:00:00Z` },
  ];
  const ranked = rankSession(spec, rows);
  const client = await pool.connect();
  try {
    await bulkInsertRecommendations(client, ranked.map((r) => ({
      symbol: r.symbol, asOfSession: SESSION, rankerVersion, generatedAt, factsCutoff: r.factsCutoff,
      score: r.score, rank: r.rank, classification: r.classification, conviction: r.conviction,
      engineCoverage: r.engineCoverage, breakdown: r.breakdown, vetoReasons: [], runId: recRunId,
    })));
  } finally {
    client.release();
  }
  return { spec, ranked };
}

test('facts_cutoff on every written recommendation never exceeds its source feature_snapshot row\'s facts_cutoff', async () => {
  const client = await pool.connect();
  const recRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client, recRunId, { status: 'succeeded', metrics: { rowsSeen: 2, rowsAccepted: 2, rowsRejected: 0, rowsWritten: 2, symbolsCovered: 2, inputWatermark: null, outputWatermark: null } });
  client.release();

  // generated_at must be a fixed timestamp >= factsCutoff (10:00) -- SESSION is
  // 2027, so real wall-clock now() would be EARLIER than factsCutoff and trip
  // the table's own CHECK(facts_cutoff <= generated_at) before this test's
  // actual assertion is ever reached.
  await writeOneRankingPass('2027-06-01T12:00:00Z', 'zztest5-cutoff', recRunId);

  const violations = await queryFactsCutoffViolations(pool, 'zztest5-cutoff', TEST_FSV);
  expect(violations).toEqual([]);
}, 30_000);

test('facts_cutoff check actually fires on a real violation -- proves the query can fail, not just always pass', async () => {
  // Insert a recommendation directly, bypassing the writer, with a facts_cutoff
  // one hour AFTER the source feature_snapshot row's own cutoff -- the exact
  // shape of bug Task 5.1.2's Verify step exists to catch. generated_at is
  // fixed and later still, so this trips ONLY the intended snapshot-vs-
  // recommendation invariant, not the table's own CHECK constraint.
  const client = await pool.connect();
  try {
    const recRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, recRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 1, inputWatermark: null, outputWatermark: null } });
    await client.query(
      `INSERT INTO recommendation (symbol, as_of_session, ranker_version, generated_at, facts_cutoff, score, rank, classification, engine_coverage, run_id)
       VALUES ($1, $2, 'zztest5-violation', $3, $4, 0.5, 1, 'rank_middle', 1, $5)`,
      [SYMBOL_A, SESSION, `${SESSION}T12:00:00Z`, `${SESSION}T11:00:00Z`, recRunId], // one hour past the snapshot's 10:00 cutoff
    );
  } finally {
    client.release();
  }

  const violations = await queryFactsCutoffViolations(pool, 'zztest5-violation', TEST_FSV);
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({ symbol: SYMBOL_A, asOfSession: SESSION });
}, 30_000);

test('re-running the ranker for an already-scored session APPENDS new rows, never updates the existing ones (append-only, GREENFIELD_BUILD_SPEC.md C6)', async () => {
  const client1 = await pool.connect();
  const run1 = await openRun(client1, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client1, run1, { status: 'succeeded', metrics: { rowsSeen: 2, rowsAccepted: 2, rowsRejected: 0, rowsWritten: 2, symbolsCovered: 2, inputWatermark: null, outputWatermark: null } });
  client1.release();
  const client2 = await pool.connect();
  const run2 = await openRun(client2, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client2, run2, { status: 'succeeded', metrics: { rowsSeen: 2, rowsAccepted: 2, rowsRejected: 0, rowsWritten: 2, symbolsCovered: 2, inputWatermark: null, outputWatermark: null } });
  client2.release();

  const rankerVersion = 'zztest5-append';
  await writeOneRankingPass('2027-06-01T10:30:00Z', rankerVersion, run1);
  await writeOneRankingPass('2027-06-01T15:00:00Z', rankerVersion, run2); // later re-run, same session

  const rows = await queryRecommendationsForSession(pool, SESSION, rankerVersion);
  // 2 symbols x 2 runs = 4 rows, not 2 -- a re-run must not have overwritten the first.
  expect(rows).toHaveLength(4);
  const distinctGeneratedAt = new Set(rows.map((r) => r.generatedAt));
  expect(distinctGeneratedAt.size).toBe(2);
  expect(rows.every((r) => r.isPublishable === false)).toBe(true);

  const progress = await queryShadowProgress(pool, rankerVersion);
  expect(progress.sessions).toBe(1); // one session, scored twice
  expect(progress.publishableRows).toBe(0);
}, 30_000);

test('append-only is enforced by the PRIMARY KEY itself, not just by writer convention: a genuine (symbol, generated_at, ranker_version) collision throws rather than silently coalescing', async () => {
  const client = await pool.connect();
  try {
    const recRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, recRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 1, inputWatermark: null, outputWatermark: null } });
    const identicalGeneratedAt = '2027-06-01T13:00:00Z';
    await bulkInsertRecommendations(client, [{
      symbol: SYMBOL_A, asOfSession: SESSION, rankerVersion: 'zztest5-pkcheck', generatedAt: identicalGeneratedAt,
      factsCutoff: `${SESSION}T10:00:00Z`, score: 0.5, rank: 1, classification: 'rank_middle', conviction: null,
      engineCoverage: 1, breakdown: {}, vetoReasons: [], runId: recRunId,
    }]);
    // Same symbol + generated_at + ranker_version as above -- this must not
    // silently upsert (the predecessor's own documented failure mode, per
    // migration 010's note) or be silently absorbed; it must throw.
    await expect(bulkInsertRecommendations(client, [{
      symbol: SYMBOL_A, asOfSession: SESSION, rankerVersion: 'zztest5-pkcheck', generatedAt: identicalGeneratedAt,
      factsCutoff: `${SESSION}T10:00:00Z`, score: 0.9, rank: 1, classification: 'rank_top_decile', conviction: null,
      engineCoverage: 1, breakdown: {}, vetoReasons: [], runId: recRunId,
    }])).rejects.toThrow(/duplicate key|unique constraint/i);
  } finally {
    client.release();
  }
}, 30_000);

test('is_publishable is false for every row the writer produces -- the writer has no parameter that could set it true (spec invariant 12)', async () => {
  const client = await pool.connect();
  const recRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client, recRunId, { status: 'succeeded', metrics: { rowsSeen: 2, rowsAccepted: 2, rowsRejected: 0, rowsWritten: 2, symbolsCovered: 2, inputWatermark: null, outputWatermark: null } });
  client.release();

  await writeOneRankingPass('2027-06-01T12:00:00Z', 'zztest5-publishable', recRunId);
  const rows = await queryRecommendationsForSession(pool, SESSION, 'zztest5-publishable');
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => !r.isPublishable)).toBe(true);
}, 30_000);

test('model_version is registered as \'shadow\' state with metrics.unvalidated=true for the zero-survivor null ranker', async () => {
  const client = await pool.connect();
  const spec = buildRankerSpec([]);
  await upsertModelVersion(client, {
    model: 'zztest5-model', version: spec.version, state: 'shadow',
    artifactUri: 'in-repo://test', artifactHash: 'deadbeef', trainedAt: new Date().toISOString(),
    trainWindowStart: '2021-01-04', trainWindowEnd: SESSION, embargoDays: 0,
    metrics: { unvalidated: spec.unvalidated, rationale: spec.rationale },
    codeCommit: 'test',
  });
  const { rows } = await client.query(`SELECT state, metrics FROM model_version WHERE model = 'zztest5-model' AND version = $1`, [spec.version]);
  client.release();
  expect(rows[0].state).toBe('shadow');
  expect(rows[0].metrics.unvalidated).toBe(true);
}, 30_000);

test('buildSpecFromEvidence throws when Task 5.0 has never been run (no bonferroni_critical_t in audit_metric) -- fails loudly rather than silently defaulting', async () => {
  // This local environment genuinely has no audit_metric rows recorded (the
  // historical Task 5.0 backfill this repo's docs describe lived in a
  // different, now-gone container) -- so this assertion is exercising the
  // REAL current state of this database, not a synthetic gap.
  const { rows } = await pool.query(`SELECT count(*)::int n FROM audit_metric WHERE metric_name = 'bonferroni_critical_t'`);
  if (rows[0].n > 0) {
    // A real Task 5.0 run exists in whatever DB this suite is pointed at --
    // the precondition for this test doesn't hold here, so only assert the
    // function resolves instead of throwing.
    await expect(buildSpecFromEvidence(pool)).resolves.toBeDefined();
    return;
  }
  await expect(buildSpecFromEvidence(pool)).rejects.toThrow(/Task 5\.0 has not been run/);
}, 30_000);

test('buildSpecFromEvidence derives the null ranker end-to-end from a recorded zero-survivor Task 5.0 run (reproduces this panel\'s real recorded result)', async () => {
  const client = await pool.connect();
  const evidenceRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client, evidenceRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  // Faithfully reproduces the real recorded Task 5.0 outcome: every factor's
  // net t-stat falls short of the bar (delivery_pct actually measured
  // t=0.03/-0.06 net of costs -- see BUILD_STAGE_5_SPEC.md's own report).
  await insertAuditMetric(client, {
    runId: evidenceRunId, metricName: 'factor_net_tstat.delivery_pct', metricVersion: 'v1',
    dimensions: { factor: 'delivery_pct', rebalanceDays: 21, costBps: 25 }, value: -0.06, nObservations: 10,
    dataWatermark: SESSION, paramsHash: 'zztest', codeCommit: 'test',
  });
  await insertAuditMetric(client, {
    runId: evidenceRunId, metricName: 'bonferroni_critical_t', metricVersion: 'v1',
    dimensions: { nComparisons: 24 }, value: 3.08, nObservations: 24,
    dataWatermark: SESSION, paramsHash: 'zztest', codeCommit: 'test',
  });
  client.release();

  const spec = await buildSpecFromEvidence(pool);
  expect(spec.unvalidated).toBe(true);
  expect(spec.factors[0]!.factor).toBe('momentum_63d');

  await pool.query(`DELETE FROM audit_metric WHERE run_id = $1`, [evidenceRunId]);
}, 30_000);

test('selectSurvivingFactors + buildRankerSpec on a synthetic SURVIVING factor produces the weighted (not null) variant end-to-end', async () => {
  const survivors = selectSurvivingFactors([{ factor: 'div_yield_ttm', rebalanceDays: 21, netTStat: 4.2 }], 3.08);
  const spec = buildRankerSpec(survivors);
  expect(spec.unvalidated).toBe(false);
  expect(spec.factors.map((f) => f.factor)).toEqual(['div_yield_ttm']);
}, 30_000);

test('writeRecommendationsForSession (the REAL function run-ranker.ts calls, not a reimplementation): evidence -> ranked -> written -> facts_cutoff-clean, in one pass', async () => {
  // A session/facts_cutoff safely in the PAST relative to real wall-clock
  // now(), unlike the shared beforeEach fixture's 2027 session: this function
  // computes generated_at from the real clock internally (unlike
  // writeOneRankingPass's test helper, which takes it as an explicit
  // parameter), so a future facts_cutoff would trip the table's own
  // CHECK(facts_cutoff <= generated_at) before ever reaching this test's
  // actual assertions. feature_snapshot is partitioned by year with a range
  // starting 2021-01-01 (migration 008) -- must fall within an existing
  // partition, so this can't go earlier than that the way the CHECK-avoidance
  // reasoning alone would suggest. Early-2021 sits right at Task 5.0's own
  // panel start (2021-01-04) and safely before real wall-clock now().
  const E2E_SESSION = '2021-01-05';
  const client = await pool.connect();
  try {
    const evidenceRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, evidenceRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
    await insertAuditMetric(client, {
      runId: evidenceRunId, metricName: 'factor_net_tstat.delivery_pct', metricVersion: 'v1',
      dimensions: { factor: 'delivery_pct', rebalanceDays: 21, costBps: 25 }, value: -0.06, nObservations: 10,
      dataWatermark: E2E_SESSION, paramsHash: 'zztest', codeCommit: 'test',
    });
    await insertAuditMetric(client, {
      runId: evidenceRunId, metricName: 'bonferroni_critical_t', metricVersion: 'v1',
      dimensions: { nComparisons: 24 }, value: 3.08, nObservations: 24,
      dataWatermark: E2E_SESSION, paramsHash: 'zztest', codeCommit: 'test',
    });

    const writeRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, writeRunId, { status: 'succeeded', metrics: { rowsSeen: 2, rowsAccepted: 2, rowsRejected: 0, rowsWritten: 2, symbolsCovered: 2, inputWatermark: null, outputWatermark: null } });
    await bulkInsertFeatureSnapshot(client, [
      { symbol: SYMBOL_A, asOfSession: E2E_SESSION, featureSetVersion: TEST_FSV, factsCutoff: `${E2E_SESSION}T10:00:00Z`, values: { momentum_63d: 9 }, coverage: 1, runId: writeRunId },
      { symbol: SYMBOL_B, asOfSession: E2E_SESSION, featureSetVersion: TEST_FSV, factsCutoff: `${E2E_SESSION}T10:00:00Z`, values: { momentum_63d: 1 }, coverage: 1, runId: writeRunId },
    ]);

    const result = await writeRecommendationsForSession(pool, client, writeRunId, 'test', E2E_SESSION, TEST_FSV);

    expect(result.asOfSession).toBe(E2E_SESSION);
    expect(result.spec.unvalidated).toBe(true); // this evidence run has zero survivors, same as the real recorded one
    expect(result.snapshotRowCount).toBe(2);
    expect(result.rankedCount).toBe(2);
    expect(result.written).toBe(2);

    const violations = await queryFactsCutoffViolations(pool, result.spec.version, TEST_FSV);
    expect(violations).toEqual([]);

    const rows = await queryRecommendationsForSession(pool, E2E_SESSION, result.spec.version);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.isPublishable)).toBe(true);

    const { rows: mv } = await pool.query(`SELECT state, metrics FROM model_version WHERE model = 'stage5_ranker' AND version = $1`, [result.spec.version]);
    expect(mv[0].state).toBe('shadow');
    expect(mv[0].metrics.unvalidated).toBe(true);

    await pool.query(`DELETE FROM recommendation WHERE as_of_session = $1 AND ranker_version = $2`, [E2E_SESSION, result.spec.version]);
    await pool.query(`DELETE FROM feature_snapshot WHERE feature_set_version = $1 AND as_of_session = $2`, [TEST_FSV, E2E_SESSION]);
    await pool.query(`DELETE FROM audit_metric WHERE run_id = $1`, [evidenceRunId]);
    await pool.query(`DELETE FROM model_version WHERE model = 'stage5_ranker' AND version = $1`, [result.spec.version]);
  } finally {
    client.release();
  }
}, 30_000);
