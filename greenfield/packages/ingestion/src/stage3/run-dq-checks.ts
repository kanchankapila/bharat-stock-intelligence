// Task 3.7's 5 dq_check evaluators (evaluateAllStage3Checks/persistStage3DqResult)
// had no runner anywhere -- referenced only by their own test file. Same shape
// as stage4/run-dq-checks.ts, which this mirrors.
//
// Usage: tsx src/stage3/run-dq-checks.ts
import { createPool } from '@greenfield/db';
import { evaluateAllStage3Checks, persistStage3DqResult } from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

async function main(): Promise<void> {
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
