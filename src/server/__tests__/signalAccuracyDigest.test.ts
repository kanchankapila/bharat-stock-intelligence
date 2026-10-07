// NOTE: this file used to open with `process.env.DATABASE_URL = ':memory:'`, which read as the
// isolation guard and was not one. The SQLite path was deleted on 2026-08-19 (a2a20d2) and
// use_postgres() is now unconditional, so that line steered nothing -- dbAsync resolved to
// Postgres regardless, and the DROP TABLE statements below ran wherever the pool's search_path
// pointed. Production lost `high_flyer_daily_stats` and `high_flyer_retrospective` -- exactly the
// two tables this file drops, while `high_flyer_candidates` (created by the same script, never
// named here) survived. The real guard is the throwaway schema vitest.globalSetup.ts creates, so
// assert it is actually in force instead of trusting a dead env var. See AF-20260917-19 and
// recurring-bugs.md's "a test that can reach a side effect WILL perform it against production".

import { describe, it, expect, beforeEach } from 'vitest';

if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error(
    'signalAccuracyDigest.test.ts refuses to run without VITEST_PG_SCHEMA: it issues ' +
    'DROP TABLE on unqualified names, which without a throwaway schema resolves to ' +
    'PRODUCTION public (AF-20260917-19).'
  );
}

const { buildAccuracyDigest, formatAccuracyDigest, formatAccuracyScorecard, RECALL_ALERT_FLOOR } = await import(
  '../signalAccuracyDigest'
);
import type { AccuracyDigest } from '../signalAccuracyDigest';
const { dbRun } = await import('../dbAsync');
const SCHEMA = process.env.VITEST_PG_SCHEMA;

async function seed(rows: {
  stats?: Array<[string, number, number, string]>;
  retro?: Array<[string, string, number, number, string | null, (number | null)?, (number | null)?]>;
}) {
  // Schema-QUALIFIED on purpose (AF-20261004-02). The guard above proves the throwaway schema
  // exists, but an UNQUALIFIED `DROP TABLE x` resolves through search_path "<throwaway>",public to
  // the first schema that HAS x -- so when the throwaway copy was missing, the drop reached the
  // PRODUCTION table (it happened again on 2026-10-04). A qualified name cannot.
  await dbRun(`DROP TABLE IF EXISTS "${SCHEMA}".high_flyer_daily_stats`);
  await dbRun(`DROP TABLE IF EXISTS "${SCHEMA}".high_flyer_retrospective`);
  await dbRun(`CREATE TABLE "${SCHEMA}".high_flyer_daily_stats (
    date TEXT PRIMARY KEY, universe_n INTEGER, flyer_n INTEGER,
    recall_json TEXT, precursor_counts_json TEXT, computed_at TEXT)`);
  await dbRun(`CREATE TABLE "${SCHEMA}".high_flyer_retrospective (
    symbol TEXT NOT NULL, date TEXT NOT NULL, return_pct REAL NOT NULL,
    wrong_call INTEGER DEFAULT 0, prior_classification TEXT,
    direction TEXT DEFAULT 'up', open_to_close_pct REAL, adt_20d DOUBLE PRECISION,
    PRIMARY KEY (symbol, date))`);

  for (const [date, universe, flyers, recallJson] of rows.stats ?? []) {
    await dbRun(
      `INSERT INTO "${SCHEMA}".high_flyer_daily_stats (date, universe_n, flyer_n, recall_json) VALUES (?,?,?,?)`,
      [date, universe, flyers, recallJson]
    );
  }
  for (const [symbol, date, ret, wrong, prior, o2c, adt] of rows.retro ?? []) {
    await dbRun(
      `INSERT INTO "${SCHEMA}".high_flyer_retrospective (symbol, date, return_pct, wrong_call, prior_classification, direction, open_to_close_pct, adt_20d) VALUES (?,?,?,?,?,?,?,?)`,
      // direction mirrors the real writer: _process_day stamps 'up' for a flyer and 'down' for
      // a diver, and the sign of return_pct is what distinguishes them.
      [symbol, date, ret, wrong, prior, ret >= 0 ? 'up' : 'down', o2c ?? null, adt ?? null]
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
        ['2026-08-11', 2000, 12, RECALL({ unified: 0.25, precision: { unified: 0.1 }, diver_n: 8, wrong_bearish_miss: 3, wrong_bullish_miss: 1 })],
      ],
    });
    const d = await buildAccuracyDigest();
    expect(d).toMatchObject({
      date: '2026-08-11', flyers: 12, divers: 8, universeN: 2000,
      recallOwn: 0.25, wrongBearish: 3, wrongBullish: 1,
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
    expect(d!.recallOwn).toBeNull();
    expect(d!.wrongBearish).toBe(0);
  });

  it('reports a missing recall as null, not as zero', async () => {
    // "we could not measure it" and "we caught nothing" are different states; collapsing them
    // would make an unmeasured day look like a catastrophic one and vice versa.
    await seed({ stats: [['2026-08-11', 2000, 4, RECALL({ diver_n: 2 })]] });
    expect((await buildAccuracyDigest())!.recallOwn).toBeNull();
  });

  it('buckets today\'s flyers/divers by their prior call into correct/wrong/neutral', async () => {
    await seed({
      stats: [['2026-08-11', 2000, 9, RECALL({ any: 0.2, diver_n: 6 })]],
      retro: [
        // flyers (positive return) — prior Buy/Strong Buy = correct, Sell/Strong Sell = wrong
        ['F1', '2026-08-11', 12.0, 0, 'Buy'],
        ['F2', '2026-08-11', 9.0, 0, 'Strong Buy'],
        ['F3', '2026-08-11', 7.0, 1, 'Sell'],
        ['F4', '2026-08-11', 6.0, 1, 'Strong Sell'],
        ['F5', '2026-08-11', 5.0, 0, 'Hold'],
        ['F6', '2026-08-11', 4.0, 0, null],
        // divers (negative return) — prior Sell/Strong Sell = correct, Buy/Strong Buy = wrong
        ['D1', '2026-08-11', -8.0, 0, 'Sell'],
        ['D2', '2026-08-11', -7.0, 0, 'Strong Sell'],
        ['D3', '2026-08-11', -6.0, 1, 'Buy'],
        ['D4', '2026-08-11', -5.0, 0, 'Hold'],
        ['D5', '2026-08-11', -4.0, 0, null],
      ],
    });
    const d = await buildAccuracyDigest();
    expect(d!.flyerCalls).toEqual({ correct: 2, wrong: 2, hold: 1, unrated: 1 });
    expect(d!.diverCalls).toEqual({ correct: 2, wrong: 1, hold: 1, unrated: 1 });
    // confirmed = Buy/Strong Buy flyers ordered by return desc
    expect(d!.confirmedCalls.map(c => c.symbol)).toEqual(['F1', 'F2']);
    expect(d!.confirmedCalls[0]).toMatchObject({ returnPct: 12.0, priorClassification: 'Buy' });
  });
});

