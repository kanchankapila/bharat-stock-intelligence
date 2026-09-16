// Task 5.2: preregister the shadow period. Run exactly ONCE, before the
// first shadow session is ever scored -- same one-shot convention as
// stage4/record-feature-set.ts, and not split into a logic/entrypoint pair
// (record-feature-set.ts isn't either) since nothing here needs unit-test
// isolation beyond what stage5-repo.ts's own queryShadowPreregistration
// already covers.
//
// Deliberately refuses to run a second time: invariant 13 forbids shortening
// (or otherwise changing) the preregistered window after seeing early
// results, and the only way code can actually enforce that is to make a
// second preregistration a hard error rather than a courtesy warning.
//
// Usage: tsx src/stage5/record-shadow-preregistration.ts <firstShadowSessionDate>
import { createHash } from 'node:crypto';
import { createPool, closeRun, insertAuditMetric, openRun, queryShadowPreregistration } from '@greenfield/db';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage5-preregister-shadow-period';

// BUILD_STAGE_5_SPEC.md Task 5.2: "min_dates: 30 mirrors Stage 3's own
// precedent... roughly six trading weeks."
export const MIN_DATES = 30;
export const MIN_CALENDAR_WEEKS = 6;

async function main(): Promise<void> {
  const firstShadowSession = process.argv[2];
  if (!firstShadowSession) {
    throw new Error('Usage: tsx src/stage5/record-shadow-preregistration.ts <firstShadowSessionDate (YYYY-MM-DD)>');
  }

  const pool = createPool();
  // Live-caught bug (2026-08-14): this script calls openRun below, which FKs
  // ingestion_run.job_id -> job_definition -- every other Stage 5 script
  // seeds job_definition first (ON CONFLICT DO NOTHING); this one didn't,
  // so a real run threw ingestion_run_job_id_fkey on its very first
  // invocation. Fixed here, not by adding error handling for it -- the seed
  // is the actual fix.
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage5.preregister_shadow_period', 'Task 5.2 one-shot shadow-period preregistration', 'Asia/Kolkata', 'v1')
     ON CONFLICT DO NOTHING`,
  );

  try {
    const existing = await queryShadowPreregistration(pool);
    if (existing !== null) {
      // Not an error path this script tries to recover from -- refusing is
      // the point. Report the existing (authoritative) values so the caller
      // can see what already governs, rather than guessing why nothing
      // happened.
      console.error(
        `[preregister] REFUSED: a shadow period was already preregistered at ${existing.generatedAt} ` +
        `(min_dates=${existing.minDates}, min_calendar_weeks=${existing.minCalendarWeeks}, ` +
        `first_shadow_session=${existing.firstShadowSession}). Spec invariant 13 forbids a second ` +
        `preregistration -- that value governs, unconditionally.`,
      );
      process.exitCode = 1;
      return;
    }

    const client = await pool.connect();
    const runId = await openRun(client, { jobId: 'stage5.preregister_shadow_period', codeCommit: CODE_COMMIT });
    client.release();

    const dimensions = { min_dates: MIN_DATES, min_calendar_weeks: MIN_CALENDAR_WEEKS };
    const paramsHash = createHash('sha256').update(JSON.stringify(dimensions)).digest('hex').slice(0, 16);

    const insertClient = await pool.connect();
    try {
      await insertAuditMetric(insertClient, {
        runId, metricName: 'shadow_period_preregistration', metricVersion: 'v1', dimensions,
        value: null, nObservations: null, dataWatermark: firstShadowSession, paramsHash, codeCommit: CODE_COMMIT,
      });
    } finally {
      insertClient.release();
    }

    const closeClient = await pool.connect();
    try {
      await closeRun(closeClient, runId, {
        status: 'succeeded',
        metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: firstShadowSession },
      });
    } finally {
      closeClient.release();
    }

    console.log(`[preregister] shadow period preregistered: min_dates=${MIN_DATES}, min_calendar_weeks=${MIN_CALENDAR_WEEKS}, first_shadow_session=${firstShadowSession}`);
  } catch (err) {
    console.error('[preregister] FAILED:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    // Always closed, including on the throw path -- an open pg.Pool keeps
    // its idle-connection timers alive, which otherwise leaves the process
    // hanging instead of exiting (the exact shape of the live bug this
    // comment documents: the original version's un-caught openRun failure
    // never reached a pool.end() call at all).
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[preregister] FATAL:', err);
  process.exitCode = 1;
});
