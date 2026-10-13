import { describe, expect, it } from 'vitest';
import {
  isKnownTransientFailure,
  latestExpectedNseDailyRun,
  latestExpectedNseIntradaySlot,
  latestNseSessionDate,
  unrecoveredFailureRows,
} from './doctor-lib.mjs';

const atIst = (isoWithoutZone) => new Date(`${isoWithoutZone}+05:30`);

describe('repo-doctor NSE intraday schedule', () => {
  it('keeps Friday close as the latest due slot throughout Saturday', () => {
    const due = latestExpectedNseIntradaySlot(atIst('2026-10-10T13:00:00'));
    expect(new Date(due).toISOString()).toBe('2026-10-09T10:00:00.000Z');
  });

  it('does not demand a slot until its completion grace has elapsed', () => {
    const due = latestExpectedNseIntradaySlot(atIst('2026-10-09T15:40:00'));
    expect(new Date(due).toISOString()).toBe('2026-10-09T09:45:00.000Z'); // 15:15 IST
  });

  it('skips a recorded weekday holiday', () => {
    const due = latestExpectedNseIntradaySlot(
      atIst('2026-10-13T09:20:00'),
      ['2026-10-12'],
    );
    expect(new Date(due).toISOString()).toBe('2026-10-09T10:00:00.000Z');
  });
});

describe('repo-doctor NSE daily schedule', () => {
  it('keeps Friday as the latest due run throughout the weekend', () => {
    const due = latestExpectedNseDailyRun(
      atIst('2026-10-11T13:00:00'),
      [],
      { hourUtc: 13, minuteUtc: 20, graceMinutes: 270 },
    );
    expect(new Date(due).toISOString()).toBe('2026-10-09T13:20:00.000Z');
    expect(latestNseSessionDate(atIst('2026-10-11T13:00:00'))).toBe('2026-10-09');
  });

  it('does not demand a weekday run until its own grace has elapsed', () => {
    const before = latestExpectedNseDailyRun(
      atIst('2026-10-12T10:10:00'),
      [],
      { hourUtc: 4, minuteUtc: 0, graceMinutes: 45 },
    );
    const after = latestExpectedNseDailyRun(
      atIst('2026-10-12T10:20:00'),
      [],
      { hourUtc: 4, minuteUtc: 0, graceMinutes: 45 },
    );
    expect(new Date(before).toISOString()).toBe('2026-10-09T04:00:00.000Z');
    expect(new Date(after).toISOString()).toBe('2026-10-12T04:00:00.000Z');
  });
});

describe('repo-doctor known-transient failure classifier', () => {
  it('keeps demonstrated retry/vendor transient signatures benign', () => {
    expect(isKnownTransientFailure('Trendlyne request aborted by timeout')).toBe(true);
    expect(isKnownTransientFailure('NiftyTrader timeout')).toBe(true);
    expect(isKnownTransientFailure('WAF captcha challenge')).toBe(true);
  });

  it('does not hide parent-step failures or retired routes', () => {
    expect(isKnownTransientFailure('1 steps failed: sync_tl_index_map')).toBe(false);
    expect(isKnownTransientFailure('404 Client Error: Not Found')).toBe(false);
  });

  it('reports only failures that are neither transient nor recovered by a later success', () => {
    const rows = [
      { job_name: 'recovered', err: '1 steps failed: real_step', recovered: true },
      { job_name: 'transient', err: 'Trendlyne request aborted by timeout', recovered: false },
      { job_name: 'open', err: '1 steps failed: real_step', recovered: false },
    ];
    expect(unrecoveredFailureRows(rows).map(r => r.job_name)).toEqual(['open']);
  });
});
