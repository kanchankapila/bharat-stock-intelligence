// Task 5.1.2: one-shot operational entrypoint -- same convention as
// stage4/run-compute-features.ts (write-recommendations.ts holds the logic,
// this just invokes it so write-recommendations.ts stays importable for unit
// tests without triggering a real DB run as an import-time side effect).
//
// Usage: tsx src/stage5/run-ranker.ts [asOfSession]
// asOfSession defaults to the latest feature_snapshot session available.
import { closeRun, createPool, openRun } from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { writeRecommendationsForSession } from './write-recommendations.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage5-ranker';

async function main(): Promise<void> {
  const pool = createPool();
  const asOfSessionArg = process.argv[2];

  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage5.ranker', 'Task 5.1 shadow ranker -- writes is_publishable=false recommendation rows', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage5.ranker', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  try {
    const insertClient = await pool.connect();
    let writeResult;
    try {
      writeResult = await writeRecommendationsForSession(pool, insertClient, runId, CODE_COMMIT, asOfSessionArg);
    } finally {
      insertClient.release();
    }
    const { spec, asOfSession, snapshotRowCount, rankedCount, written } = writeResult;
    console.log(`[ranker] variant=${spec.variant} version=${spec.version} unvalidated=${spec.unvalidated}`);
    console.log(`[ranker] ${spec.rationale}`);
    console.log(`[ranker] session=${asOfSession}, ${snapshotRowCount} feature_snapshot rows`);
    console.log(`[ranker] ranked ${rankedCount}/${snapshotRowCount} symbols (rest dropped: zero usable factor coverage)`);
    console.log(`[ranker] wrote ${written} recommendation rows (is_publishable=false), model_version stage5_ranker@${spec.version} registered as 'shadow'`);

    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: snapshotRowCount, rowsAccepted: written, rowsRejected: snapshotRowCount - rankedCount,
        rowsWritten: written, symbolsCovered: written, inputWatermark: asOfSession, outputWatermark: asOfSession,
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
    console.error('[ranker] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[ranker] FATAL:', err);
  process.exitCode = 1;
});
