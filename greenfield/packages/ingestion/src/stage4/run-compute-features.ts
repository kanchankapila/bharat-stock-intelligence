// Task 4.2: one-shot operational entrypoint -- same convention as
// nse/run-full-backfill.ts (bhavcopy.ts holds the logic, this just invokes
// it so compute-features.ts stays importable for unit tests).
//
// Usage: tsx src/stage4/run-compute-features.ts
import { main } from './compute-features.js';

main().catch((err) => {
  console.error('[features] FATAL:', err);
  process.exitCode = 1;
});
