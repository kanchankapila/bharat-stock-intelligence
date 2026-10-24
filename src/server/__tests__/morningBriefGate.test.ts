import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The 08:20 pre-open brief's input is *supposed* to be last night's 22:30 ranking, so its gate
// is session-based, not elapsed-hour based. Two inputs are legitimate (mirroring
// unifiedRankingIsFresh's two paths):
//   (a) session-match — a Monday 08:20 send accepting Friday's 22:30 rank (Friday is still the
//       latest completed NSE session), and
//   (b) calendar-today — an early-morning ranker run that legitimately stamps today's date before
//       the session's EOD tables land (2026-10-14 07:11 IST stamped 2026-10-14 while the latest
//       completed session was still 2026-10-13). Judging (b) only against session.d skipped the
//       brief on every such morning.
// The 7-day calendar cap still refuses an arbitrarily stale ranking.

const store = new Map<string, string>();
let rankingG = '';      // MAX(generated_at) as stored (ISO, UTC 'Z')
let rankingD = '';      // IST calendar date of that ranking
let knownHoliday = false;
let sessionD = '';      // latest COMPLETED NSE session (MAX of EOD tables, < today)
const sendMorningBrief = vi.fn();

vi.mock('../marketStatusService', () => ({
  isTradingHolidayToday: vi.fn(async () => false),
}));

vi.mock('../morningBrief', () => ({
  sendMorningBrief: (...a: unknown[]) => sendMorningBrief(...a),
}));
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
    if (/FROM market_holidays/i.test(sql)) return { is_holiday: knownHoliday };
    // the brief's own ranking lookup returns { g, d }
    if (/MAX\(generated_at\).*\bd\b/is.test(sql)) return { g: rankingG, d: rankingD };
    // the completed-session MAX returns { d }
    return { d: sessionD };
  }),
}));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

// Resolve the job graph before installing fake clocks. A cold module load can outlive
// the first case under backup I/O; its still-running import then crosses into the next
// case after timers/mocks reset. The gate assertions below still call the real processor.
await import('../jobs/digests.jobs');

describe('morning-brief gate accepts both legitimate ranking inputs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T02:50:00.000Z')); // 08:20 IST
    store.clear();
    knownHoliday = false;
    sendMorningBrief.mockReset();
    sendMorningBrief.mockResolvedValue({ sent: true, picks: 3, state: 'calls' });
    rankingG = minutesAgo(10 * 60); // ~10h old — last night's 22:30 rank read at 08:20
  });

  afterEach(() => vi.useRealTimers());

  it('sends on a Monday using Friday session-match: rank stamped with the completed session date', async () => {
    // Friday 2026-10-09 is the latest completed session; Monday morning accepts its 22:30 rank.
    const friday = '2026-10-09';
    rankingD = friday;
    sessionD = friday;
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledTimes(1);
  });

  it('sends on a calendar-today morning rank even when the session table still shows yesterday (the 2026-10-14 bug)', async () => {
    // Early-morning ranker stamped today; latest COMPLETED session is still D-1.
    rankingD = istToday();
    sessionD = '2026-10-13'; // strictly before rankingD, so only the calendar-today path saves it
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledTimes(1);
  });

  it('sends a degraded brief instead of failing when the ranking session does not match', async () => {
    rankingD = '2026-10-06';   // two sessions stale
    sessionD = '2026-10-13';   // fresher than the ranking, and not today
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const res = await processMorningBrief() as { success?: boolean } | undefined;
    expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('matches neither'));
    expect(res?.success).not.toBe(false);
  });

  it('sends a degraded brief for a calendar-today ranking older than the 7-day cap', async () => {
    rankingD = istToday();
    sessionD = '2026-10-13';
    rankingG = minutesAgo(8 * 24 * 60); // 8 days old — past MORNING_BRIEF_MAX_CALENDAR_AGE_MS
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('matches neither'));
  });

  it('sends a degraded brief instead of failing when unified_recommendations is empty', async () => {
    rankingG = '';
    rankingD = '';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const res = await processMorningBrief() as { success?: boolean } | undefined;
    expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('no ranking'));
    expect(res?.success).not.toBe(false);
  });

  it('throws when a degraded brief fails to reach Telegram, so the failure stays visible', async () => {
    rankingG = '';
    rankingD = '';
    sendMorningBrief.mockResolvedValue({ sent: false, picks: 0, state: 'degraded' });
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await expect(processMorningBrief()).rejects.toThrow(/failed to send/);
  });

  it('still skips, and sends nothing, on a weekend', async () => {
    vi.setSystemTime(new Date('2026-10-17T02:50:00.000Z')); // Saturday 08:20 IST
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    expect(await processMorningBrief()).toEqual({ skipped: true });
    expect(sendMorningBrief).not.toHaveBeenCalled();
  });

  it('still skips, and sends nothing, on a listed NSE holiday', async () => {
    knownHoliday = true;
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    expect(await processMorningBrief()).toEqual({ skipped: true });
    expect(sendMorningBrief).not.toHaveBeenCalled();
  });

  it('refuses to send a pre-open brief after 09:15 IST and records the miss', async () => {
    vi.setSystemTime(new Date('2026-10-14T04:00:00.000Z')); // 09:30 IST
    rankingD = istToday();
    sessionD = '2026-10-13';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const res = await processMorningBrief() as { success?: boolean } | undefined;
    expect(sendMorningBrief).not.toHaveBeenCalled();
    expect(res?.success).toBe(false);
  });

  it('does not re-send a ranking already briefed, unless forced', async () => {
    rankingD = istToday();
    sessionD = '2026-10-13';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledTimes(1);
    await processMorningBrief({ data: { force: true } } as never);
    expect(sendMorningBrief).toHaveBeenCalledTimes(2);
  });
});

describe('morning-brief gate: ranking dated between the last completed session and today (holiday morning)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T02:50:00.000Z')); // Wednesday 08:20 IST
    store.clear();
    knownHoliday = false;
    sendMorningBrief.mockReset();
    sendMorningBrief.mockResolvedValue({ sent: true, picks: 3, state: 'calls' });
    rankingG = '2026-10-20T02:00:00.000Z';                  // 07:30 IST on the Dussehra holiday
  });

  afterEach(() => vi.useRealTimers());

  it('sends a NON-degraded brief for a ranking dated on a holiday after the last session (the 2026-10-21 incident)', async () => {
    rankingD = '2026-10-20';
    sessionD = '2026-10-19';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledTimes(1);
    expect(sendMorningBrief).toHaveBeenCalledWith();
  });

  it('still degrades a ranking from the session BEFORE the latest completed one (evening ranker failed)', async () => {
    rankingG = '2026-10-16T17:00:00.000Z';
    rankingD = '2026-10-16';
    sessionD = '2026-10-19';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('matches neither'));
  });

  it('still degrades a ranking dated after today, even when its timestamp passes the age guard', async () => {
    rankingD = '2026-10-22';
    sessionD = '2026-10-19';
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('matches neither'));
  });

  it('with no known completed session only a calendar-today ranking passes', async () => {
    rankingD = '2026-10-20';
    sessionD = null as unknown as string;
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledWith('degraded', expect.stringContaining('matches neither'));
    sendMorningBrief.mockClear();
    store.clear();
    rankingD = '2026-10-21';
    rankingG = '2026-10-21T01:30:00.000Z';
    await processMorningBrief();
    expect(sendMorningBrief).toHaveBeenCalledWith();
  });
});
