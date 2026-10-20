import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockCompute = vi.fn();
vi.mock('../confluenceEngine', () => ({
  computeConfluenceSignals: mockCompute,
  runMLProbabilityOverlay: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../dbAsync', () => ({ dbGet: vi.fn(), dbAll: vi.fn(), dbRun: vi.fn() }));
vi.mock('../marketStatusService', () => ({ isMarketOpen: vi.fn(), shouldSkipOnTradingHoliday: vi.fn() }));
vi.mock('../pythonRunner', () => ({ runPython: vi.fn() }));
vi.mock('../jobSteps', () => ({ StepTracker: vi.fn().mockImplementation(() => ({ run: vi.fn(), fail: vi.fn(), finish: () => ({ ok: true, failedSteps: [] }) })) }));
vi.mock('../jobs/registerJob', () => ({ registerRepeatableJob: vi.fn() }));
vi.mock('../queues', () => ({ makeConnection: vi.fn() }));

const { processConfluenceCompute, isConfluenceOverdue } = await import('../jobs/confluence.jobs');
const { dbGet } = await import('../dbAsync');
const mockDbGet = dbGet as ReturnType<typeof vi.fn>;
const { isMarketOpen } = await import('../marketStatusService');
const mockIsMarketOpen = isMarketOpen as ReturnType<typeof vi.fn>;

// 2026-10-17 03:00 UTC = 08:30 IST Thursday. Market closed (opens 09:15 IST) and outside the
// compute window (IST hour 8 ∉ {6,7} ∪ [17,23]) — the exact state after the host slept through
// the morning window. Pinned so the test cannot flake on the real clock.
const NOW = new Date('2026-10-17T03:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mockIsMarketOpen.mockResolvedValue(false);
  mockCompute.mockResolvedValue({ computed: 5, elite: 1, strong: 2 });
});
afterEach(() => { vi.useRealTimers(); });

describe('processConfluenceCompute missed-window catch-up', () => {
  it('computes out-of-window when the last ELAPSED window produced no write (host slept through it)', async () => {
    // Newest row 2026-10-16 23:31 IST — the morning window that should have written 06:00-08:00
    // IST today never ran. Pre-fix this skipped, so confluence_signals sat 15h stale and the
    // critical confluence-signals-freshness check FAILed until the 17:00 IST evening window.
    mockDbGet.mockResolvedValue({ newest: new Date('2026-10-16T18:01:00Z') });

    const r = await processConfluenceCompute({} as any);

    expect(mockCompute).toHaveBeenCalledTimes(1);
    expect(r.skipped).toBeUndefined();
    expect(r).toMatchObject({ computed: 5, elite: 1, strong: 2 });
  });

  it('still skips out-of-window when the last elapsed window DID write (healthy, inputs static)', async () => {
    // Newest row 2026-10-17 07:30 IST — today's morning window ran fine, so recompute now would be
    // the waste the window exists to prevent. Negative control: without it the catch-up would fire
    // every healthy afternoon.
    mockDbGet.mockResolvedValue({ newest: new Date('2026-10-17T02:00:00Z') });

    const r = await processConfluenceCompute({} as any);

    expect(mockCompute).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
  });

  it('refuses market hours first — never consults the catch-up, never computes', async () => {
    mockIsMarketOpen.mockResolvedValue(true);

    const r = await processConfluenceCompute({} as any);

    expect(mockCompute).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
    expect(mockDbGet).not.toHaveBeenCalled();
  });
});

describe('isConfluenceOverdue boundary arithmetic', () => {
  it('empty table is overdue', () => {
    expect(isConfluenceOverdue(null, NOW)).toBe(true);
  });

  it('missed morning window: stale at 08:30 IST, cleared by a 07:30 IST write', () => {
    // Morning window passed (IST 08:30 >= 08:00) → expect a row from >= 06:00 IST = 00:30 UTC.
    expect(isConfluenceOverdue(new Date('2026-10-16T18:01:00Z'), NOW)).toBe(true);  // y'day 23:31 IST
    expect(isConfluenceOverdue(new Date('2026-10-17T02:00:00Z'), NOW)).toBe(false); // today 07:30 IST
    expect(isConfluenceOverdue(new Date('2026-10-17T00:29:00Z'), NOW)).toBe(true);  // 06:59m before 06:00? no: 00:29Z=05:59 IST
  });

  it('healthy pre-evening gap (9.5h old) is NOT overdue, unlike a fixed age threshold', () => {
    // 16:59 IST, morning window wrote 07:30 IST → 9h29m old. A fixed 9h threshold would fire here
    // every healthy day; the window-boundary rule does not.
    const t = new Date('2026-10-17T11:29:00Z'); // 16:59 IST
    expect(isConfluenceOverdue(new Date('2026-10-17T02:00:00Z'), t)).toBe(false);
  });

  it('missed evening window: overnight check expects yesterday 17:00 IST', () => {
    // 01:30 IST 10-17 → evening window (10-16 17:00 IST) passed; expect row >= 10-16 11:30 UTC.
    const t = new Date('2026-10-16T20:00:00Z');
    expect(isConfluenceOverdue(new Date('2026-10-16T02:00:00Z'), t)).toBe(true);  // only y'day morning
    expect(isConfluenceOverdue(new Date('2026-10-16T18:00:00Z'), t)).toBe(false); // y'day 23:30 IST
  });

  it('inside an open window is never reported overdue (that window will write)', () => {
    expect(isConfluenceOverdue(new Date('2026-10-16T18:01:00Z'), new Date('2026-10-17T02:00:00Z'))).toBe(false); // 07:30 IST, morning window
    expect(isConfluenceOverdue(new Date('2026-10-16T18:01:00Z'), new Date('2026-10-17T13:00:00Z'))).toBe(false); // 18:30 IST, evening window
  });
});