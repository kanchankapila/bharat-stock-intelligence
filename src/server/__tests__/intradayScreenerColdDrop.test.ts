import { describe, it, expect } from 'vitest';
import { selectIntradayScreeners, INTRADAY_TRIAL_MS } from '../trendlyneScreener';

// 2026-10-28: "84/84 active (0 cold-dropped)" on every cycle. The 17 never-signalled screeners
// (30-min CCI/Williams/ROC) returned nothing ~150 times each: a screener that never signals
// stays "new" forever, so its one trial run was every 15 minutes, against Trendlyne's rationed
// request allowance.
describe('selectIntradayScreeners', () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  const s = (screener_name: string) => ({ screener_name });

  it('keeps a screener that signalled inside the active window', () => {
    const { scan } = selectIntradayScreeners([s('A')], new Set(['A']), new Set(['A']), new Map(), now);
    expect(scan.map(x => x.screener_name)).toEqual(['A']);
  });

  it('drops a screener whose last signal is older than the active window', () => {
    const { scan } = selectIntradayScreeners([s('B')], new Set(), new Set(['B']), new Map(), now);
    expect(scan).toEqual([]);
  });

  it('starts a trial for a never-signalled screener seen for the first time', () => {
    const { scan, newTrials } = selectIntradayScreeners([s('C')], new Set(), new Set(), new Map(), now);
    expect(scan.map(x => x.screener_name)).toEqual(['C']);
    expect(newTrials).toEqual([['C', now]]);
  });

  it('keeps a never-signalled screener while its trial is running', () => {
    const trials = new Map([['C', now - INTRADAY_TRIAL_MS + 60_000]]);
    const { scan, newTrials } = selectIntradayScreeners([s('C')], new Set(), new Set(), trials, now);
    expect(scan.map(x => x.screener_name)).toEqual(['C']);
    expect(newTrials).toEqual([]);
  });

  it('drops a never-signalled screener once its trial has expired', () => {
    const trials = new Map([['C', now - INTRADAY_TRIAL_MS - 1]]);
    const { scan } = selectIntradayScreeners([s('C')], new Set(), new Set(), trials, now);
    expect(scan).toEqual([]);
  });
});
