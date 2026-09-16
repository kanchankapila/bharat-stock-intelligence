// Task 4.2: one-shot operational entrypoint -- same convention as
// nse/run-full-backfill.ts (bhavcopy.ts holds the logic, this just invokes
// it so compute-features.ts stays importable for unit tests).
//
// Usage: tsx src/stage4/run-compute-features.ts
import { isWithinScheduleWindow } from '@greenfield/market-calendar';
import { main } from './compute-features.js';

// pm2 fires cron_restart apps immediately on registration/restart regardless of the cron
// field -- see nse/run-daily-bhavcopy.ts's guard for the live 2026-09-03 incident this fixes.
// ecosystem.config.cjs: cron_restart '30 21 * * 1-5' (21:30 IST weekdays).
if (!process.argv.includes('--force') && !isWithinScheduleWindow(new Date(), { hour: 21, minute: 30, daysOfWeek: [1, 2, 3, 4, 5] })) {
  console.log('[features] off-schedule invocation (expected ~21:30 IST weekdays) — likely a pm2 registration/restart launch, not the real cron fire. Skipping (pass --force to run manually).');
} else {
  main().catch((err) => {
    console.error('[features] FATAL:', err);
    process.exitCode = 1;
  });
}
