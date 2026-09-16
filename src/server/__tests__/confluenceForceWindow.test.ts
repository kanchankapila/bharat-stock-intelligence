import { describe, it, expect } from 'vitest';
import { isConfluenceComputeWindow, shouldComputeConfluence } from '../jobs/confluence.jobs';

/**
 * confluence-compute only runs at IST hours 06-07 and 17-23 -- outside those, its inputs are
 * provably static and recomputing is waste. Correct, but it leaves no way to CATCH UP after a
 * window is missed, and a missed window is not hypothetical: a deploy, a restart, or this
 * session's own sweep pause on 2026-09-05 all skip one, after which confluence_signals ages
 * from 9h (healthy maximum) to 22h and the critical freshness check pages until the next
 * window opens hours later.
 *
 * A force flag mirrors the bypass ml-daily-ops already has (`closed-day-early`): the gate stays
 * the default, and an operator can explicitly ask for the catch-up the schedule cannot express.
 */
describe('shouldComputeConfluence', () => {
  const inWindow = new Date(Date.UTC(2026, 8, 6, 12, 30));    // 18:00 IST -> evening window
  const outOfWindow = new Date(Date.UTC(2026, 8, 6, 6, 30));  // 12:00 IST -> static inputs

  it('agrees with the window predicate when not forced', () => {
    expect(shouldComputeConfluence({ now: inWindow })).toBe(true);
    expect(shouldComputeConfluence({ now: outOfWindow })).toBe(false);
    expect(isConfluenceComputeWindow(inWindow)).toBe(true);
    expect(isConfluenceComputeWindow(outOfWindow)).toBe(false);
  });

  it('computes outside the window when explicitly forced', () => {
    expect(shouldComputeConfluence({ now: outOfWindow, force: true })).toBe(true);
  });

  it('force does not change behaviour inside the window', () => {
    expect(shouldComputeConfluence({ now: inWindow, force: true })).toBe(true);
  });

  it('only an explicit true forces -- a truthy-looking payload does not', () => {
    // Job data arrives from Redis as JSON, so guarding on `=== true` keeps a stray
    // `force: "false"` or `force: 0` from silently defeating the gate.
    for (const v of ['false', '0', 0, '', null, undefined] as any[]) {
      expect(shouldComputeConfluence({ now: outOfWindow, force: v })).toBe(false);
    }
  });
});
