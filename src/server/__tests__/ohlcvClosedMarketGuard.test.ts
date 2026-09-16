import { describe, it, expect } from 'vitest';
import { closedMarketShare, CLOSED_MARKET_SHARE_FLOOR } from '../liveStockData';

/**
 * AF-20260911-15. stock_ohlcv held 4 fabricated sessions — 2026-01-15, 2026-05-01, 2026-05-28,
 * 2026-06-26 — in which EVERY symbol carried open==high==low==close and volume 0 (7,515 bars,
 * essentially none flagged is_suspect). They are market holidays on which a live-quote refresh
 * persisted each stock's last close as a whole "trading day".
 *
 * Two things made them damaging rather than merely untidy:
 *   1. measurement.md's panel spec filters on `is_suspect = 1`, so unflagged fake bars entered
 *      every forward-return panel as a real session returning exactly 0%.
 *   2. market_holidays is DERIVED from "weekdays with no stock_ohlcv rows", so a fabricated bar
 *      permanently hides the very holiday that produced it.
 *
 * The calendar guard that exists (shouldSkipOnTradingHoliday -> isTradingHolidayToday) reads a
 * live BSE endpoint and returns false on ANY error, so it fails OPEN: one network blip on a
 * holiday reinstates the bug. This guard is deliberately calendar-free — it judges the shape of
 * the data, so it holds whatever the calendar says and cannot be circular.
 */
describe('closedMarketShare', () => {
  const bar = (o: number, h: number, l: number, c: number, v: number) =>
    ['SYM', '2026-05-01', o, h, l, c, v] as (string | number)[];

  it('reports 1.0 when every bar is flat with zero volume (the observed holiday shape)', () => {
    const rows = [bar(10, 10, 10, 10, 0), bar(20, 20, 20, 20, 0), bar(30, 30, 30, 30, 0)];
    expect(closedMarketShare(rows)).toBe(1);
    expect(closedMarketShare(rows)).toBeGreaterThanOrEqual(CLOSED_MARKET_SHARE_FLOOR);
  });

  // Negative control, and the reason this is a SHARE and not a per-row filter: a genuinely
  // illiquid scrip can print a flat zero-volume bar on a real trading day. Dropping those rows
  // individually would silently delete real data; only a universe-wide collapse means "closed".
  it('does NOT trip on a normal session containing a few illiquid flat bars', () => {
    const rows = [
      bar(10, 11, 9.5, 10.5, 120_000),
      bar(20, 21, 19, 20.5, 90_000),
      bar(30, 30, 30, 30, 0),          // illiquid, but real
      bar(40, 42, 39, 41, 15_000),
    ];
    expect(closedMarketShare(rows)).toBeCloseTo(0.25, 5);
    expect(closedMarketShare(rows)).toBeLessThan(CLOSED_MARKET_SHARE_FLOOR);
  });

  it('treats a moving price with zero volume as real (only flat AND zero-volume counts)', () => {
    const rows = [bar(10, 12, 9, 11, 0), bar(20, 22, 19, 21, 0)];
    expect(closedMarketShare(rows)).toBe(0);
  });

  it('treats a flat bar with real volume as real', () => {
    const rows = [bar(10, 10, 10, 10, 50_000), bar(20, 20, 20, 20, 1)];
    expect(closedMarketShare(rows)).toBe(0);
  });

  it('is 0 for an empty batch so an empty fetch is never misread as a closed market', () => {
    expect(closedMarketShare([])).toBe(0);
  });

  it('sets the floor high enough that the 4 observed sessions (100%) trip it', () => {
    // The real incidents were 100%; the floor must sit below that and above a plausible
    // illiquid share on a live session.
    expect(CLOSED_MARKET_SHARE_FLOOR).toBeGreaterThan(0.5);
    expect(CLOSED_MARKET_SHARE_FLOOR).toBeLessThanOrEqual(1);
  });
});
