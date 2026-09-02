// Task 5.4: the promotion gate. Exit code IS the decision (0 = promoted,
// 1 = not promoted) -- per spec invariant 15, a promotion decision is made
// by a script whose exit code is the decision, never by prose in a report.
// This gate is very likely to fail on the first attempt, and per spec that
// is the correct, expected outcome given Task 5.0's own finding (zero of 24
// factor x horizon combinations survive net of costs) -- a failing gate here
// is not a bug to debug around.
//
// Thin entrypoint over evaluate-promotion-gate.ts's real logic, same split
// as run-ranker.ts/write-recommendations.ts: only THIS file performs the
// actual promotion write (promoteLatestSession), and only after
// evaluatePromotionGate has returned promote=true from a read-only pass.
//
// Usage: tsx src/stage5/promotion-gate.ts
import { closeRun, createPool, openRun, promoteLatestSession } from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { evaluatePromotionGate } from './evaluate-promotion-gate.js';
import { buildSpecFromEvidence, MODEL_NAME } from './write-recommendations.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage5-promotion-gate';

async function main(): Promise<void> {
  const pool = createPool();

  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage5.promotion_gate', 'Task 5.4 promotion gate -- exit code is the decision', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage5.promotion_gate', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  let promoted = false;
  try {
    const spec = await buildSpecFromEvidence(pool);
    const gate = await evaluatePromotionGate(pool, spec.version);

    // Report the literal numbers the gate computed, per spec's own closing
    // instruction -- never summarized as "looks promising".
    console.log(JSON.stringify(gate, null, 2));

    if (gate.promote) {
      const writeClient = await pool.connect();
      try {
        const written = await promoteLatestSession(writeClient, MODEL_NAME, spec.version);
        console.log(
          `[promotion-gate] PROMOTED ${spec.version} session=${written.asOfSession} (${written.rowsUpdated} row(s) set is_publishable=true, ` +
          `model_version ledger ${written.modelPromoted ? 'updated to active' : 'NOT updated -- no matching model_version row found'})`,
        );
        promoted = true;
      } finally {
        writeClient.release();
      }
    } else {
      console.log(`[promotion-gate] NOT PROMOTED -- first failing check: ${gate.firstFailure}`);
    }

    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: gate.checks.length, rowsAccepted: gate.checks.filter((c) => c.passed).length,
        rowsRejected: gate.checks.filter((c) => !c.passed).length, rowsWritten: promoted ? 1 : 0,
        symbolsCovered: 0, inputWatermark: null, outputWatermark: null,
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
    console.error('[promotion-gate] FATAL:', result.error.message);
    process.exitCode = 1;
  } else {
    // The gate's decision, not the job's own success/failure, is the exit
    // code that matters here -- a script that ran cleanly but decided
    // "do not promote" must still exit 1.
    process.exitCode = promoted ? 0 : 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[promotion-gate] FATAL:', err);
  process.exitCode = 1;
});
