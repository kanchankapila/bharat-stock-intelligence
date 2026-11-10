import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRunPython, mockDbGet } = vi.hoisted(() => ({ mockRunPython: vi.fn(), mockDbGet: vi.fn() }));
vi.mock('../pythonRunner', () => ({ runPython: mockRunPython }));
vi.mock('../dbAsync', () => ({ dbGet: mockDbGet }));
vi.mock('../monitoringService', () => ({ updateMonitorState: vi.fn() }));
vi.mock('../marketStatusService', () => ({ shouldSkipOnTradingHoliday: vi.fn() }));
vi.mock('../jobs/registerJob', () => ({ registerRepeatableJob: vi.fn() }));

const dl = await import('../jobs/dl.jobs');

// IST wall time -> instant. 2026-11-06 is a Friday.
const ist = (s: string) => new Date(`${s}+05:30`);

describe('full weekly BiLSTM retrain (user, 2026-11-06: start when Friday night jobs finish)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockRunPython.mockReset().mockResolvedValue({});
    mockDbGet.mockReset().mockResolvedValue(undefined);
  });

  it('opens only between Friday 23:00 and Saturday 12:00 IST, so an ~18-22h run ends before Sunday 10:30', () => {
    expect(dl.fullRetrainWindowOpen(ist('2026-11-06T22:59:00'))).toBe(false);
    expect(dl.fullRetrainWindowOpen(ist('2026-11-06T23:30:00'))).toBe(true);
    expect(dl.fullRetrainWindowOpen(ist('2026-11-07T00:28:00'))).toBe(true);
    expect(dl.fullRetrainWindowOpen(ist('2026-11-07T11:59:00'))).toBe(true);
    expect(dl.fullRetrainWindowOpen(ist('2026-11-07T12:00:00'))).toBe(false);
    expect(dl.fullRetrainWindowOpen(ist('2026-11-09T08:00:00'))).toBe(false);
  });

  it('the chained run trains the full universe, capped inside the 24h kill', async () => {
    vi.useFakeTimers({ now: ist('2026-11-07T00:30:00') });
    await dl.processDlRetrainWeekly({ data: { trigger: 'scheduled', chained: true } } as any);
    const [script, args, timeout] = mockRunPython.mock.calls[0];
    expect(script).toBe('dl_trainer.py');
    expect(args).toEqual(['--trigger', 'scheduled', '--train-budget-sec', String(dl.FULL_RETRAIN_BUDGET_SEC)]);
    expect(dl.FULL_RETRAIN_BUDGET_SEC * 1000).toBeLessThan(timeout - 3 * 3600_000);
  });

  it('the cron fallback skips when this weekend already started a retrain', async () => {
    vi.useFakeTimers({ now: ist('2026-11-07T02:00:00') });
    mockDbGet.mockResolvedValue({ value: '2026-11-07T00:31:05.123456' });
    expect(await dl.processDlRetrainWeekly({ data: {} } as any)).toEqual({ success: true, skipped: true });
    expect(mockRunPython).not.toHaveBeenCalled();
  });

  it('the cron fallback runs when the chain never fired this week', async () => {
    vi.useFakeTimers({ now: ist('2026-11-07T02:00:00') });
    mockDbGet.mockResolvedValue({ value: '2026-11-01T10:30:02.000000' });
    await dl.processDlRetrainWeekly({ data: {} } as any);
    expect(mockRunPython).toHaveBeenCalledTimes(1);
  });

  it('a make-up that lands outside the window is skipped, never run on a weekday', async () => {
    vi.useFakeTimers({ now: ist('2026-11-09T08:05:00') });
    expect(await dl.processDlRetrainWeekly({ data: { chained: true } } as any)).toEqual({ success: true, skipped: true });
    expect(mockRunPython).not.toHaveBeenCalled();
  });

  it('dispatches under the weekly job name so make-up deferral and monitoring still match it', async () => {
    const add = vi.fn().mockResolvedValue({});
    await dl.dispatchFullRetrainAfterWeeklyData({ add } as any, ist('2026-11-07T00:28:00'));
    expect(add).toHaveBeenCalledWith('dl-retrain-weekly', { trigger: 'scheduled', chained: true },
      expect.objectContaining({ jobId: 'dl-retrain-full-2026-11-07' }));
  });

  it('ml-weekly-data dispatches it on both completion and failure, and the ML retrain moved off Saturday', () => {
    const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8').replace(/\r\n/g, '\n');
    const handlers = src.slice(src.indexOf("mlWeeklyDataWorker.on('completed'"), src.indexOf('mlWeeklyRetrainQueue = new Queue'));
    expect(handlers.match(/dispatchFullRetrainAfterWeeklyData\(/g)?.length).toBe(2);
    const retrain = src.slice(src.indexOf("addJobWithCatchup(mlWeeklyRetrainQueue, 'ml-weekly-retrain'"));
    expect(retrain.match(/pattern: '([^']+)'/)?.[1]).toBe('0 5 * * 0');
  });
});
