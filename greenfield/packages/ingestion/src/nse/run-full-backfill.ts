// Acceptance Gate 2's actual backfill run: 2021-01-04 -> present, against
// the REAL NSE archive. Not a test -- a one-shot operational script, run by
// hand (or from a background process), matching this repo's "opt-in, run
// manually" convention for anything that touches live infrastructure.
//
// Usage: tsx src/nse/run-full-backfill.ts [--to YYYY-MM-DD]
import { createPool, seedNseBhavcopyRegistry } from '@greenfield/db';
import { logicalSession } from '@greenfield/market-calendar';
import { deriveSecurityMaster } from './security-master.js';
import { buildCoverageReport, formatCoverageReport } from './coverage-report.js';
import { evaluateAllBhavcopyChecks } from './dq-checks.js';
import { runBackfill, type DateOutcome } from './backfill.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const FROM = '2021-01-04'; // §2.2 archive horizon floor -- do not go earlier.
const toArgIndex = process.argv.indexOf('--to');
// logicalSession(), not new Date().toISOString() -- deriving "today" for a
// write-anchor default is exactly recurring-bugs.md's #1 bug class; this
// script's own linting caught it using the same rule it exists to enforce.
const TO = toArgIndex >= 0 ? process.argv[toArgIndex + 1]! : logicalSession(new Date(Date.now()));

async function main(): Promise<void> {
  const pool = createPool();
  await seedNseBhavcopyRegistry(pool);

  console.log(`[backfill] ${FROM} -> ${TO}, starting ${new Date(Date.now()).toISOString()}`);

  const tally = { succeeded: 0, skipped: 0, failed: 0 };
  const startedAt = Date.now();

  const results = await runBackfill(pool, {
    from: FROM,
    to: TO,
    codeCommit: 'stage2-full-backfill',
    delayMsBetweenRequests: 300,
    onProgress: (outcome: DateOutcome, index: number) => {
      tally[outcome.status] += 1;
      if (index % 25 === 0 || outcome.status === 'failed') {
        const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
        console.log(
          `[backfill] #${index} ${outcome.date} ${outcome.status}` +
          (outcome.status === 'succeeded' ? ` (${outcome.rowsAccepted} accepted, ${outcome.rowsRejected} rejected)` : outcome.reason ? ` -- ${outcome.reason}` : '') +
          ` | totals so far: ${tally.succeeded} ok, ${tally.skipped} skipped, ${tally.failed} failed | ${elapsedMin} min elapsed`,
        );
      }
    },
  });

  const failures = results.filter((r) => r.status === 'failed');
  console.log('');
  console.log(`[backfill] DONE. ${tally.succeeded} succeeded, ${tally.skipped} skipped, ${tally.failed} failed.`);
  if (failures.length > 0) {
    console.log('[backfill] Failed dates:', failures.map((f) => `${f.date} (${f.reason})`).join(', '));
  }

  console.log('');
  console.log('[backfill] Deriving security master (listed/delisted)...');
  const smResult = await deriveSecurityMaster(pool);
  console.log(`[backfill] Security master: latest session ${smResult.latestSession}, ${smResult.symbolsUpdated} symbols updated.`);

  console.log('');
  console.log('[backfill] Running DQ checks...');
  const dqResults = await evaluateAllBhavcopyChecks(pool);
  for (const r of dqResults) {
    console.log(`[dq] ${r.checkId}: ${r.status} -- ${r.detail}`);
  }

  console.log('');
  const report = await buildCoverageReport(pool);
  console.log(formatCoverageReport(report));

  await pool.end();

  const totalMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log('');
  console.log(`[backfill] Finished in ${totalMin} minutes.`);
}

main().catch((err) => {
  console.error('[backfill] FATAL:', err);
  process.exitCode = 1;
});
