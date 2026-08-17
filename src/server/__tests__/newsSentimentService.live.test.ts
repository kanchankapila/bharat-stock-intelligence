/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * newsSentimentService.ts had no live-hitting test before this file (data-coverage-audit,
 * 2026-08-13 TS-side sweep). Calls the service's own real scheduled entry point,
 * runNewsSentimentCycle() -- the exact function the 'news-sentiment' queue job calls every 15
 * min -- covering the RSS/BSE/Google-News sources (NOT the GNews cycles, which are quota-
 * limited to ~100 req/day total across this platform; deliberately not spent by a test run).
 * No cleanup: writes genuine production-shaped rows into news_sentiment_items/news_articles/
 * market_sentiment_snapshots, identical to what the real 15-min cycle writes.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/newsSentimentService.live.test.ts
  *
 * LIVE_DATE_SAFE: writes news_sentiment_items, dated by the article's own published_at; fetched_at is a fetch time, not a market date.
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

const { runNewsSentimentCycle, getLatestSentimentSnapshot } = await import('../newsSentimentService');
const { dbGet } = await import('../dbAsync');

describe.runIf(RUN_LIVE)('newsSentimentService [live]', () => {
  it('fetches real RSS/news sources and persists ML-usable sentiment + snapshot rows', async () => {
    const { fetched, inserted } = await runNewsSentimentCycle();
    expect(fetched, 'zero items fetched across all NEWS_SOURCES').toBeGreaterThan(0);
    expect(inserted, 'zero items survived dedupe/processing').toBeGreaterThan(0);

    const latest = await dbGet<{ id: string; title: string; fetched_at: string }>(
      `SELECT id, title, fetched_at FROM news_sentiment_items ORDER BY fetched_at DESC LIMIT 1`,
    );
    expect(latest, 'no row in news_sentiment_items after runNewsSentimentCycle').toBeTruthy();
    expect(latest!.title?.length).toBeGreaterThan(0);

    const snapshot = await getLatestSentimentSnapshot();
    expect(snapshot, 'buildMarketSentimentSnapshot produced nothing').toBeTruthy();
    expect(Number.isFinite(snapshot!.overall_score)).toBe(true);
  }, 60000);
});
