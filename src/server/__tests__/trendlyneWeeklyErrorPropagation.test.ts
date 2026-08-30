import { vi, test, expect, beforeEach } from 'vitest';

// Regression test for the "success heartbeat on a step that wrote nothing" bug class
// (recurring-bugs.md): processTrendlyneCatchup and processTrendlyneRatiosMonthly both used to
// swallow every runPython() failure via `.catch(warn)` with no rethrow, so job_heartbeat recorded
// a success no matter what happened underneath -- job_heartbeat.trendlyne-catchup showed 0
// failures across 861 runs despite two real timeouts inside one hour on 2026-08-30.
// processTrendlyneMidweek (same file) was already fixed for this on 2026-08-28; these two
// siblings were missed until this pass.

const mockRunPython = vi.fn();
vi.mock('../pythonRunner', () => ({ runPython: mockRunPython }));

vi.mock('../monitoringService', () => ({ updateMonitorState: vi.fn() }));
vi.mock('../marketStatusService', () => ({ isMarketOpen: vi.fn().mockResolvedValue(false) }));
vi.mock('../jobs/registerJob', () => ({ registerRepeatableJob: vi.fn() }));

const { processTrendlyneCatchup, processTrendlyneRatiosMonthly } = await import('../jobs/trendlyneWeekly.jobs');

beforeEach(() => {
  mockRunPython.mockReset();
});

test('processTrendlyneCatchup rejects when runPython fails, instead of swallowing it', async () => {
  mockRunPython.mockRejectedValue(new Error('Timed out after 600000ms (killed by timeout)'));

  await expect(processTrendlyneCatchup({} as any)).rejects.toThrow(/killed by timeout/);
});

test('processTrendlyneCatchup resolves {success:true} when runPython succeeds', async () => {
  mockRunPython.mockResolvedValue(undefined);

  const result = await processTrendlyneCatchup({} as any);
  expect(result.success).toBe(true);
});

test('processTrendlyneRatiosMonthly rejects if any of its steps fails, after running every step', async () => {
  // Force the isFirstSundayOfMonth branch closed by relying on whatever date the suite runs on
  // is irrelevant here -- fail the very first step, which runs regardless of day-of-month.
  mockRunPython
    .mockRejectedValueOnce(new Error('financial_ratios_fetcher exploded'))
    .mockResolvedValue(undefined);

  await expect(processTrendlyneRatiosMonthly({} as any)).rejects.toThrow(/financial_ratios_fetcher exploded/);
  // Every step must still have been attempted -- one broken fetcher must not skip the rest.
  expect(mockRunPython.mock.calls.length).toBeGreaterThanOrEqual(5);
});

test('processTrendlyneRatiosMonthly resolves {success:true} when every step succeeds', async () => {
  mockRunPython.mockResolvedValue(undefined);

  const result = await processTrendlyneRatiosMonthly({} as any);
  expect(result.success).toBe(true);
});
