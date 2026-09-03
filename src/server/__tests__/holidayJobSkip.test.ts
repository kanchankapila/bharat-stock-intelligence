import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { shouldSkipOnTradingHoliday } from '../marketStatusService';

/**
 * 2026-08-06: on a mid-week trading holiday (NSE shut, but cron's own weekday pattern still
 * fires) every routine evening/night job used to duplicate work that either (a) closed-day-
 * early-batch already ran that morning, or (b) has no new data to act on at all -- the exchange
 * never opened, so re-fetching/re-scoring reproduces yesterday's result. shouldSkipOnTradingHoliday
 * is the shared gate wired into each of those processors; a job dispatched BY closed-day-early-
 * batch itself (job.name === 'closed-day-early') must NEVER be skipped by it, or the morning
 * dispatch would be a no-op.
 */
describe('shouldSkipOnTradingHoliday', () => {
  const originalFetch = global.fetch;
  // Pinned to a known Wednesday (IST) so these holiday/normal-day tests are never accidentally
  // flaky depending on which real-world weekday the suite happens to run on -- 2026-08-09 (the
  // date this weekend-skip behavior was added) is itself a Sunday, which would otherwise make
  // every one of these tests fail against the new weekend short-circuit below.
  const WEEKDAY_NOON_UTC = new Date('2026-08-05T12:00:00Z'); // Wednesday

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_NOON_UTC);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('never skips a closed-day-early dispatch, and never even checks the holiday status', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'closed-day-early' });

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never skips when no job is passed at all (defensive default)', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ currentMarketStatus: 'Live', purpose: 'Normal Market' }),
    }));
    global.fetch = fetchSpy as any;

    expect(await shouldSkipOnTradingHoliday(undefined)).toBe(false);
    expect(await shouldSkipOnTradingHoliday(null)).toBe(false);
  });

  it('skips a normal cron-triggered job on a genuine trading holiday', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ currentMarketStatus: 'Closed', purpose: 'Independence Day Holiday' }),
    })) as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'mc-sync' });
    expect(result).toBe(true);
  });

  it('does not skip a normal cron-triggered job on a normal trading day', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ currentMarketStatus: 'Live', purpose: 'Normal Market' }),
    })) as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'mc-sync' });
    expect(result).toBe(false);
  });
});

/**
 * 2026-08-09: every current caller's own cron is weekday-only, but BullMQ's
 * addJobWithCatchup "was the last scheduled occurrence missed" recovery path does NOT respect
 * the day-of-week field -- confirmed live, a server restart fired catchup runs for
 * stock-refresh/technical-scan/etnow-screener-sync/et-marketstats-sync/mc-screener-sync on a
 * real Sunday, several of which re-wrote stale/duplicate data (stock_ohlcv rows dated that
 * Sunday, byte-identical to the prior Friday's bar) because isTradingHolidayToday() itself
 * deliberately treats a weekend as "not a holiday".
 */
