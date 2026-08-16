import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

describe('getActivityFeed', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM unified_signals WHERE symbol IN ('ACTRD1', 'ACTRD2')`);
    await dbRun(`DELETE FROM news_sentiment_items WHERE id LIKE 'activity-test-%'`);
  });

  it('merges signals and news into one reverse-chronological feed', async () => {
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const newer = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, entry_price, target_price, stop_loss, status, signal_generated_at, reasoning)
      VALUES (?, ?, 'platform', 'BUY', 101.5, 110, 95, 'ACTIVE', ?, 'Strong RSI breakout')
      ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO NOTHING`,
      ['ACTRD1', older.split('T')[0], older]);

    await dbRun(`INSERT INTO news_sentiment_items
      (id, title, summary, source, source_type, url, published_at, sentiment, impact, category, symbols_json)
      VALUES (?, ?, ?, 'Test Wire', 'INDIAN', 'https://example.com/a', ?, 'BULLISH', 'HIGH', 'EARNINGS', ?)`,
      ['activity-test-1', 'ACTRD2 beats Q1 estimates', 'Strong quarter', newer, JSON.stringify(['ACTRD2'])]);

    const res = await caller.getActivityFeed({ hours: 24, limit: 50 });
    expect(res.success).toBe(true);

    const signalItem = res.items.find(i => i.symbol === 'ACTRD1');
    const newsItem = res.items.find(i => i.symbol === 'ACTRD2');
    expect(signalItem).toBeTruthy();
    expect(newsItem).toBeTruthy();
    expect(signalItem!.type).toBe('SIGNAL');
    expect(signalItem!.tagSentiment).toBe('BULLISH');
    expect(signalItem!.detail).toContain('Strong RSI breakout');
    expect(newsItem!.type).toBe('NEWS');
    expect(newsItem!.headline).toBe('ACTRD2 beats Q1 estimates');

    // Newer news item must sort ahead of the older signal item.
    const newsIdx = res.items.findIndex(i => i.symbol === 'ACTRD2');
    const signalIdx = res.items.findIndex(i => i.symbol === 'ACTRD1');
    expect(newsIdx).toBeLessThan(signalIdx);
  });

  it('excludes NEUTRAL/HOLD signals from the feed', async () => {
    const now = new Date().toISOString();
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, entry_price, status, signal_generated_at)
      VALUES (?, ?, 'platform', 'NEUTRAL', 50, 'ACTIVE', ?)
      ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO NOTHING`,
      ['ACTRD1', now.split('T')[0], now]);

    // Distinct `limit` per test -- getActivityFeed is wrapped in fetchWithCache keyed on
    // (hours, limit), so reusing the same params across tests would silently serve a prior
    // test's cached result instead of exercising this test's own DB state.
    const res = await caller.getActivityFeed({ hours: 24, limit: 51 });
    expect(res.items.find(i => i.symbol === 'ACTRD1')).toBeUndefined();
  });

  it('respects the hours cutoff', async () => {
    const tooOld = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, entry_price, status, signal_generated_at)
      VALUES (?, ?, 'platform', 'SELL', 50, 'ACTIVE', ?)
      ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO NOTHING`,
      ['ACTRD1', tooOld.split('T')[0], tooOld]);

    const res = await caller.getActivityFeed({ hours: 24, limit: 52 });
    expect(res.items.find(i => i.symbol === 'ACTRD1')).toBeUndefined();
  });
});
