// Daily incremental bhavcopy ingestion — today's logical session only.
// Designed for pm2 cron_restart after market close (see ecosystem.config.cjs).
// runBackfillForDate handles idempotency, NSE 404 holidays, and stale-content
// detection; it exits 'skipped' on weekends/holidays, never errors. Historical
// catch-up is in run-full-backfill.ts (same directory).
//
// Usage: tsx src/nse/run-daily-bhavcopy.ts
import { createPool, seedNseBhavcopyRegistry } from '@greenfield/db';
import { isWithinScheduleWindow, logicalSession } from '@greenfield/market-calendar';
import { runBackfillForDate } from './backfill.js';

try { process.loadEnvFile(); } catch { /* rely on process.env */ }

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'gf-bhavcopy-daily';
// ecosystem.config.cjs: cron_restart '30 19 * * 1-5' (19:30 IST weekdays).
const SCHEDULE = { hour: 19, minute: 30, daysOfWeek: [1, 2, 3, 4, 5] } as const;

async function main(): Promise<void> {
  // pm2 fires cron_restart apps immediately on registration/restart regardless of the cron
  // field -- live-verified 2026-09-03, when an ecosystem restart at 09:20 IST hit NSE's
  // bhavcopy URL hours before it's published, got a 404, and checkpointed today as a false
  // 'non-trading day' -- which then silently blocked the real 19:30 IST run for the rest of
  // the day. Exit before opening any run so an off-schedule launch leaves no checkpoint.
  if (!process.argv.includes('--force') && !isWithinScheduleWindow(new Date(), SCHEDULE)) {
    console.log('[bhavcopy-daily] off-schedule invocation (expected ~19:30 IST weekdays) — likely a pm2 registration/restart launch, not the real cron fire. Skipping, no checkpoint written (pass --force to run manually).');
    return;
  }

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
