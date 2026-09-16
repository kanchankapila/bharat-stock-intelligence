import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every `*.live.test.ts` must declare how it avoids fabricating a trading date.
 *
 * A live_datasource test writes GENUINE production rows on purpose (vite.config.ts: proving a
 * fetcher writes correct real rows is the whole job). That is fine right up until the row is
 * keyed on a DATE the test stamps as "today" — then running it on a Saturday asserts the market
 * did something on a day it was shut. Measured cost, 2026-08-16: liveStockData.live.test.ts
 * called fetchAndPersistOHLCVData() directly, bypassing the weekday guard that lives one level
 * up in queues.ts's processStockRefresh(), and wrote 2,148 rows dated Saturday 2026-08-16 —
 * 2,141 of them byte-identical to the Thursday close. An earlier batch (2026-07-11, 2,152 rows)
 * is still in production, unexplained and uncleaned.
 *
 * That guard CANNOT be pushed down into the shared service: a blanket weekend refusal would also
 * block NSE's genuine Saturday sessions (Budget day, Muhurat — stock_ohlcv holds five). So it has
 * to be mirrored at every caller, and recurring-bugs.md's own rule for that shape is that it
 * "needs a test that fails when a caller forgets". This is that test; it did not exist, and the
 * two files that have the guard got it by hand after the incident.
 *
 * Checked 2026-08-17: all 10 files are currently correct, and 8 of them need no guard at all —
 * they anchor on a real completed session, or write only provider-supplied dates and fetched_at
 * timestamps. Blanket-adding `it.runIf(IS_TRADING_DAY)` to those would be ceremony that makes the
 * real two harder to spot. So the requirement is a DECLARATION, not a guard: say which case you
 * are, and a new file cannot silently be neither.
 */
const TESTS_DIR = __dirname;
const GUARD = 'shouldSkipOnTradingHoliday';
const SAFE_MARKER = /LIVE_DATE_SAFE:\s*(\S.{15,})/;

describe('every live test declares whether it can fabricate a trading date', () => {
  const files = readdirSync(TESTS_DIR).filter(f => f.endsWith('.live.test.ts'));

  it('finds the live test files at all (a rename must not silently empty this suite)', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)('%s declares a guard or a reason it needs none', file => {
    const src = readFileSync(resolve(TESTS_DIR, file), 'utf-8');
    const guarded = src.includes(GUARD);
    const declaredSafe = SAFE_MARKER.test(src);

    expect(
      guarded || declaredSafe,
      `${file} neither gates its writes on ${GUARD}() nor carries a "LIVE_DATE_SAFE: <reason>" ` +
      `comment. If it persists a row keyed on today's date, gate it the way ` +
      `liveStockData.live.test.ts does — reuse the real caller's guard, never a hand-rolled ` +
      `getDay() check, which drifts and misses weekday holidays. If it cannot fabricate a date ` +
      `(anchors on MAX(date) of a completed session, or writes only provider dates / fetched_at), ` +
      `say so in a LIVE_DATE_SAFE comment naming the reason.`,
    ).toBe(true);

    // Both is contradictory: it claims the writes are date-safe AND gates them on the date.
    expect(
      guarded && declaredSafe,
      `${file} claims LIVE_DATE_SAFE but also gates on ${GUARD}() — one of the two is wrong.`,
    ).toBe(false);
  });
});
