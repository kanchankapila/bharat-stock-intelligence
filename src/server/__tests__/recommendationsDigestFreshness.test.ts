import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 2026-11-12 (AF-20261112-02): the 22:40 digest is a cron offset after the 22:30 ranker, and the
// ranker's 11-11 run took 14.9 min. What keeps a slow night from sending the PREVIOUS ranking is
// unifiedRankingIsFresh(): it waits for a ranking generated on the current IST date. No test pinned
// that gate; this one does.

let rankingGeneratedAt = '';
const sendRecommendationsDigest = vi.fn();
const istDate = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

vi.mock('../telegramRecommendations', () => ({
  sendRecommendationsDigest: (...a: unknown[]) => sendRecommendationsDigest(...a),
}));
vi.mock('../jobWatchdog', () => ({ buildDailyDigest: vi.fn() }));
vi.mock('../telegramService', () => ({ telegramService: { sendMarkdownMessage: vi.fn() } }));
vi.mock('../jobs/registerJob', () => ({ registerRepeatableJob: vi.fn() }));
vi.mock('../dbAsync', () => ({
  dbRun: vi.fn(async () => undefined),
  dbGet: vi.fn(async (sql: string) => {
    if (/FROM app_settings/i.test(sql)) return undefined;
    if (/MAX\(generated_at\)/i.test(sql)) {
      return { generated_at: rankingGeneratedAt, g: rankingGeneratedAt, d: istDate(rankingGeneratedAt) };
    }
    if (/FROM technical_signals/i.test(sql)) return { d: istDate(new Date().toISOString()) };
    return undefined;
  }),
}));

describe('recommendations digest never sends a previous-day ranking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T17:10:00Z')); // 22:40 IST
    sendRecommendationsDigest.mockReset();
    sendRecommendationsDigest.mockResolvedValue({ sent: true, picks: 10 });
  });
  afterEach(() => vi.useRealTimers());

  it('waits out its budget and skips when only the 11-09 ranking exists', async () => {
    rankingGeneratedAt = '2026-11-09T17:00:02Z';
    const { processRecommendationsDigest } = await import('../jobs/digests.jobs');
    const run = processRecommendationsDigest();
    await vi.advanceTimersByTimeAsync(80 * 60_000);
    const res = await run;
    expect(sendRecommendationsDigest).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: false });
  });

  it('sends as soon as tonight\'s ranking is present', async () => {
    rankingGeneratedAt = '2026-11-11T17:00:08Z';
    const { processRecommendationsDigest } = await import('../jobs/digests.jobs');
    await processRecommendationsDigest();
    expect(sendRecommendationsDigest).toHaveBeenCalledTimes(1);
  });
});
