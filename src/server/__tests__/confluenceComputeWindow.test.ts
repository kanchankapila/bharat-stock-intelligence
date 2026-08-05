import { describe, expect, it } from 'vitest';
import { isConfluenceComputeWindow } from '../jobs/confluence.jobs';

/**
 * 2026-08-04 job-timing audit: confluence-compute ticks every 30 min and already skips during
 * market hours (isMarketOpen()), but had no further gate -- so ~15-17 nightly ticks between
 * ~00:30-08:00 IST recomputed the whole-universe positional signal against provably-unchanged
 * input (technical_signals/screener tables/stock_scores/quant_scores all static in that window).
 * isConfluenceComputeWindow() restricts real work to the evening data-landing window
 * (18:00-23:59 IST screener syncs -> ml-daily-ops -> stock-scoring/quant-scoring/
 * confluence-outcomes -> dl-inference -> screener-performance) plus a short pre-open refresh
 * window (06:00-07:59 IST, ahead of unified-ranker at 07:30).
 *
 * Builds a Date such that isConfluenceComputeWindow's own `now + 5.5h` conversion lands on
 * `istHour:15` IST wall-clock time (arbitrary safely-mid-hour minute) — computed as pure
 * millisecond arithmetic to avoid hand-rolled hour/minute-split bugs.
 */
function utcDateForIstHour(istHour: number): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const targetIstMs = Date.UTC(2026, 0, 5, istHour, 15, 0);
  return new Date(targetIstMs - IST_OFFSET_MS);
}

describe('isConfluenceComputeWindow', () => {
  it('is true across the evening data-landing window (18:00-23:59 IST)', () => {
    for (const hour of [17, 18, 20, 22, 23]) {
      expect(isConfluenceComputeWindow(utcDateForIstHour(hour))).toBe(true);
    }
  });

  it('is true during the pre-open refresh window (06:00-07:59 IST)', () => {
    expect(isConfluenceComputeWindow(utcDateForIstHour(6))).toBe(true);
    expect(isConfluenceComputeWindow(utcDateForIstHour(7))).toBe(true);
  });

  it('is false through the dead overnight window (00:00-05:59 IST)', () => {
    for (const hour of [0, 1, 2, 3, 4, 5]) {
      expect(isConfluenceComputeWindow(utcDateForIstHour(hour))).toBe(false);
    }
  });

  it('is false in the daytime gap before the evening landing window resumes (08:00-16:59 IST)', () => {
    for (const hour of [8, 10, 12, 14, 16]) {
      expect(isConfluenceComputeWindow(utcDateForIstHour(hour))).toBe(false);
    }
  });
});
