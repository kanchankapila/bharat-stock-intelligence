// Task 3.0: establish and record the provenance boundary date before any
// Stage 3 transfer code runs. One-shot operational script, run by hand --
// same convention as nse/run-full-backfill.ts.
//
// Usage: tsx src/stage3/record-provenance-boundary.ts
import { createPool, insertAuditMetric, openRun, closeRun, queryProvenanceBoundaryDate, seedStage3Registry } from '@greenfield/db';
import { createHash } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage3-boundary';

async function main(): Promise<void> {
  const pool = createPool();
  await seedStage3Registry(pool);

  const boundaryDate = await queryProvenanceBoundaryDate(pool, 'nse');
  if (!boundaryDate) {
    throw new Error('queryProvenanceBoundaryDate: no market_bar rows found for source=nse -- run the Stage 2 backfill first');
  }

  const client = await pool.connect();
  try {
    const runId = await openRun(client, { jobId: 'stage3.boundary', codeCommit: CODE_COMMIT });
    await insertAuditMetric(client, {
      runId,
      metricName: 'provenance_boundary_date',
      metricVersion: 'v1',
      dimensions: {},
      value: null,
      dataWatermark: boundaryDate,
      paramsHash: createHash('sha256').update('provenance_boundary_date:v1').digest('hex').slice(0, 16),
      codeCommit: CODE_COMMIT,
    });
    await closeRun(client, runId, {
      status: 'succeeded',
      metrics: {
        rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0,
        inputWatermark: null, outputWatermark: boundaryDate,
      },
    });
    console.log(`[boundary] provenance_boundary_date = ${boundaryDate} (run_id=${runId})`);
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[boundary] FATAL:', err);
  process.exitCode = 1;
});
