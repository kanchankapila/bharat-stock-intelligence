// Task 3.7's 5 dq_check evaluators (evaluateAllStage3Checks/persistStage3DqResult)
// had no runner anywhere -- referenced only by their own test file. Same shape
// as stage4/run-dq-checks.ts, which this mirrors.
//
// Usage: tsx src/stage3/run-dq-checks.ts
import { createPool } from '@greenfield/db';
import { isWithinScheduleWindow } from '@greenfield/market-calendar';
import { evaluateAllStage3Checks, persistStage3DqResult } from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

// pm2 fires cron_restart apps immediately on registration/restart regardless of the cron
// field -- see nse/run-daily-bhavcopy.ts's guard for the live 2026-09-03 incident this fixes.
// ecosystem.config.cjs: cron_restart '40 21 * * 1-5' (21:40 IST weekdays).
const SCHEDULE = { hour: 21, minute: 40, daysOfWeek: [1, 2, 3, 4, 5] } as const;

async function main(): Promise<void> {
  if (!process.argv.includes('--force') && !isWithinScheduleWindow(new Date(), SCHEDULE)) {
    console.log('[dq] off-schedule invocation (expected ~21:40 IST weekdays) — likely a pm2 registration/restart launch, not the real cron fire. Skipping (pass --force to run manually).');
    return;
  }

  const pool = createPool();
  const results = await evaluateAllStage3Checks(pool);
  for (const r of results) {
    console.log(`[dq] ${r.checkId}: ${r.status} -- ${r.detail}`);
    await persistStage3DqResult(pool, r, null);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[dq] FATAL:', err);
  process.exitCode = 1;
});
