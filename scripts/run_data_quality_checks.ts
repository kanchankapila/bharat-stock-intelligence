/**
 * Manual/CI entry point for the data-quality contract checks (src/server/dataQualityChecks.ts).
 * In production these run automatically inside jobWatchdog's 15-min poll and land in the
 * Telegram daily digest — this script exists so you can run them on demand (e.g. right
 * after a fetcher fix, or as a CI gate against a seeded test DB) without waiting for the
 * next poll.
 *
 * Run: tsx scripts/run_data_quality_checks.ts   (requires USE_POSTGRES=true + POSTGRES_URL/
 * POSTGRES_HOST pointed at a live/migrated instance, same as scripts/ci_smoke_test.ts)
 *
 * Exit code 1 if any CRITICAL check is 'fail' or 'error'; non-critical fails/warns are
 * printed but don't fail the run.
 */
import "dotenv/config";
import { runDataQualityChecks } from "../src/server/dataQualityChecks";

async function main() {
  const { usePostgres } = await import("../src/server/pgConfig");
  if (!usePostgres()) {
    console.error("[DQ] USE_POSTGRES must be true for this check — refusing to run against SQLite.");
    process.exit(1);
  }

  const { pgHealthy } = await import("../src/server/pgClient");
  for (let attempt = 1; attempt <= 15; attempt++) {
    if (await pgHealthy()) break;
    if (attempt === 15) {
      console.error("[DQ] Postgres not reachable after 15 attempts — aborting.");
      process.exit(1);
    }
    console.log(`[DQ] Waiting for Postgres (attempt ${attempt}/15)...`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const results = await runDataQualityChecks();
  const icon = (s: string) => s === 'pass' ? 'PASS ' : s === 'warn' ? 'WARN ' : s === 'fail' ? 'FAIL ' : 'ERROR';

  let criticalFailures = 0;
  for (const r of results) {
    console.log(`[DQ] ${icon(r.status)} ${r.critical ? '[critical] ' : ''}${r.label} — ${r.detail}`);
    if (r.critical && (r.status === 'fail' || r.status === 'error')) criticalFailures++;
  }

  const passed = results.filter(r => r.status === 'pass').length;
  console.log(`[DQ] ${passed}/${results.length} checks passed. ${criticalFailures} critical failure(s).`);
  process.exit(criticalFailures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[DQ] Unexpected failure:", err);
  process.exit(1);
});