// Typed as the interface itself, not a hand-mirrored shape: a hand-mirrored one went stale the
// first time a field was added and failed as a type error in every case that spread it. Module
// scope so every describe below shares one source of truth for the digest's shape.
const base: AccuracyDigest = {
  date: '2026-08-11', flyers: 10, divers: 4, universeN: 2000,
  recallOwn: 0.3, precisionOwn: 0.1, sellRatedN: 0, buyRatedN: 0,
  wrongBearish: 0, wrongBullish: 0,
  trend: [{ date: '2026-08-11', recall: 0.3 }],
  worstCalls: [],
  liquidFlyers: 0, confirmedMeanReturnPct: null, confirmedMeanOpenToClosePct: null,
  flyerCalls: { correct: 0, wrong: 0, hold: 0, unrated: 0 },
  diverCalls: { correct: 0, wrong: 0, hold: 0, unrated: 0 },
  confirmedCalls: [],
};

describe('formatAccuracyDigest', () => {
  it('flags recall below the floor with an alarm marker', () => {
    const low = formatAccuracyDigest({ ...base, recallOwn: RECALL_ALERT_FLOOR - 0.01 });
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
    expect(formatAccuracyDigest({ ...base, recallOwn: null })).toContain('n/a');
  });

  it('omits the wrong-direction block entirely when there were none', () => {
    expect(formatAccuracyDigest(base)).not.toContain('Wrong-direction');
  });

  it('renders the flyer/diver direction split with percentages of the movers total', () => {
    const out = formatAccuracyDigest({
      ...base,
      flyers: 128, divers: 80,
      flyerCalls: { correct: 11, wrong: 16, hold: 70, unrated: 31 },
      diverCalls: { correct: 22, wrong: 1, hold: 40, unrated: 17 },
    });
    // 11/128 → 9%, 16/128 → 12.5 → rounds to 13%, 70/128 → 55%; 22/80 → 28%, 1/80 → 1%.
    expect(out).toContain('Made high (flyers) 128');
    expect(out).toContain('as recommended (Buy/Strong Buy) 11 (9%)');
    expect(out).toContain('we said Sell/Strong Sell 16 (13%)');
    expect(out).toContain('Hold 70 (55%)');
    expect(out).toContain('not ranked 31 (24%)');
    expect(out).toContain('Made low (divers) 80');
    expect(out).toContain('as recommended (Sell/Strong Sell) 22 (28%)');
    expect(out).toContain('we said Buy/Strong Buy 1 (1%)');
  });

  it('omits the split when nothing had a directional prior call', () => {
    expect(formatAccuracyDigest(base)).not.toContain('Made high');
    expect(formatAccuracyDigest(base)).not.toContain('Made low');
  });

  it('lists confirmed as-recommended flyers and sanitizes their dynamic text', () => {
    const out = formatAccuracyDigest({
      ...base,
      confirmedCalls: [
        { symbol: 'GOACARBON', returnPct: 20.0, priorClassification: 'Strong Buy' },
        { symbol: 'BAJAJ_AUTO*', returnPct: 12.5, priorClassification: 'Buy' },
      ],
    });
    expect(out).toContain('Confirmed as recommended');
    expect(out).toContain('GOACARBON +20.0% (we said Strong Buy)');
    const confirmedLine = out.split('\n').find(l => l.includes('BAJAJ'))!;
    expect(confirmedLine).not.toMatch(/[_*`[\]]/);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-07: three defects this report shipped with, each measured against
// live production before the fix (see docs/audit-findings.md AF-20261007-01..03).
// ---------------------------------------------------------------------------
describe('honest-headline fixes (AF-20261007-01/02/03)', () => {
  beforeEach(async () => { await seed({}); });


  it('reports OUR ranking\'s recall, not the union — the union includes a source that flags 87% of the universe', async () => {
    // Live 2026-10-06: recall.signals = 1.0 on flagged_n 2101 of universe 2424, so recall.any
    // was pinned at 100% every day for a week. Only recall.unified varies and can be wrong.
    await seed({
      stats: [['2026-10-06', 2424, 158, RECALL({
        unified: 0.19, signals: 1.0, any: 1.0,
        precision: { unified: 0.188, signals: 0.075 }, diver_n: 58,
      })]],
    });
    const d = await buildAccuracyDigest();
    expect(d!.recallOwn).toBeCloseTo(0.19);
    expect(d!.precisionOwn).toBeCloseTo(0.188);
    expect(d!.universeN).toBe(2424);
    // The trend line must track the same varying series, not the pinned union.
    expect(d!.trend[0].recall).toBeCloseTo(0.19);
  });

  it('separates Hold from no-row — 49% of live flyers were rated Hold, which is an opinion', async () => {
    await seed({
      stats: [['2026-10-06', 2424, 3, RECALL({ unified: 0.2, diver_n: 2 })]],
      retro: [
        ['F1', '2026-10-06', 5.0, 0, 'Hold'],
        ['F2', '2026-10-06', 5.0, 0, 'Hold'],
        ['F3', '2026-10-06', 5.0, 0, null],
        ['D1', '2026-10-06', -5.0, 0, 'Hold'],
        ['D2', '2026-10-06', -5.0, 0, null],
      ],
    });
    const d = await buildAccuracyDigest();
    expect(d!.flyerCalls).toEqual({ correct: 0, wrong: 0, hold: 2, unrated: 1 });
    expect(d!.diverCalls).toEqual({ correct: 0, wrong: 0, hold: 1, unrated: 1 });
  });

  it('prints the chance expectation beside the wrong-direction count', () => {
    // Live 2026-10-06: 298 Sell/Strong Sell names, flyer base rate 158/2424 = 6.5%
    // -> ~19 expected to fly by chance. The report screamed "15" as a failure.
    const out = formatAccuracyDigest({
      ...base, flyers: 158, divers: 58, universeN: 2424,
      sellRatedN: 298, buyRatedN: 179, wrongBearish: 14, wrongBullish: 1,
    });
    const line = out.split('\n').find(l => l.includes('Wrong-direction'))!;
    expect(line).toMatch(/expected by chance/i);
    expect(line).toMatch(/24/);   // 298*158/2424 + 179*58/2424 = ~24 expected
    expect(line).not.toMatch(/🚨|← /);       // 15 observed < 21 expected: not an alarm
  });

  it('does alarm when wrong-direction calls exceed the chance expectation', () => {
    const out = formatAccuracyDigest({
      ...base, flyers: 158, divers: 58, universeN: 2424,
      sellRatedN: 298, buyRatedN: 179, wrongBearish: 60, wrongBullish: 0,
    });
    expect(out.split('\n').find(l => l.includes('Wrong-direction'))!).toMatch(/worse than chance/i);
  });

  it('never divides by a zero universe', () => {
    const out = formatAccuracyDigest({
      ...base, flyers: 0, divers: 0, universeN: 0,
      sellRatedN: 0, buyRatedN: 0, wrongBearish: 3, wrongBullish: 0,
    });
    expect(out).not.toMatch(/NaN|Infinity/);
  });

  it('formatAccuracyScorecard is the 3-line form the morning brief embeds', () => {
    const s = formatAccuracyScorecard({
      ...base, flyers: 158, divers: 58, universeN: 2424, recallOwn: 0.19, precisionOwn: 0.188,
      sellRatedN: 298, buyRatedN: 179, wrongBearish: 14, wrongBullish: 1,
      flyerCalls: { correct: 30, wrong: 14, hold: 77, unrated: 37 },
    });
    // The scorecard's chance figure must match the full digest's: both are printed beside
    // the TOTAL wrong-direction count, so both count both halves (298*6.5% + 179*2.4% = ~24).
    expect(s).toMatch(/24/);
    expect(s.split('\n').length).toBeLessThanOrEqual(4);
    expect(s).toContain('158');
    expect(s).toMatch(/base/i);           // the lift is only readable against the base rate
    expect(s).not.toMatch(/NaN|undefined/);
  });
});

// ---------------------------------------------------------------------------
// AF-20261007-06: return_pct is close-to-close, so for a mover detected on day D it
// includes an overnight gap nobody could have bought. The digest now reports the
// capturable half beside it, and how much of the population is tradeable at all.
// ---------------------------------------------------------------------------
describe('capturable-move reporting (AF-20261007-06)', () => {
  it('reads the mean close-to-close and open-to-close of the calls we got right', async () => {
    await seed({
      stats: [['2026-10-06', 2424, 3, RECALL({ unified: 0.2, diver_n: 0 })]],
      retro: [
        // [symbol, date, return_pct, wrong_call, prior, open_to_close_pct, adt_20d]
        ['A', '2026-10-06', 10.0, 0, 'Buy', 1.0, 500_000_000],
        ['B', '2026-10-06', 6.0, 0, 'Strong Buy', -1.0, 200_000_000],
        ['C', '2026-10-06', 8.0, 0, 'Hold', 7.0, 1_000_000],
      ],
    });
    const d = await buildAccuracyDigest();
    // Only the Buy/Strong Buy flyers: mean c2c (10+6)/2 = 8, mean o2c (1-1)/2 = 0.
    expect(d!.confirmedMeanReturnPct).toBeCloseTo(8.0);
    expect(d!.confirmedMeanOpenToClosePct).toBeCloseTo(0.0);
    // Tradeable bar applies to ALL flyers: A (Rs 50cr) and B (Rs 20cr) clear Rs 10cr, C (Rs 0.1cr) does not.
    expect(d!.liquidFlyers).toBe(2);
  });

  it('reports nulls, not zeros, when the columns were never populated', async () => {
    await seed({
      stats: [['2026-10-06', 2424, 1, RECALL({ unified: 0.2, diver_n: 0 })]],
      retro: [['A', '2026-10-06', 10.0, 0, 'Buy', null, null]],
    });
    const d = await buildAccuracyDigest();
    expect(d!.confirmedMeanOpenToClosePct).toBeNull();
    expect(d!.liquidFlyers).toBe(0);
  });

  it('names the gap as the uncapturable part when open-entry is far below close-to-close', () => {
    const out = formatAccuracyDigest({
      ...base, flyers: 158, universeN: 2424, liquidFlyers: 41,
      confirmedMeanReturnPct: 5.45, confirmedMeanOpenToClosePct: 0.31,
      flyerCalls: { correct: 30, wrong: 14, hold: 77, unrated: 37 },
    });
    const line = out.split('\n').find(l => /from the open/i.test(l))!;
    expect(line).toContain('5.45');
    expect(line).toContain('0.31');
    expect(out).toMatch(/41 of 158/);       // the tradeable share of the population
  });

  it('omits the capturable line rather than printing n/a when nothing is measured', () => {
    const out = formatAccuracyDigest({ ...base, confirmedMeanOpenToClosePct: null });
    expect(out).not.toMatch(/from the open/i);
    expect(out).not.toMatch(/NaN/);
  });
});
