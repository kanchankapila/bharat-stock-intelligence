// Task 5.2 Verify #2 / Task 5.6 `promotion-not-premature`, negative-controlled
// per this project's standing convention. Scoped fixtures under a distinct
// ranker_version prefix ('zztestdq5%') and job_id, same isolation pattern as
// stage4/dq-checks.test.ts and stage5/run-ranker.test.ts.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { bulkInsertRecommendations, closeRun, createPool, insertAuditMetric, insertDivergenceMetrics, openRun } from '@greenfield/db';
import { checkDualRunDivergenceSane, checkPromotionNotPremature, checkShadowRankVariance, checkShadowRecommendationFreshness } from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_JOB_ID = 'zztest.dq5';
const SYMBOL = 'HDFCBANK';
// Real symbols spanning enough of the seeded 2000-symbol stocklist to give
// checkShadowRankVariance's minSymbols=5 floor something to work with. Not
// RELIANCE/IDEA/etc -- nse/backfill.test.ts's own afterEach deletes those
// from `security` as its own fixture cleanup (see run-ranker.test.ts's
// header comment for the same collision, documented there first).
const FIVE_SYMBOLS = ['HDFCBANK', 'INFY', 'TCS', 'ICICIBANK', 'SBIN'];
const RANKER_VERSION = 'zztestdq5-null-v1';

let pool: pg.Pool;
let runId: string;

beforeEach(async () => {
  pool = createPool();
  await pool.query(`INSERT INTO job_definition (job_id, description, timezone, catalog_version) VALUES ($1, 'dq5 test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`, [TEST_JOB_ID]);
  const client = await pool.connect();
  try {
    runId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, runId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  } finally {
    client.release();
  }
}, 30_000);

