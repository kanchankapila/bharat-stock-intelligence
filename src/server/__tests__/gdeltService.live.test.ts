/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * gdeltService.ts had no test at all before this file, and its runGdeltBackfill()/
 * fetchGdeltTone() had never been called from anywhere in the app (data-coverage-audit,
 * 2026-08-13 -- wired into queues.ts the same day, see QUEUE_GDELT_SENTIMENT).
 *
 * KNOWN ENVIRONMENT LIMITATION, recorded here rather than silently worked around: this
 * sandbox's network egress reaches google.com/moneycontrol.com/trendlyne.com fine but times
 * out on api.gdeltproject.org specifically (verified via a direct fetch with no app code in
 * the path -- ConnectTimeoutError, not a 4xx/5xx). That means this test cannot be verified
 * GREEN from this environment; it is written correctly per the same 4-part checklist as every
 * other live test in this sweep (real endpoint, real parse function, real DB write+read-back)
 * and should be run once from a host that can actually reach GDELT (the real deploy target, or
 * a local dev machine) before trusting it. Do not "fix" this by mocking the endpoint -- that
 * would defeat the entire purpose of a live_datasource test.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/gdeltService.live.test.ts
  *
 * LIVE_DATE_SAFE: gdelt_sentiment.date comes from GDELT's own payload (pt.date), not the clock -- and world news genuinely happens at weekends.
 * (Declared for liveTestTradingDayGuard.test.ts -- see it for why this must be stated.)
*/
import { describe, it, expect } from 'vitest';

// Gated behind RUN_LIVE, not a static top-level `import 'dotenv/config'` -- that would load
// real credentials into process.env on EVERY vitest run (all test files share one process),
// including runs where this suite is skipped. Found live 2026-08-13: it broke
// niftytraderAuthService.test.ts's "no credentials configured" case by leaking a real
// NIFTYTRADER_EMAIL/PASSWORD into env for the whole worker. RUN_LIVE_DATASOURCE_TESTS itself
// is a plain shell env var, not something .env provides, so checking it first is safe.
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
if (RUN_LIVE) await import('dotenv/config');

const { fetchGdeltTone, runGdeltBackfill } = await import('../gdeltService');
const { dbGet } = await import('../dbAsync');
// A large, always-covered company -- GDELT indexes global English-language news, so a major
// Nifty50 name is far more likely to have recent tone data than an obscure smallcap.
const TEST_COMPANY = 'Reliance Industries';
const TEST_SYMBOL = 'RELIANCE';

describe.runIf(RUN_LIVE)('gdeltService [live]', () => {
  it('fetches real GDELT tone data for one company and persists ML-usable rows', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const series = await fetchGdeltTone(TEST_COMPANY, start, end);

    expect(
      series.length,
      `GDELT returned zero tone points for "${TEST_COMPANY}" over the last 7 days -- ` +
        `either genuinely no coverage, or this environment's network can't reach ` +
        `api.gdeltproject.org (see this file's own header comment)`,
    ).toBeGreaterThan(0);
    for (const point of series) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isFinite(point.tone)).toBe(true);
    }

    // runGdeltBackfill does its own symbol resolution (top-market-cap universe join) and
    // writes through its own upsert -- exercise it directly for one company via `limit: 1`
    // against the real top-market-cap-ranked universe, rather than reimplementing the write.
    const result = await runGdeltBackfill(start, end, 1);
    expect(result.companies).toBe(1);
    expect(result.rows, 'runGdeltBackfill wrote zero rows for the top-market-cap symbol').toBeGreaterThan(0);

    const written = await dbGet<{ symbol: string; avg_tone: number }>(
      `SELECT symbol, avg_tone FROM gdelt_sentiment ORDER BY computed_at DESC LIMIT 1`,
    );
    expect(written, 'no row found in gdelt_sentiment after runGdeltBackfill wrote it').toBeTruthy();
    expect(Number.isFinite(written!.avg_tone)).toBe(true);
  }, 60000);
});
