import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const { dbRun } = await import('../dbAsync');
const {
  fetchBroadcastablePicks,
  broadcastCanonicalPicks,
  getLatestUnifiedRecommendationsDay,
  resetBroadcastDedupForTests,
} = await import('../unifiedSignalBroadcast');

const TODAY = new Date().toISOString().slice(0, 10);
const TEST_SYMBOLS = ['ZZWSBROADCAST1', 'ZZWSBROADCAST2', 'ZZWSBROADCAST3', 'ZZWSBROADCAST4'];

async function cleanup() {
  for (const s of TEST_SYMBOLS) {
    await dbRun('DELETE FROM unified_recommendations WHERE symbol = ?', [s]);
  }
}

async function seed(row: {
  symbol: string;
  classification: string;
  conviction_level: string;
  unified_score: number;
  computed_at?: string;
}) {
  await dbRun(
    `INSERT INTO unified_recommendations
       (symbol, computed_at, regime, unified_score, conviction_level, classification,
        entry_zone_low, target_1, stop_loss, trade_reasoning)
     VALUES (?, ?, 'BULL', ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.symbol,
      row.computed_at ?? TODAY,
      row.unified_score,
      row.conviction_level,
      row.classification,
      100, 110, 95,
      'test reasoning',
    ],
  );
}

beforeEach(async () => {
  await cleanup();
  resetBroadcastDedupForTests();
});
afterAll(cleanup);

describe('fetchBroadcastablePicks', () => {
  it('only returns Buy/Strong Buy rows at S_ELITE or A_HIGH conviction', async () => {
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Strong Buy', conviction_level: 'S_ELITE', unified_score: 88 });
    await seed({ symbol: 'ZZWSBROADCAST2', classification: 'Buy', conviction_level: 'A_HIGH', unified_score: 70 });
    await seed({ symbol: 'ZZWSBROADCAST3', classification: 'Buy', conviction_level: 'B_MEDIUM', unified_score: 55 }); // conviction too low
    await seed({ symbol: 'ZZWSBROADCAST4', classification: 'Sell', conviction_level: 'S_ELITE', unified_score: 20 }); // wrong direction

    const rows = await fetchBroadcastablePicks();
    const symbols = rows.map((r) => r.symbol);
    expect(symbols).toContain('ZZWSBROADCAST1');
    expect(symbols).toContain('ZZWSBROADCAST2');
    expect(symbols).not.toContain('ZZWSBROADCAST3');
    expect(symbols).not.toContain('ZZWSBROADCAST4');
  });

  it('orders by unified_score descending', async () => {
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Buy', conviction_level: 'A_HIGH', unified_score: 70 });
    await seed({ symbol: 'ZZWSBROADCAST2', classification: 'Strong Buy', conviction_level: 'S_ELITE', unified_score: 92 });
    const rows = await fetchBroadcastablePicks();
    const idx1 = rows.findIndex((r) => r.symbol === 'ZZWSBROADCAST1');
    const idx2 = rows.findIndex((r) => r.symbol === 'ZZWSBROADCAST2');
    expect(idx2).toBeLessThan(idx1);
  });
});

describe('broadcastCanonicalPicks', () => {
  it('calls broadcastNewSignal for every qualifying pick, with source UNIFIED', async () => {
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Strong Buy', conviction_level: 'S_ELITE', unified_score: 88 });
    const calls: any[] = [];
    const fakeWs = { broadcastNewSignal: (alert: any) => calls.push(alert) };

    const sent = await broadcastCanonicalPicks(fakeWs, TODAY);

    expect(sent).toBeGreaterThanOrEqual(1);
    const call = calls.find((c) => c.symbol === 'ZZWSBROADCAST1');
    expect(call).toBeTruthy();
    expect(call.source).toBe('UNIFIED');
    expect(call.signal.signalType).toBe('BUY');
    expect(call.signal.confidence).toBe(88);
    // must NOT be source: 'AI' -- that would trigger the legacy per-signal Telegram side
    // effect inside websocketService.broadcastNewSignal, double-notifying against the daily
    // digest telegramRecommendations.ts already sends for these same canonical picks.
    expect(call.source).not.toBe('AI');
  });

  it('does not re-broadcast the same symbol twice on the same day (retry/catchup guard)', async () => {
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Buy', conviction_level: 'A_HIGH', unified_score: 70 });
    const calls: any[] = [];
    const fakeWs = { broadcastNewSignal: (alert: any) => calls.push(alert) };

    const firstSent = await broadcastCanonicalPicks(fakeWs, TODAY);
    const secondSent = await broadcastCanonicalPicks(fakeWs, TODAY); // simulates a retried job

    expect(firstSent).toBe(1);
    expect(secondSent).toBe(0);
    expect(calls.filter((c) => c.symbol === 'ZZWSBROADCAST1').length).toBe(1);
  });

  it('resets the dedup guard on a new day', async () => {
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Buy', conviction_level: 'A_HIGH', unified_score: 70 });
    const calls: any[] = [];
    const fakeWs = { broadcastNewSignal: (alert: any) => calls.push(alert) };

    await broadcastCanonicalPicks(fakeWs, '2026-01-01');
    const nextDaySent = await broadcastCanonicalPicks(fakeWs, '2026-01-02');

    expect(nextDaySent).toBe(1);
  });

  it('never throws when a client-side broadcast fails (best-effort, per unified-ranker job)', async () => {
    const fakeWs = {
      broadcastNewSignal: () => {
        throw new Error('client socket closed mid-broadcast');
      },
    };
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Buy', conviction_level: 'A_HIGH', unified_score: 70 });
    // A broadcast-side throw for one symbol must not abort the whole run -- the ranker job
    // that calls this must not fail just because a WS push failed after its own DB write
    // already succeeded.
    await expect(broadcastCanonicalPicks(fakeWs, TODAY)).resolves.toBe(0);
  });

  it('with no day argument, dedups off the real computed_at day, not the wall clock (2026-08-06 fix)', async () => {
    // The bug this regression-locks: the old default (`new Date().toISOString().slice(0,10)`)
    // used the server's UTC calendar date while computed_at is an IST-trading-day-scoped
    // string -- a call straddling a UTC midnight boundary could reset the dedup guard
    // mid-IST-day (re-broadcasting) or fail to reset for a genuinely new IST day. Seeding a
    // row whose computed_at is NOT today's UTC date, then calling broadcastCanonicalPicks with
    // no override, proves the dedup key comes from the data, not Date.now().
    const notUtcToday = '2099-01-01'; // clearly not the real UTC date in any real test run
    await seed({
      symbol: 'ZZWSBROADCAST1', classification: 'Buy', conviction_level: 'A_HIGH',
      unified_score: 70, computed_at: notUtcToday,
    });
    const calls: any[] = [];
    const fakeWs = { broadcastNewSignal: (alert: any) => calls.push(alert) };

    const firstSent = await broadcastCanonicalPicks(fakeWs);   // no `day` -- derives from data
    const secondSent = await broadcastCanonicalPicks(fakeWs);  // simulates a retried job, same run

    expect(firstSent).toBe(1);
    expect(secondSent).toBe(0); // deduped against the SAME computed_at day, not a wall-clock one
    expect(calls.filter((c) => c.symbol === 'ZZWSBROADCAST1').length).toBe(1);
  });

  it('getLatestUnifiedRecommendationsDay returns the actual latest computed_at day', async () => {
    await seed({ symbol: 'ZZWSBROADCAST1', classification: 'Buy', conviction_level: 'A_HIGH', unified_score: 70, computed_at: '2099-06-15' });
    const day = await getLatestUnifiedRecommendationsDay();
    expect(day).toBe('2099-06-15');
  });
});
