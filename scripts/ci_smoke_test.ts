/**
 * CI smoke test: boots the real tRPC router in-process (no Express/Redis — those are
 * separate infra concerns already covered by graceful-degradation code paths) against a fresh
 * Postgres schema and calls a handful of read-only, DB-only procedures. Catches exactly the
 * "router code references a column schema.postgres.sql doesn't have" class of bug that unit
 * tests (mocked DB) and typecheck (no runtime DB access) both miss — see CLAUDE.md's migration-066
 * fcf_yield_approx incident for a real example of what this would have caught.
 *
 * Deliberately does NOT call startServer() — that boots BullMQ workers and background
 * jobs that hit live external APIs (Yahoo/MoneyControl/etc.), none of which belong in CI and
 * would make this flaky. Every procedure below is chosen because it only reads from Postgres.
 *
 * Run: tsx scripts/ci_smoke_test.ts   (requires POSTGRES_URL/POSTGRES_HOST pointed at a
 * migrated instance — see .github/workflows/ci.yml's smoke-test job)
 */
import "dotenv/config";
import { appRouter } from "../src/server/router";

const TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function main() {
  // Dialect guard removed 2026-08-16 — usePostgres() is unconditionally true, so the
  // check could never fire and its SQLite warning described a path that no longer
  // exists. pgHealthy() below is the real gate.
  const { pgHealthy } = await import("../src/server/pgClient");
  for (let attempt = 1; attempt <= 15; attempt++) {
    if (await pgHealthy()) break;
    if (attempt === 15) {
      console.error("[SMOKE] Postgres not reachable after 15 attempts — aborting.");
      process.exit(1);
    }
    console.log(`[SMOKE] Waiting for Postgres (attempt ${attempt}/15)...`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  const caller = appRouter.createCaller({ req: {} as any, res: {} as any });

  // Read-only, DB-only procedures — no external API calls, no auth/session requirements.
  const checks: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: "getAllSectors",           run: () => caller.getAllSectors() },
    { name: "getAllIndustries",        run: () => caller.getAllIndustries() },
    { name: "getNSEStockCount",        run: () => caller.getNSEStockCount() },
    { name: "getAllNSEStocks",         run: () => caller.getAllNSEStocks() },
    { name: "getSignalDates",          run: () => caller.getSignalDates() },
    { name: "getTechnicalSignalsStatus", run: () => caller.getTechnicalSignalsStatus() },
    { name: "getMLModelRegistry",      run: () => caller.getMLModelRegistry() },
    { name: "getModelRocDiagnostics",  run: () => caller.getModelRocDiagnostics({}) },
    { name: "getBuyRecommendations",   run: () => caller.getBuyRecommendations({ conviction: "ALL", horizon: "ALL", limit: 10 }) },
    { name: "getIntradayRecommendations", run: () => caller.getIntradayRecommendations({ limit: 10 }) },
  ];

  let failed = 0;
  for (const { name, run } of checks) {
    try {
      await withTimeout(run(), TIMEOUT_MS, name);
      console.log(`[SMOKE] PASS  ${name}`);
    } catch (err) {
      failed++;
      console.error(`[SMOKE] FAIL  ${name}: ${(err as Error).message}`);
    }
  }

  console.log(`[SMOKE] ${checks.length - failed}/${checks.length} procedures passed.`);
  // The pg Pool (opened lazily by pgClient.ts's getPool(), never explicitly closed) keeps a
  // live TCP socket open, so Node's event loop never empties on its own — without an explicit
  // exit, a successful run hangs forever instead of returning control to the caller. Left 12
  // zombie processes running from manual local test runs during development before this fix
  // (each holding a Postgres connection) — found and killed 2026-07-18.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[SMOKE] Unexpected failure:", err);
  process.exit(1);
});
