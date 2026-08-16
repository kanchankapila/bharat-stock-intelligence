process.env.DATABASE_URL = ':memory:';

import { describe, it, expect, beforeEach } from 'vitest';

const { buildAccuracyDigest, formatAccuracyDigest, RECALL_ALERT_FLOOR } = await import(
  '../signalAccuracyDigest'
);
const { dbRun } = await import('../dbAsync');

async function seed(rows: {
  stats?: Array<[string, number, number, string]>;
  retro?: Array<[string, string, number, number, string]>;
}) {
  await dbRun('DROP TABLE IF EXISTS high_flyer_daily_stats');
  await dbRun('DROP TABLE IF EXISTS high_flyer_retrospective');
  await dbRun(`CREATE TABLE high_flyer_daily_stats (
    date TEXT PRIMARY KEY, universe_n INTEGER, flyer_n INTEGER,
    recall_json TEXT, precursor_counts_json TEXT, computed_at TEXT)`);
  await dbRun(`CREATE TABLE high_flyer_retrospective (
    symbol TEXT NOT NULL, date TEXT NOT NULL, return_pct REAL NOT NULL,
    wrong_call INTEGER DEFAULT 0, prior_classification TEXT,
    PRIMARY KEY (symbol, date))`);

  for (const [date, universe, flyers, recallJson] of rows.stats ?? []) {
    await dbRun(
      'INSERT INTO high_flyer_daily_stats (date, universe_n, flyer_n, recall_json) VALUES (?,?,?,?)',
      [date, universe, flyers, recallJson]
    );
  }
  for (const [symbol, date, ret, wrong, prior] of rows.retro ?? []) {
    await dbRun(
      'INSERT INTO high_flyer_retrospective (symbol, date, return_pct, wrong_call, prior_classification) VALUES (?,?,?,?,?)',
      [symbol, date, ret, wrong, prior]
    );
  }
}

const RECALL = (o: Record<string, unknown>) => JSON.stringify(o);

describe('buildAccuracyDigest', () => {
  beforeEach(async () => {
    await seed({});
  });

  it('returns null when the retrospective has never run', async () => {
    expect(await buildAccuracyDigest()).toBeNull();
  });

  it('reads recall, diver count and wrong-direction counts off the latest day', async () => {
    await seed({
      stats: [
        ['2026-08-11', 2000, 12, RECALL({ any: 0.25, diver_n: 8, wrong_bearish_miss: 3, wrong_bullish_miss: 1 })],
      ],
    });
    const d = await buildAccuracyDigest();
    expect(d).toMatchObject({
      date: '2026-08-11', flyers: 12, divers: 8,
      recallAny: 0.25, wrongBearish: 3, wrongBullish: 1,
    });
  });

  it('only reports rows the engine itself marked wrong_call', async () => {
    // Re-deriving "wrong" here would let the digest and the engine drift apart.
    await seed({
      stats: [['2026-08-11', 2000, 5, RECALL({ any: 0.2 })]],
      retro: [
        ['CELLO', '2026-08-11', 15.69, 1, 'Sell'],
        ['NOTWRONG', '2026-08-11', 22.0, 0, 'Buy'],
      ],
    });
    const d = await buildAccuracyDigest();
    expect(d!.worstCalls.map(w => w.symbol)).toEqual(['CELLO']);
  });

  it('orders wrong calls by absolute move, so the worst diver ranks with the worst flyer', async () => {
    await seed({
      stats: [['2026-08-11', 2000, 5, RECALL({ any: 0.2 })]],
      retro: [
        ['SMALL', '2026-08-11', 6.0, 1, 'Sell'],
        ['BIGDIVE', '2026-08-11', -19.0, 1, 'Buy'],
        ['BIGFLY', '2026-08-11', 21.0, 1, 'Strong Sell'],
      ],
    });
    const d = await buildAccuracyDigest();
    expect(d!.worstCalls.map(w => w.symbol)).toEqual(['BIGFLY', 'BIGDIVE', 'SMALL']);
  });

  it('survives malformed recall_json rather than throwing', async () => {
    await seed({ stats: [['2026-08-11', 2000, 4, 'not json{']] });
    const d = await buildAccuracyDigest();
    expect(d!.recallAny).toBeNull();
    expect(d!.wrongBearish).toBe(0);
  });

  it('reports a missing recall as null, not as zero', async () => {
    // "we could not measure it" and "we caught nothing" are different states; collapsing them
    // would make an unmeasured day look like a catastrophic one and vice versa.
    await seed({ stats: [['2026-08-11', 2000, 4, RECALL({ diver_n: 2 })]] });
    expect((await buildAccuracyDigest())!.recallAny).toBeNull();
  });
});

describe('formatAccuracyDigest', () => {
  const base = {
    date: '2026-08-11', flyers: 10, divers: 4,
    recallAny: 0.3, wrongBearish: 0, wrongBullish: 0,
    trend: [{ date: '2026-08-11', recall: 0.3 }],
    worstCalls: [],
  };

  it('flags recall below the floor with an alarm marker', () => {
    const low = formatAccuracyDigest({ ...base, recallAny: RECALL_ALERT_FLOOR - 0.01 });
    expect(low).toContain('🚨');
    expect(low).toContain('below floor');
    expect(formatAccuracyDigest(base)).not.toContain('below floor');
  });

  it('strips markdown control chars from symbols so Telegram cannot reject the message', () => {
    // An unbalanced _ or * kills the ENTIRE message on Telegram's legacy Markdown parser.
    const out = formatAccuracyDigest({
      ...base,
      worstCalls: [{ symbol: 'BAJAJ_AUTO*', returnPct: 12.5, priorClassification: 'Sell' }],
    });
    // Assert the property (no stray control chars from dynamic text), not an exact
    // rendering — sanitizeMarkdown maps _ to a space, which is its business, not this test's.
    const dynamicLine = out.split('\n').find(l => l.includes('we said'))!;
    expect(dynamicLine).not.toMatch(/[_*`[\]]/);
    expect(dynamicLine).toContain('BAJAJ');
  });

  it('renders an unmeasured day as n/a rather than 0%', () => {
    expect(formatAccuracyDigest({ ...base, recallAny: null })).toContain('n/a');
  });

  it('omits the wrong-direction block entirely when there were none', () => {
    expect(formatAccuracyDigest(base)).not.toContain('Wrong-direction');
  });
});