describe('shouldSkipOnTradingHoliday — weekend catchup-bypass fix', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('skips on a Saturday without ever calling the holiday-status fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:00Z')); // Saturday
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'mc-sync' });

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips on a Sunday without ever calling the holiday-status fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z')); // Sunday
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'stock-refresh' });

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still never skips a closed-day-early dispatch even on a weekend', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z')); // Sunday
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'closed-day-early' });

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('correctly straddles the UTC/IST day boundary (late Friday UTC is already Saturday IST)', async () => {
    // 2026-08-07 21:00 UTC = 2026-08-08 02:30 IST -- Saturday in IST, Friday in UTC. A naive
    // UTC-only getDay() would wrongly treat this as a weekday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T21:00:00Z'));
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await shouldSkipOnTradingHoliday({ name: 'mc-sync' });

    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Wiring checks: every job this session gated must call shouldSkipOnTradingHoliday as its
 * FIRST real statement, before any of its actual fetch/sync/score logic. A source-inspection
 * check (not a full mock-and-invoke test per job) is deliberate here -- these processors reach
 * deep into live services (moneycontrolScreener, etnowScreenerSync, liveStockData,
 * quantScoringService, ...) that would need extensive mocking to exercise behaviorally, and the
 * actual defect class this guards against (someone adds a 15th evening job and forgets the
 * guard, or someone "cleans up" an existing one and drops it) is exactly what a textual presence
 * check catches -- same convention as jobPipelineOrdering.test.ts's source-parsing checks.
 */
describe('holiday-skip guard is wired into every targeted evening/night job', () => {
  const fs = require('fs');
  const path = require('path');

  function read(relPath: string): string {
    return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf-8');
  }

  const screenersJobsSrc = read('jobs/screeners.jobs.ts');
  const queuesSrc = read('queues.ts');
  const operationsJobsSrc = read('jobs/operations.jobs.ts');
  const confluenceJobsSrc = read('jobs/confluence.jobs.ts');
  const dlJobsSrc = read('jobs/dl.jobs.ts');
  const syncJobsSrc = read('jobs/sync.jobs.ts');

  function assertGuarded(src: string, functionName: string) {
    const fnStart = src.indexOf(`function ${functionName}(`);
    expect(fnStart, `${functionName} not found`).toBeGreaterThanOrEqual(0);
    // Look at the next ~700 chars of the function body for the guard call -- generous enough
    // to cover a short explanatory comment block before it, tight enough to prove it's early.
    const body = src.slice(fnStart, fnStart + 700);
    expect(body, `${functionName} does not call shouldSkipOnTradingHoliday early in its body`)
      .toContain('shouldSkipOnTradingHoliday');
  }

  it('screeners.jobs.ts: mc/etnow/et-marketstats/trendlyne screener syncs + stock/quant scoring', () => {
    for (const fn of [
      'processMcScreenerSync', 'processEtnowScreenerSync', 'processEtMarketstatsSync',
      'processTrendlyneScreenerSync', 'processStockScoring', 'processQuantScoring',
    ]) {
      assertGuarded(screenersJobsSrc, fn);
    }
  });

  it('queues.ts: stock-refresh, ohlcv-gap-fill-daily, quant-eod-sync, ml-daily-ops, unified-ranker', () => {
    for (const fn of ['processStockRefresh', 'processQuantEodSync', 'processMlDailyOps']) {
      assertGuarded(queuesSrc, fn);
    }
    // ohlcv-backfill and unified-ranker are inline Worker callbacks, not named functions --
    // check the guard text appears near their distinguishing log lines instead.
    expect(queuesSrc).toContain("job.name === 'ohlcv-gap-fill-daily' && await shouldSkipOnTradingHoliday(job)");
    const urIdx = queuesSrc.indexOf('unified-ranker starting');
    expect(urIdx).toBeGreaterThanOrEqual(0);
    expect(queuesSrc.slice(urIdx - 300, urIdx)).toContain('shouldSkipOnTradingHoliday');
  });

  it('operations.jobs.ts: outcome-resolver', () => {
    assertGuarded(operationsJobsSrc, 'processOutcomeResolver');
  });

  it('confluence.jobs.ts: confluence-outcomes', () => {
    assertGuarded(confluenceJobsSrc, 'processConfluenceOutcomes');
  });

  it('dl.jobs.ts: dl-feature-refresh, dl-inference', () => {
    assertGuarded(dlJobsSrc, 'processDlFeatureRefresh');
    assertGuarded(dlJobsSrc, 'processDlInference');
  });

  it('sync.jobs.ts: screener-performance (2026-08-07 — the one job this session\'s first pass missed)', () => {
    // A daily (Mon-Fri) 10-step, up-to-145-min chain re-deriving Bayesian tier scores from
    // screener_appearances/signal_outcomes/stock_ohlcv -- structurally identical to
    // processStockScoring/processQuantScoring above, but sync.jobs.ts wasn't touched in the
    // first pass over this bug class.
    assertGuarded(syncJobsSrc, 'processScreenerPerf');
  });

  it('closed-day-early-batch itself is never gated by its own mechanism (would deadlock the dispatch)', () => {
    // The dispatcher's own worker checks isTradingHolidayToday() directly (need the OPPOSITE
    // polarity -- run the dispatch ONLY on a holiday, not skip on one), never
    // shouldSkipOnTradingHoliday, which would always return false for a job named
    // 'closed-day-early-batch' and defeat the whole point.
    const idx = queuesSrc.indexOf("Trading holiday — running daily pipeline early");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(queuesSrc.slice(idx - 400, idx)).toContain('isTradingHolidayToday()');
  });

  it('does not stamp a skipped stock-refresh as a successful data run', () => {
    expect(queuesSrc).toContain('return { count: 0, persisted: 0, skipped: true }');
    const completedIdx = queuesSrc.indexOf("stockWorker.on('completed'");
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    const completedBody = queuesSrc.slice(completedIdx, completedIdx + 500);
    expect(completedBody).toContain('if (result.skipped)');
    expect(completedBody.indexOf('recordHeartbeat')).toBeGreaterThan(completedBody.indexOf('return;'));
  });
});
