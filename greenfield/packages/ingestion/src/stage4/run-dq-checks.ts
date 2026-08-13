// Task 4.5: run all Stage 4 dq_check evaluations against production data and
// persist results. One-shot operational script.
//
// Usage: tsx src/stage4/run-dq-checks.ts
import { createPool } from '@greenfield/db';
import { evaluateAllStage4Checks, persistStage4DqResult } from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

async function main(): Promise<void> {
  const pool = createPool();
  const results = await evaluateAllStage4Checks(pool);
  for (const r of results) {
    console.log(`[dq] ${r.checkId}: ${r.status} -- ${r.detail}`);
    await persistStage4DqResult(pool, r, null);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[dq] FATAL:', err);
  process.exitCode = 1;
});
