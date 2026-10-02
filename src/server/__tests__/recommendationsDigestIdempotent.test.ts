import { describe, it, expect, vi, beforeEach } from 'vitest';

// AF-20261002-01: on 2026-10-02 (an NSE holiday) the recommendations digest was delivered three
// times -- 12:18, 14:26 and 22:40 IST -- two messages and ten picks each. The first two were
// fired by server restarts replaying the closed-day batch; the 22:40 send was built from the SAME
// 14:24 ranking as the 14:26 one, so it was byte-for-byte a repeat. Re-sending a ranking that was
// already delivered carries no information, so the digest is keyed to the ranking it was built from.

const store = new Map<string, string>();
let rankingGeneratedAt = '';
const sendRecommendationsDigest = vi.fn();

vi.mock('../telegramRecommendations', () => ({
  sendRecommendationsDigest: (...a: unknown[]) => sendRecommendationsDigest(...a),
}));
vi.mock('../jobWatchdog', () => ({ buildDailyDigest: vi.fn() }));
vi.mock('../telegramService', () => ({ telegramService: { sendMarkdownMessage: vi.fn() } }));
vi.mock('../jobs/registerJob', () => ({ registerRepeatableJob: vi.fn() }));
vi.mock('../dbAsync', () => ({
  dbRun: vi.fn(async (sql: string, params: unknown[]) => {
    if (/INSERT INTO app_settings/i.test(sql)) store.set(String(params[0]), String(params[1]));
    return undefined;
  }),
  dbGet: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM app_settings/i.test(sql)) {
      const v = store.get(String(params[0]));
      return v === undefined ? undefined : { value: v };
    }
    if (/MAX\(generated_at\)/i.test(sql)) {
      const d = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
      return { generated_at: rankingGeneratedAt, g: rankingGeneratedAt, d };
    }
    return { d: new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10) };
  }),
}));

const freshRanking = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

describe('recommendations digest is idempotent per ranking', () => {
  beforeEach(() => {
    store.clear();
    sendRecommendationsDigest.mockReset();
    sendRecommendationsDigest.mockResolvedValue({ sent: true, picks: 10 });
    rankingGeneratedAt = freshRanking(5);
  });

  it('sends once for a ranking and refuses to repeat it', async () => {
    const { processRecommendationsDigest } = await import('../jobs/digests.jobs');
    await processRecommendationsDigest();
    const second = await processRecommendationsDigest();
    expect(sendRecommendationsDigest).toHaveBeenCalledTimes(1);
    // a plain success, not a { skipped } marker: that stamps no heartbeat and would let a holiday
    // evening's critical digest go falsely "late" once its earlier send predates the 22:40 slot
    expect(second).toBeUndefined();
  });

  it('sends again when the ranking has changed', async () => {
    const { processRecommendationsDigest } = await import('../jobs/digests.jobs');
    await processRecommendationsDigest();
    rankingGeneratedAt = freshRanking(1);
    await processRecommendationsDigest();
    expect(sendRecommendationsDigest).toHaveBeenCalledTimes(2);
  });

  it('does not mark a ranking delivered when Telegram failed, so the retry still sends', async () => {
    const { processRecommendationsDigest } = await import('../jobs/digests.jobs');
    sendRecommendationsDigest.mockResolvedValueOnce({ sent: false, picks: 10 });
    await expect(processRecommendationsDigest()).rejects.toThrow(/failed to send/);
    await processRecommendationsDigest();
    expect(sendRecommendationsDigest).toHaveBeenCalledTimes(2);
  });

  it('a manual force re-sends an already-delivered ranking', async () => {
    const { processRecommendationsDigest } = await import('../jobs/digests.jobs');
    await processRecommendationsDigest();
    await processRecommendationsDigest({ data: { force: true } } as never);
    expect(sendRecommendationsDigest).toHaveBeenCalledTimes(2);
  });
});
