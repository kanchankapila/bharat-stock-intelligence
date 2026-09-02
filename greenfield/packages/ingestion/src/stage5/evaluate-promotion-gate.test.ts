// Task 5.4 Verify: negative-control the gate itself. Per spec: "feed it a
// synthetic shadow run with a known-zero-IC ranker and confirm exit code 1
// [here: promote=false]; feed it one with an injected, deliberately strong
// synthetic IC signal and confirm exit code 0 [promote=true]." Extended to
// all 4 steps (min-dates, live-significance, divergence-monitor-clean,
// not-already-promoted) for the same "prove the check can both pass and
// fail" discipline every dq_check in this project follows.
//
// Real Postgres, real symbols, the REAL computeIC/computeNetAnnualizedExcessReturn
// functions via evaluatePromotionGate -- never a reimplementation. A small
// synthetic price panel (4 symbols, 10 sessions) with a fixed topK=2/
// rebalanceDays=1 override (evaluate-promotion-gate.ts's GateOptions) keeps
// the panel small without touching the production defaults (topK=50 would
// otherwise require a real 50-symbol panel just to get computeNetAnnualized
// ExcessReturn to count a single period).
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import {
  bulkInsertRecommendations, closeRun, createPool, insertAuditMetric, insertDqResult, openRun,
} from '@greenfield/db';
import { evaluatePromotionGate } from './evaluate-promotion-gate.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_JOB_ID = 'zztest.gate5';
const RANKER_VERSION = 'zztestgate-v1';
// Not RELIANCE/IDEA/etc -- see run-ranker.test.ts's header comment for why.
const WINNERS = ['ITC', 'WIPRO'];
const LOSERS = ['ONGC', 'ASIANPAINT'];
const ALL_SYMBOLS = [...WINNERS, ...LOSERS];
const SESSIONS = Array.from({ length: 10 }, (_, i) => `2021-06-${String(i + 1).padStart(2, '0')}`);
const GATE_OPTIONS = { topK: 2, costBps: 25, gatingRebalanceDays: 1, diagnosticRebalanceDays: 2, marketBarSource: 'zztestgate' };

let pool: pg.Pool;
let runId: string;

beforeEach(async () => {
  pool = createPool();
  await pool.query(`INSERT INTO job_definition (job_id, description, timezone, catalog_version) VALUES ($1, 'gate5 test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`, [TEST_JOB_ID]);
  const client = await pool.connect();
  try {
    runId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, runId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  } finally {
    client.release();
  }
}, 30_000);