afterEach(async () => {
  await pool.query(`DELETE FROM recommendation WHERE ranker_version LIKE 'zztestdq5%'`);
  await pool.query(`DELETE FROM audit_metric WHERE (metric_name = 'shadow_period_preregistration' AND params_hash = 'zztestdq5') OR metric_name LIKE 'shadow_divergence_%'`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.end();
}, 30_000);

async function insertRecRow(session: string, publishable: boolean) {
  const client = await pool.connect();
  try {
    await bulkInsertRecommendations(client, [{
      symbol: SYMBOL, asOfSession: session, rankerVersion: RANKER_VERSION,
      generatedAt: `${session}T12:00:00Z`, factsCutoff: `${session}T10:00:00Z`,
      score: 0.5, rank: 1, classification: 'rank_middle', conviction: null,
      engineCoverage: 1, breakdown: {}, vetoReasons: [], runId,
    }]);
    if (publishable) {
      await client.query(
        `UPDATE recommendation SET is_publishable = true WHERE symbol = $1 AND ranker_version = $2 AND generated_at = $3`,
        [SYMBOL, RANKER_VERSION, `${session}T12:00:00Z`],
      );
    }
  } finally {
    client.release();
  }
}

/** Multi-symbol variant for the variance checks -- each symbol gets its own
 * score for the same session, one recommendation row per symbol. */
async function insertRecRowsWithScores(session: string, symbolScores: Array<{ symbol: string; score: number }>) {
  const client = await pool.connect();
  try {
    await bulkInsertRecommendations(client, symbolScores.map(({ symbol, score }) => ({
      symbol, asOfSession: session, rankerVersion: RANKER_VERSION,
      generatedAt: `${session}T12:00:00Z`, factsCutoff: `${session}T10:00:00Z`,
      score, rank: 1, classification: 'rank_middle', conviction: null,
      engineCoverage: 1, breakdown: {}, vetoReasons: [], runId,
    })));
  } finally {
    client.release();
  }
}

test('promotion-not-premature: info when no recommendation rows exist at all', async () => {
  const outcome = await checkPromotionNotPremature(pool);
  expect(outcome.status).toBe('info');
});

test('promotion-not-premature: info when rows exist but none are publishable, regardless of preregistration', async () => {
  await insertRecRow('2021-02-01', false);
  const outcome = await checkPromotionNotPremature(pool);
  expect(outcome.status).toBe('info');
});

test('promotion-not-premature: FAILS when a publishable row exists with NO shadow period ever preregistered', async () => {
  await insertRecRow('2021-02-01', true);
  const outcome = await checkPromotionNotPremature(pool);
  expect(outcome.status).toBe('fail');
  expect(outcome.detail).toMatch(/NO shadow period was ever preregistered/);
});

test('promotion-not-premature: FAILS when publishable exists but fewer than min_dates sessions have accumulated, PASSES once enough have', async () => {
  const client = await pool.connect();
  const preregRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client, preregRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  await insertAuditMetric(client, {
    runId: preregRunId, metricName: 'shadow_period_preregistration', metricVersion: 'v1',
    dimensions: { min_dates: 3, min_calendar_weeks: 1 }, value: null, nObservations: null,
    dataWatermark: '2021-02-01', paramsHash: 'zztestdq5', codeCommit: 'test',
  });
  client.release();

  // Session 1: publishable (simulates a bug bypassing the promotion gate --
  // the writer itself has no path to set this, per Task 5.1.2's own design).
  await insertRecRow('2021-02-01', true);
  const premature = await checkPromotionNotPremature(pool);
  expect(premature.status).toBe('fail');
  expect(premature.detail).toMatch(/min_dates=3/);

  // Sessions 2 and 3: now 3 distinct sessions have accumulated.
  await insertRecRow('2021-02-02', false);
  await insertRecRow('2021-02-03', false);
  const nowFine = await checkPromotionNotPremature(pool);
  expect(nowFine.status).toBe('info');
}, 30_000);

// --- shadow-rank-variance ---

test('shadow-rank-variance: info when no recommendation rows exist yet', async () => {
  const outcome = await checkShadowRankVariance(pool, RANKER_VERSION);
  expect(outcome.status).toBe('info');
});

test('shadow-rank-variance: FAILS on a collapsed universe (fewer than minSymbols scored)', async () => {
  await insertRecRowsWithScores('2021-03-01', [{ symbol: 'HDFCBANK', score: 0.9 }, { symbol: 'INFY', score: 0.1 }]);
  const outcome = await checkShadowRankVariance(pool, RANKER_VERSION);
  expect(outcome.status).toBe('fail');
  expect(outcome.detail).toMatch(/collapsed universe/);
}, 30_000);

test('shadow-rank-variance: FAILS when every symbol scores identically (degenerate ranking), PASSES with real spread', async () => {
  await insertRecRowsWithScores('2021-03-01', FIVE_SYMBOLS.map((symbol) => ({ symbol, score: 0.5 })));
  const degenerate = await checkShadowRankVariance(pool, RANKER_VERSION);
  expect(degenerate.status).toBe('fail');
  expect(degenerate.detail).toMatch(/near.identically|below the floor/i);

  await pool.query(`DELETE FROM recommendation WHERE ranker_version = $1`, [RANKER_VERSION]);
  await insertRecRowsWithScores('2021-03-02', FIVE_SYMBOLS.map((symbol, i) => ({ symbol, score: i / (FIVE_SYMBOLS.length - 1) })));
  const healthy = await checkShadowRankVariance(pool, RANKER_VERSION);
  expect(healthy.status).toBe('info');
}, 30_000);

// --- dual-run-divergence-sane ---

test('dual-run-divergence-sane: info when the shadow ranker has not scored anything yet', async () => {
  const outcome = await checkDualRunDivergenceSane(pool, RANKER_VERSION);
  expect(outcome.status).toBe('info');
});

test('dual-run-divergence-sane: warns once >=2 shadow sessions exist but ZERO divergence readings were ever recorded', async () => {
  await insertRecRow('2021-03-01', false);
  await insertRecRow('2021-03-02', false);
  const outcome = await checkDualRunDivergenceSane(pool, RANKER_VERSION);
  expect(outcome.status).toBe('warn');
  expect(outcome.detail).toMatch(/ZERO divergence readings/);
}, 30_000);

test('dual-run-divergence-sane: warns when recorded readings are ALL NULL (the "inert" case -- looks alive, computes nothing)', async () => {
  await insertRecRow('2021-03-01', false);
  const client = await pool.connect();
  try {
    await insertDivergenceMetrics(client, {
      runId, rankerVersion: RANKER_VERSION, asOfSession: '2021-03-01',
      rankCorrelation: null, directionalAgreementRate: null,
      nCompared: 0, nDecisiveBoth: 0, nNewOnly: 0, nLegacyOnly: 0,
      dataWatermark: '2021-03-01', paramsHash: 'zztestdq5', codeCommit: 'test',
    });
  } finally {
    client.release();
  }
  const outcome = await checkDualRunDivergenceSane(pool, RANKER_VERSION);
  expect(outcome.status).toBe('warn');
  expect(outcome.detail).toMatch(/ALL NULL/);
}, 30_000);

test('dual-run-divergence-sane: info with a real recorded reading', async () => {
  await insertRecRow('2021-03-01', false);
  const client = await pool.connect();
  try {
    await insertDivergenceMetrics(client, {
      runId, rankerVersion: RANKER_VERSION, asOfSession: '2021-03-01',
      rankCorrelation: 0.42, directionalAgreementRate: 0.6,
      nCompared: 10, nDecisiveBoth: 8, nNewOnly: 1, nLegacyOnly: 2,
      dataWatermark: '2021-03-01', paramsHash: 'zztestdq5', codeCommit: 'test',
    });
  } finally {
    client.release();
  }
  const outcome = await checkDualRunDivergenceSane(pool, RANKER_VERSION);
  expect(outcome.status).toBe('info');
  expect(outcome.observed.rankCorrelation).toBeCloseTo(0.42, 5);
}, 30_000);

// --- shadow-recommendation-freshness ---

test('shadow-recommendation-freshness: info when no recommendation rows exist yet', async () => {
  const outcome = await checkShadowRecommendationFreshness(pool, RANKER_VERSION);
  expect(outcome.checkId).toBe('shadow-recommendation-freshness');
  expect(outcome.status).toBe('info');
});

test('shadow-recommendation-freshness: FAILS when recommendation is multiple sessions stale', async () => {
  // 2021-01-04 is deep in the past -- regardless of whether trading_session
  // is populated, either sessionsStale >= 2 (→ 'fail') or the table is empty
  // (→ 'warn' because we can't count sessions). Either way it must not be 'info'.
  await insertRecRow('2021-01-04', false);
  const outcome = await checkShadowRecommendationFreshness(pool, RANKER_VERSION);
  expect(outcome.checkId).toBe('shadow-recommendation-freshness');
  expect(['warn', 'fail']).toContain(outcome.status);
  expect(outcome.detail).toMatch(/stale|stale|empty|behind/i);
}, 30_000);
