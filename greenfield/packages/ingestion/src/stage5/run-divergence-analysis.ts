// Task 5.3: dual-run divergence analysis. Reads the shadow ranker's own
// `recommendation` rows for one session plus the old system's live
// `unified_recommendations` for the same date (read-only, old DB never
// written -- same OLD_DATABASE_URL convention as Stage 3's transfer
// scripts), computes rank correlation + directional agreement via
// divergence.ts, and records the result in audit_metric.
//
// Descriptive only, per spec: "the old ranker has no demonstrated edge
// either... agreement or disagreement with it says nothing about
// correctness." Its purpose is operational -- catching a shadow ranker
// broken in a way the old system's own monitoring would have caught. Task
// 5.4's promotion gate reads shadow-rank-variance/dual-run-divergence-sane's
// dq_result history, never this script's numeric OUTPUT directly.
//
// One-shot operational script, not split into logic/entrypoint files like
// run-ranker.ts/write-recommendations.ts -- nothing here needs test
// isolation beyond what divergence.ts's own pure-logic tests and
// legacy-repo.ts's smoke-tested query already cover, same precedent as
// record-feature-set.ts and Stage 3's transfer-*.ts scripts.
//
// Usage: tsx src/stage5/run-divergence-analysis.ts [asOfSession]
// asOfSession defaults to the shadow ranker's latest scored session.
import { createHash } from 'node:crypto';
import {
  closeRun, createPool, insertDivergenceMetrics, openRun, queryLatestRecommendationRun,
  queryLatestSessionScores, queryLegacyUnifiedRecommendationsForSession,
} from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { computeDivergenceForSession, type LegacySystemRow, type NewSystemRankRow } from './divergence.js';
import { buildSpecFromEvidence } from './write-recommendations.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage5-divergence-analysis';
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';
const TOP_K = 50;

async function main(): Promise<void> {
  const pool = createPool();
  const asOfSessionArg = process.argv[2];

  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage5.divergence_analysis', 'Task 5.3 dual-run divergence analysis vs. the old system''s live unified_recommendations', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage5.divergence_analysis', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  try {
    const spec = await buildSpecFromEvidence(pool);
    console.log(`[divergence] ranker_version=${spec.version}`);

    const asOfSession = asOfSessionArg ?? (await queryLatestSessionScores(pool, spec.version)).asOfSession;
    if (asOfSession === null) throw new Error('Shadow ranker has not scored any session yet -- nothing to compare.');
    console.log(`[divergence] session=${asOfSession}`);

    const newRecs = await queryLatestRecommendationRun(pool, asOfSession, spec.version);
    const newRows: NewSystemRankRow[] = newRecs.map((r) => ({ symbol: r.symbol, score: r.score }));
    console.log(`[divergence] ${newRows.length} shadow rows for ${asOfSession}`);

    const legacyRecs = await queryLegacyUnifiedRecommendationsForSession(OLD_DATABASE_URL, asOfSession);
    const legacyRows: LegacySystemRow[] = legacyRecs.map((r) => ({
      symbol: r.symbol, unifiedScore: r.unified_score, classification: r.classification,
    }));
    console.log(`[divergence] ${legacyRows.length} legacy unified_recommendations rows for ${asOfSession}`);

    const divergence = computeDivergenceForSession(newRows, legacyRows, TOP_K);
    console.log(
      `[divergence] rankCorrelation=${divergence.rankCorrelation?.toFixed(3) ?? 'null'} ` +
      `directionalAgreement=${divergence.directionalAgreementRate?.toFixed(3) ?? 'null'} ` +
      `nCompared=${divergence.nCompared} nDecisiveBoth=${divergence.nDecisiveBoth} ` +
      `nNewOnly=${divergence.nNewOnly} nLegacyOnly=${divergence.nLegacyOnly}`,
    );

    const paramsHash = createHash('sha256').update(JSON.stringify({ topK: TOP_K, rankerVersion: spec.version })).digest('hex').slice(0, 16);
    const insertClient = await pool.connect();
    try {
      await insertDivergenceMetrics(insertClient, {
        runId, rankerVersion: spec.version, asOfSession,
        rankCorrelation: divergence.rankCorrelation, directionalAgreementRate: divergence.directionalAgreementRate,
        nCompared: divergence.nCompared, nDecisiveBoth: divergence.nDecisiveBoth,
        nNewOnly: divergence.nNewOnly, nLegacyOnly: divergence.nLegacyOnly,
        dataWatermark: asOfSession, paramsHash, codeCommit: CODE_COMMIT,
      });
    } finally {
      insertClient.release();
    }
    console.log('[divergence] recorded 4 audit_metric rows under shadow_divergence_*');

    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: newRows.length + legacyRows.length, rowsAccepted: divergence.nCompared, rowsRejected: 0,
        rowsWritten: 4, symbolsCovered: divergence.nCompared, inputWatermark: asOfSession, outputWatermark: asOfSession,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    result = { status: 'failed', error, metrics: { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } };
  }

  const closeClient = await pool.connect();
  try {
    await closeRun(closeClient, runId, result);
  } finally {
    closeClient.release();
  }

  if (result.status === 'failed') {
    console.error('[divergence] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[divergence] FATAL:', err);
  process.exitCode = 1;
});