afterEach(async () => {
  await pool.query(`DELETE FROM recommendation WHERE ranker_version LIKE 'zztestgate%'`);
  await pool.query(`DELETE FROM market_bar WHERE source = 'zztestgate'`);
  await pool.query(`DELETE FROM audit_metric WHERE params_hash = 'zztestgate'`);
  await pool.query(`DELETE FROM dq_result WHERE check_id LIKE 'zztestgate%' OR (check_id IN ('shadow-rank-variance','dual-run-divergence-sane') AND detail LIKE '%zztestgate%')`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.end();
}, 30_000);

/** Seeds market_bar with an EXPLICIT price path per symbol (not a constant
 * compounding drift): a fixed per-step drift makes every period's excess
 * return IDENTICAL (zero variance across periods), which drives the net
 * t-stat's denominator to exactly 0 regardless of how large the mean is --
 * `netTStat` comes out null for the same reason the deliberate-zero-IC case
 * does, defeating the "deliberately strong signal" test's own point. Real
 * day-to-day variation is required for a genuine, non-degenerate t-stat.
 * FLAT_PRICES (identical every session) is the known-zero-IC construction:
 * forward return is 0 for everyone always, so gross excess is deterministically
 * 0 too -- same null-tStat outcome, for the more obviously-zero reason. */
const FLAT_PRICES: Record<string, number[]> = Object.fromEntries(ALL_SYMBOLS.map((s) => [s, SESSIONS.map(() => 100)]));
const STRONG_SIGNAL_PRICES: Record<string, number[]> = {
  ITC: [100.00, 103.00, 104.50, 108.00, 109.00, 113.00, 114.00, 118.00, 119.50, 123.00],
  WIPRO: [100.00, 102.50, 105.00, 107.00, 110.50, 112.00, 116.00, 117.50, 121.00, 122.50],
  ONGC: [100.00, 98.50, 97.80, 95.50, 94.80, 92.50, 91.80, 89.50, 88.80, 86.50],
  ASIANPAINT: [100.00, 99.00, 97.00, 96.20, 94.00, 93.30, 91.00, 90.40, 88.00, 87.30],
};

async function seedPricePanel(prices: Record<string, number[]>) {
  const client = await pool.connect();
  try {
    for (const symbol of ALL_SYMBOLS) {
      const path = prices[symbol]!;
      for (let i = 0; i < SESSIONS.length; i++) {
        await client.query(
          `INSERT INTO market_bar (symbol, session_date, interval, source, open, high, low, close, volume, turnover, is_suspect, available_at, run_id)
           VALUES ($1, $2, '1d', 'zztestgate', $3, $3, $3, $3, 1000000, 50000000, false, now(), $4)`,
          [symbol, SESSIONS[i], path[i], runId],
        );
      }
    }
  } finally {
    client.release();
  }
}

/** Static top-2 every session: WINNERS score high, LOSERS score low, for the
 * first 5 sessions -- a fixed portfolio membership across all rebalance
 * periods (turnover=0 after the first), so the net-of-cost result isolates
 * the price signal itself rather than cost drag. */
async function seedShadowScores(nSessions = 5) {
  const client = await pool.connect();
  try {
    for (const session of SESSIONS.slice(0, nSessions)) {
      await bulkInsertRecommendations(client, ALL_SYMBOLS.map((symbol) => ({
        symbol, asOfSession: session, rankerVersion: RANKER_VERSION,
        generatedAt: `${session}T12:00:00Z`, factsCutoff: `${session}T10:00:00Z`,
        score: WINNERS.includes(symbol) ? 0.9 : 0.1, rank: 1, classification: 'rank_middle', conviction: null,
        engineCoverage: 1, breakdown: {}, vetoReasons: [], runId,
      })));
    }
  } finally {
    client.release();
  }
}

/** `queryShadowPreregistration` deliberately reads the globally EARLIEST
 * `shadow_period_preregistration` row ever recorded (spec invariant 13: the
 * shadow period can never be shortened after the fact). On any Postgres
 * where the real platform has genuinely preregistered once -- this project's
 * own local greenfield DB has, since 2026-08-24, `min_dates=30` -- a fixture
 * row written with `insertAuditMetric`'s default `generated_at=now()` is
 * NEVER earliest and is silently ignored by every reader, which is exactly
 * why every "reach step 2+" test here used to fail at step 1 regardless of
 * the min_dates this function asked for. Backdating `generated_at` to a date
 * long before this project existed makes the fixture deterministically win
 * that ordering no matter what real data coexists in the shared table --
 * cleaned up by afterEach's `params_hash = 'zztestgate'` filter either way,
 * same as every other fixture in this file. */
async function seedPreregistration(minDates: number) {
  const client = await pool.connect();
  try {
    const preregRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, preregRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
    await client.query(
      `INSERT INTO audit_metric (run_id, metric_name, metric_version, dimensions, value, n_observations, data_watermark, params_hash, code_commit, generated_at)
       VALUES ($1, 'shadow_period_preregistration', 'v1', $2::jsonb, NULL, NULL, $3, 'zztestgate', 'test', '2000-01-01T00:00:00Z')`,
      [preregRunId, JSON.stringify({ min_dates: minDates, min_calendar_weeks: 1 }), SESSIONS[0]],
    );
  } finally {
    client.release();
  }
}

/** A low, test-only Bonferroni bar (not production's real ~3.08) -- proves
 * the gate correctly compares against WHATEVER bar Task 5.0 recorded, not a
 * hardcoded one; production's real bar is exercised by the actual Task 5.0
 * run this repo's other tests already cover. */
async function seedBonferroniBar(criticalT: number) {
  const client = await pool.connect();
  try {
    const evRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, evRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
    await insertAuditMetric(client, {
      runId: evRunId, metricName: 'bonferroni_critical_t', metricVersion: 'v1',
      dimensions: { nComparisons: 1 }, value: criticalT, nObservations: 1,
      dataWatermark: SESSIONS[0]!, paramsHash: 'zztestgate', codeCommit: 'test',
    });
  } finally {
    client.release();
  }
}

test('step 1 FAILS: no shadow period was ever preregistered', async () => {
  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(false);
  expect(result.firstFailure).toBe('min-dates-accumulated');
}, 30_000);

test('step 1 FAILS: preregistered, but fewer than min_dates shadow sessions have accumulated', async () => {
  await seedPreregistration(30); // real production value -- deliberately unreachable by 5 seeded sessions
  await seedShadowScores(5);
  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(false);
  expect(result.firstFailure).toBe('min-dates-accumulated');
}, 30_000);

test('step 2 FAILS on a known-zero-IC ranker: flat returns (top-K performs identically to the universe every period)', async () => {
  await seedPreregistration(3);
  await seedShadowScores(5);
  await seedBonferroniBar(1.0);
  await seedPricePanel(FLAT_PRICES); // identical price every session -- gross excess is identically 0
  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(false);
  expect(result.firstFailure).toBe('live-shadow-significance');
  const step2 = result.checks.find((c) => c.name === 'live-shadow-significance')!;
  expect(step2.observed.gating).toMatchObject({ netTStat: null });
}, 30_000);

test('step 2 PASSES with an injected, deliberately strong synthetic signal, and the gate promotes end to end (all 4 steps pass)', async () => {
  await seedPreregistration(3);
  await seedShadowScores(5);
  await seedBonferroniBar(1.0); // low test-only bar, see seedBonferroniBar's own comment
  await seedPricePanel(STRONG_SIGNAL_PRICES);
  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(true);
  expect(result.firstFailure).toBeNull();
  const step2 = result.checks.find((c) => c.name === 'live-shadow-significance')!;
  expect((step2.observed.gating as { netTStat: number }).netTStat).toBeGreaterThan(1.0);
}, 30_000);

test('step 2 FAILS on a significantly NEGATIVE (backwards) ranker even though |t| clears the bar -- "positive AND significant", not |t| alone', async () => {
  // Same STRONG_SIGNAL_PRICES panel, but the ranker scores it BACKWARDS:
  // LOSERS score high, WINNERS score low -- the top-K portfolio is the one
  // that actually loses money. Guards the exact class of bug measurement.md
  // documents repeatedly on the predecessor system (Strong Sell
  // underperforming plain Sell: extremity of a score does not by itself
  // imply correct direction).
  await seedPreregistration(3);
  const client = await pool.connect();
  try {
    for (const session of SESSIONS.slice(0, 5)) {
      await bulkInsertRecommendations(client, ALL_SYMBOLS.map((symbol) => ({
        symbol, asOfSession: session, rankerVersion: RANKER_VERSION,
        generatedAt: `${session}T12:00:00Z`, factsCutoff: `${session}T10:00:00Z`,
        score: LOSERS.includes(symbol) ? 0.9 : 0.1, // inverted vs seedShadowScores
        rank: 1, classification: 'rank_middle', conviction: null,
        engineCoverage: 1, breakdown: {}, vetoReasons: [], runId,
      })));
    }
  } finally {
    client.release();
  }
  await seedBonferroniBar(1.0);
  await seedPricePanel(STRONG_SIGNAL_PRICES);

  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(false);
  expect(result.firstFailure).toBe('live-shadow-significance');
  const step2 = result.checks.find((c) => c.name === 'live-shadow-significance')!;
  const netTStat = (step2.observed.gating as { netTStat: number }).netTStat;
  expect(netTStat).toBeLessThan(-1.0); // |t| clears the bar, but the SIGN is wrong
}, 30_000);

test('step 3 FAILS: strong signal, but the divergence monitor raised a fail-severity result since preregistration', async () => {
  await seedPreregistration(3);
  await seedShadowScores(5);
  await seedBonferroniBar(1.0);
  await seedPricePanel(STRONG_SIGNAL_PRICES);
  await insertDqResult(pool, { checkId: 'shadow-rank-variance', status: 'fail', detail: 'zztestgate synthetic failure', observed: {}, runId });

  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(false);
  expect(result.firstFailure).toBe('divergence-monitor-clean');
}, 30_000);

test('step 4 FAILS: strong signal, clean divergence monitor, but something is ALREADY published (idempotency guard) -- global, not scoped to this ranker_version', async () => {
  await seedPreregistration(3);
  await seedShadowScores(5);
  await seedBonferroniBar(1.0);
  await seedPricePanel(STRONG_SIGNAL_PRICES);

  // A DIFFERENT ranker_version already has a publishable row -- proves step 4
  // is genuinely global, not accidentally scoped to RANKER_VERSION.
  const otherClient = await pool.connect();
  try {
    await bulkInsertRecommendations(otherClient, [{
      symbol: 'ITC', asOfSession: SESSIONS[0]!, rankerVersion: 'zztestgate-other-v1',
      generatedAt: `${SESSIONS[0]}T12:00:00Z`, factsCutoff: `${SESSIONS[0]}T10:00:00Z`,
      score: 0.5, rank: 1, classification: 'rank_middle', conviction: null,
      engineCoverage: 1, breakdown: {}, vetoReasons: [], runId,
    }]);
    await otherClient.query(
      `UPDATE recommendation SET is_publishable = true WHERE ranker_version = 'zztestgate-other-v1'`,
    );
  } finally {
    otherClient.release();
  }

  const result = await evaluatePromotionGate(pool, RANKER_VERSION, GATE_OPTIONS);
  expect(result.promote).toBe(false);
  expect(result.firstFailure).toBe('not-already-promoted');
}, 30_000);
