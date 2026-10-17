import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMorningBrief = vi.fn();
let rankingGeneratedAt = '2026-10-09T17:00:00.000Z';
let latestCompletedSession = '2026-10-09';

vi.mock('../morningBrief', () => ({
  sendMorningBrief: (...args: unknown[]) => sendMorningBrief(...args),
}));
vi.mock('../jobWatchdog', () => ({ buildDailyDigest: vi.fn() }));
vi.mock('../telegramService', () => ({ telegramService: { sendMarkdownMessage: vi.fn() } }));
vi.mock('../jobs/registerJob', () => ({ registerRepeatableJob: vi.fn() }));
vi.mock('../dbAsync', () => ({
  dbRun: vi.fn(async () => undefined),
  dbGet: vi.fn(async (sql: string) => {
    if (/FROM unified_recommendations/i.test(sql)) {
      return {
        g: rankingGeneratedAt,
        d: new Date(new Date(rankingGeneratedAt).getTime() + 5.5 * 3_600_000)
          .toISOString().slice(0, 10),
      };
    }
    if (/nse_universe_history/i.test(sql)) return { d: latestCompletedSession };
    if (/FROM app_settings/i.test(sql)) return undefined;
    return { d: latestCompletedSession };
  }),
}));

describe('morning brief trading-session freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T02:50:00.000Z')); // Monday 08:20 IST
    rankingGeneratedAt = '2026-10-09T17:00:00.000Z';       // Friday 22:30 IST
    latestCompletedSession = '2026-10-09';
    sendMorningBrief.mockReset();
    sendMorningBrief.mockResolvedValue({ sent: true, picks: 5 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts Friday evening ranking on Monday because Friday is the latest completed NSE session', async () => {
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const result = await processMorningBrief();

    expect(result).toBeUndefined();
    expect(sendMorningBrief).toHaveBeenCalledTimes(1);
  });

  it('rejects a ranking older than the latest completed NSE session', async () => {
    rankingGeneratedAt = '2026-10-08T17:00:00.000Z';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const result = await processMorningBrief() as unknown as {
      success: boolean;
      failedSteps: string[];
    };

    expect(result.success).toBe(false);
    expect(result.failedSteps.join(' ')).toMatch(/latest completed NSE session/i);
    expect(sendMorningBrief).not.toHaveBeenCalled();
  });

  it('never sends a pre-open brief after the market has opened, even on catch-up', async () => {
    vi.setSystemTime(new Date('2026-10-14T07:02:00.000Z')); // 12:32 IST
    rankingGeneratedAt = '2026-10-14T01:41:38.000Z';
    latestCompletedSession = '2026-10-13';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const result = await processMorningBrief({ data: { force: true } }) as {
      success: boolean;
      failedSteps: string[];
    };

    expect(result.success).toBe(false);
    expect(result.failedSteps.join(' ')).toMatch(/market open/i);
    expect(sendMorningBrief).not.toHaveBeenCalled();
  });
});
