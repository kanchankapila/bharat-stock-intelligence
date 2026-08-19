// Daily incremental bhavcopy ingestion — today's logical session only.
// Designed for pm2 cron_restart after market close (see ecosystem.config.cjs).
// runBackfillForDate handles idempotency, NSE 404 holidays, and stale-content
// detection; it exits 'skipped' on weekends/holidays, never errors. Historical
// catch-up is in run-full-backfill.ts (same directory).
//
// Usage: tsx src/nse/run-daily-bhavcopy.ts
import { createPool, seedNseBhavcopyRegistry } from '@greenfield/db';
import { logicalSession } from '@greenfield/market-calendar';
import { runBackfillForDate } from './backfill.js';

try { process.loadEnvFile(); } catch { /* rely on process.env */ }

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'gf-bhavcopy-daily';

async function main(): Promise<void> {
  const pool = createPool();
  await seedNseBhavcopyRegistry(pool);

  const session = logicalSession(new Date(Date.now()));
  console.log(`[bhavcopy-daily] fetching session: ${session}`);

  const outcome = await runBackfillForDate(pool, session, { codeCommit: CODE_COMMIT });
  await pool.end();

  const detail = outcome.status === 'succeeded'
    ? `${outcome.rowsAccepted} rows accepted, ${outcome.rowsRejected} rejected`
    : (outcome.reason ?? '');
  console.log(`[bhavcopy-daily] ${session}: ${outcome.status} — ${detail}`);

  if (outcome.status === 'failed') process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[bhavcopy-daily] FATAL:', err);
  process.exitCode = 1;
});
