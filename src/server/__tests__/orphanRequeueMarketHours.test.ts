import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requeueOrphanedJob, HEAVY_MAKEUP_JOBS, msUntilMarketCloseIST } from '../jobs/registerJob';

/**
 * A make-up run for a multi-hour trainer must not start while NSE is open.
 *
 * Measured 2026-09-17 over 30 days of job_run_history: ml-weekly-retrain is scheduled
 * '0 5 * * 6' (Saturday) but only 1 of its last 6 runs actually started on a Saturday. The
 * others were orphan make-ups, and two of them (Thu 10 02:22 UTC +193min, Fri 11 04:54 UTC
 * +111min) ran straight through the 09:15-15:30 IST session. Every overlap between
 * ml-weekly-retrain and an intraday capture job in that window involved a failure
 * (intraday-fetcher 15/15, live-screener-collect 14/14, trendlyne-intraday 13/13) -- the
 * trainer is the platform's heaviest job (17GB peak, 92-199 min) and it competes with the
 * 15-minute intraday cadence for the Python slots and for host RAM.
 *
 * requeueOrphanedJob's delay was a pure round-robin stagger with no market-hours awareness.
 */
vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn().mockResolvedValue(true) },
  sanitizeMarkdown: (t: string) => t,
}));

function fakeQueue() {
  return {
    name: 'q', add: vi.fn().mockResolvedValue(undefined),
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    getJobs: vi.fn().mockResolvedValue([]),
  } as any;
}
// 2026-09-18 is a Friday. 05:00 UTC = 10:30 IST (open); 13:00 UTC = 18:30 IST (closed).
const MID_SESSION = Date.parse('2026-09-18T05:00:00Z');
const AFTER_CLOSE = Date.parse('2026-09-18T13:00:00Z');

describe('msUntilMarketCloseIST', () => {
  it('is positive during the session and 0 outside it', () => {
    expect(msUntilMarketCloseIST(MID_SESSION)).toBeGreaterThan(0);
    expect(msUntilMarketCloseIST(AFTER_CLOSE)).toBe(0);
    // 10:30 IST -> 15:30 IST is 5h, plus the post-close buffer.
    expect(msUntilMarketCloseIST(MID_SESSION)).toBeGreaterThanOrEqual(5 * 3600_000);
    expect(msUntilMarketCloseIST(MID_SESSION)).toBeLessThan(6 * 3600_000);
  });
  it('covers the weekend as closed', () => {
    expect(msUntilMarketCloseIST(Date.parse('2026-09-19T05:00:00Z'))).toBe(0); // Saturday
  });
});

describe('requeueOrphanedJob market-hours deferral', () => {
  beforeEach(() => vi.restoreAllMocks());
  // setSystemTime mocks Date even without useFakeTimers. restoreAllMocks does not undo it.
  afterEach(() => vi.useRealTimers());

  it('defers a heavy trainer make-up past the close', async () => {
    vi.setSystemTime(MID_SESSION);
    const q = fakeQueue();
    const ok = await requeueOrphanedJob(q, { name: 'ml-weekly-retrain', id: 'x', processedOn: MID_SESSION - 60_000 });
    expect(ok).toBe(true);
    const delay = q.add.mock.calls[0][2].delay;
    expect(delay).toBeGreaterThanOrEqual(5 * 3600_000);
  });

  it('does NOT defer a light job -- it still fires promptly', async () => {
    vi.setSystemTime(MID_SESSION);
    const q = fakeQueue();
    await requeueOrphanedJob(q, { name: 'news-sentiment-refresh', id: 'y', processedOn: MID_SESSION - 60_000 });
    expect(q.add.mock.calls[0][2].delay).toBeLessThan(60 * 60_000);
  });

  it('does NOT defer a heavy job outside market hours', async () => {
    vi.setSystemTime(AFTER_CLOSE);
    const q = fakeQueue();
    await requeueOrphanedJob(q, { name: 'ml-weekly-retrain', id: 'z', processedOn: AFTER_CLOSE - 60_000 });
    expect(q.add.mock.calls[0][2].delay).toBeLessThan(60 * 60_000);
  });

  it('the heavy set names the jobs measured to be multi-hour', () => {
    expect(HEAVY_MAKEUP_JOBS.has('ml-weekly-retrain')).toBe(true);
    expect(HEAVY_MAKEUP_JOBS.has('dl-retrain-weekly')).toBe(true);
    expect(HEAVY_MAKEUP_JOBS.has('news-sentiment-refresh')).toBe(false);
  });
});
