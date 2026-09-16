import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { catchupFetcherFor } from '../jobs/trendlyneWeekly.jobs';

/**
 * trendlyne.com's AWS WAF allowance is a per-session REQUEST COUNT (~131-150, measured
 * 2026-08-17), not a rate — so no pacing gets a 2,234-symbol universe through in one pass, and
 * the four per-symbol fetchers share ONE allowance because they share one source IP.
 *
 * The catch-up job therefore runs exactly one fetcher per 20-minute slot, rotating off the wall
 * clock so a restart doesn't always replay the same one. These pin that contract.
 */
describe('trendlyne-catchup fetcher rotation', () => {
  const SLOT = 20 * 60_000;

  it('runs exactly one fetcher per slot, cycling through all four', () => {
    const base = Date.UTC(2026, 7, 18, 0, 0);
    const seen = [0, 1, 2, 3].map(i => catchupFetcherFor(new Date(base + i * SLOT)));
    expect(new Set(seen).size).toBe(4);              // all four, no repeats within a cycle
    expect(seen).toContain('trendlyne_adv_tech_fetcher.py');
    expect(seen).toContain('trendlyne_price_analysis_fetcher.py');
    expect(seen).toContain('trendlyne_overview_fetcher.py');
    expect(seen).toContain('trendlyne_fundamentals_fetcher.py');
  });

  it('is stable within a slot and advances across one', () => {
    const t = Date.UTC(2026, 7, 18, 3, 0);
    expect(catchupFetcherFor(new Date(t))).toBe(catchupFetcherFor(new Date(t + 60_000)));
    expect(catchupFetcherFor(new Date(t))).not.toBe(catchupFetcherFor(new Date(t + SLOT)));
  });

  it('repeats with a period of exactly four slots', () => {
    const base = Date.UTC(2026, 7, 18, 11, 40);
    for (let i = 0; i < 4; i++) {
      expect(catchupFetcherFor(new Date(base + i * SLOT)))
        .toBe(catchupFetcherFor(new Date(base + (i + 4) * SLOT)));
    }
  });

  // The whole design rests on each fetcher taking a bounded slice AND skipping what it already
  // has. A fetcher with the cap but no resume would re-fetch the same leading rows forever —
  // that is precisely what pinned trendlyne_price_analysis at 145/2234.
  it('every rotated fetcher both caps its run and resumes from the DB', () => {
    const scripts = [0, 1, 2, 3].map(i => catchupFetcherFor(new Date(Date.UTC(2026, 7, 18) + i * SLOT)));
    for (const script of scripts) {
      const src = readFileSync(resolve(__dirname, '..', script), 'utf-8');
      expect(src, `${script} must bound its per-run request count`).toContain('cap_to_run_budget');
      const resumes = src.includes('skip_done_for_date') || src.includes('only_unsynced');
      expect(resumes, `${script} must skip rows it already has, or the cap never advances`).toBe(true);
    }
  });
});
