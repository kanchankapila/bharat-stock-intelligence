import { describe, expect, it } from 'vitest';
import fs from 'fs';
import {
  classifyLatestDq,
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

describe('repo-doctor latest DQ classifier', () => {
  const pass = { check_id: 'freshness', status: 'pass', critical: 1 };
  const noEdge = { check_id: 'ur-engine-dispersion-collapse', status: 'fail', critical: 0 };

  it('keeps the frozen-experiment no-edge result visible as a warning', () => {
    expect(classifyLatestDq([pass, noEdge])).toEqual({
      status: 'WARN',
      detail: 'pass=1(crit 1) / fail=1; evidence-lane: ur-engine-dispersion-collapse',
    });
  });

  it('still fails on any unrelated DQ failure beside the evidence row', () => {
    const result = classifyLatestDq([
      pass,
      noEdge,
      { check_id: 'prices-stale', status: 'error', critical: 1 },
    ]);
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain('blocking: prices-stale');
  });

  it('passes when every latest verdict passes', () => {
    expect(classifyLatestDq([pass]).status).toBe('PASS');
  });
});

describe('repo-doctor secret hygiene', () => {
  it('never selects or prints Telegram credential values', () => {
    const source = fs.readFileSync(new URL('./doctor.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/left\(value/i);
    expect(source).not.toMatch(/telegram-settings[\s\S]{0,500}\.v\b/);
    expect(source).toContain("bot_token=${hasTok ? 'configured' : 'missing'}");
  });

  it('keeps the Trendlyne fan-out lifecycle in the consolidated doctor', () => {
    const source = fs.readFileSync(new URL('./doctor.mjs', import.meta.url), 'utf8');
    expect(source).toContain("check('trendlyne-fanout-heartbeat'");
    expect(source).toContain("queuesSource.includes('settleTrendlyneBatch('");
    expect(source).toContain('trendlyneGraceMinutes >= 12 * 60');
    expect(source).toContain("batchSource.includes('missing batch state for')");
  });
});
