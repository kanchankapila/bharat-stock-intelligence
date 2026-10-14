import { describe, it, expect, vi, beforeEach } from 'vitest';

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
let sessionD = '';      // latest COMPLETED NSE session (MAX of EOD tables, < today)
const sendMorningBrief = vi.fn();

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
    // the brief's own ranking lookup returns { g, d }
    if (/MAX\(generated_at\).*\bd\b/is.test(sql)) return { g: rankingG, d: rankingD };
    // the completed-session MAX returns { d }
    return { d: sessionD };
  }),
}));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

describe('morning-brief gate accepts both legitimate ranking inputs', () => {
  beforeEach(() => {
    store.clear();
    sendMorningBrief.mockReset();
    sendMorningBrief.mockResolvedValue({ sent: true });
    rankingG = minutesAgo(10 * 60); // ~10h old — last night's 22:30 rank read at 08:20
  });

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

  it('skips when the ranking matches neither the completed session nor calendar-today (evening ranker failed outright)', async () => {
    rankingD = '2026-10-06';   // two sessions stale
    sessionD = '2026-10-13';   // fresher than the ranking, and not today
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    const res = await processMorningBrief();
    expect(sendMorningBrief).not.toHaveBeenCalled();
    expect(String((res as { failedSteps?: string[] })?.failedSteps?.[0])).toMatch(/matches neither/i);
  });

  it('skips a calendar-today ranking that is older than the 7-day cap', async () => {
    rankingD = istToday();
    sessionD = '2026-10-13';
    rankingG = minutesAgo(8 * 24 * 60); // 8 days old — past MORNING_BRIEF_MAX_CALENDAR_AGE_MS
    const { processMorningBrief } = await import('../jobs/digests.jobs');
    await processMorningBrief();
    expect(sendMorningBrief).not.toHaveBeenCalled();
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
