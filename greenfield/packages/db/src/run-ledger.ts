// "Every job execution opens an ingestion_run row on start and closes it with
// final status and metrics. Every fact row written during that execution
// carries its run_id." (BUILD_STAGE_0_2_SPEC.md Task 1.4)
import type pg from 'pg';
import type { JobMetrics, JobResult } from '@greenfield/contracts';

export interface OpenRunInput {
  jobId: string;
  endpointKey?: string;
  codeCommit: string;
  inputWatermark?: string | null;
}

export async function openRun(
  client: pg.ClientBase,
  input: OpenRunInput,
): Promise<string> {
  const { rows } = await client.query<{ run_id: string }>(
    `INSERT INTO ingestion_run (job_id, endpoint_key, code_commit, input_watermark, status)
     VALUES ($1, $2, $3, $4, 'running')
     RETURNING run_id`,
    [input.jobId, input.endpointKey ?? null, input.codeCommit, input.inputWatermark ?? null],
  );
  const runId = rows[0]?.run_id;
  if (!runId) throw new Error('openRun: INSERT ... RETURNING produced no row');
  return runId;
}

/** Closes the run with the JobResult's real outcome. skip_reason is required
 * by the DB's own CHECK constraint whenever status='skipped' -- this
 * function surfaces that as a clear TS-level error instead of letting a
 * missing reason reach the database as an opaque constraint violation. */
export async function closeRun(
  client: pg.ClientBase,
  runId: string,
  result: JobResult,
): Promise<void> {
  const metrics: JobMetrics = result.metrics;
  const skipReason = result.status === 'skipped' || result.status === 'degraded' ? result.reason : null;
  const errorSummary = result.status === 'failed' ? result.error.message : null;

  if (result.status === 'skipped' && !skipReason) {
    throw new Error('closeRun: status=skipped requires a reason');
  }

  await client.query(
    `UPDATE ingestion_run SET
       finished_at = now(),
       status = $2,
       skip_reason = $3,
       error_summary = $4,
       output_watermark = $5,
       rows_seen = $6,
       rows_accepted = $7,
       rows_rejected = $8,
       rows_written = $9,
       symbols_covered = $10
     WHERE run_id = $1`,
    [
      runId,
      result.status,
      skipReason,
      errorSummary,
      metrics.outputWatermark,
      metrics.rowsSeen,
      metrics.rowsAccepted,
      metrics.rowsRejected,
      metrics.rowsWritten,
      metrics.symbolsCovered,
    ],
  );
}
