import { describe, expect, it } from 'vitest';
import fs from 'fs';
import {
  classifyLatestDq,
  isKnownTransientFailure,
  isRestartTeardown,
  logLineTimeMs,
  latestExpectedNseDailyRun,
  latestExpectedNseIntradaySlot,
  latestNseSessionDate,
  logRotationVerdict,
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

  it('keeps the Trendlyne bulk-sweep lifecycle in the consolidated doctor', () => {
    const source = fs.readFileSync(new URL('./doctor.mjs', import.meta.url), 'utf8');
    expect(source).toContain("check('trendlyne-fanout-heartbeat'");
    expect(source).toContain("queuesSource.includes('runTrendlyneMetricsBulkFetch('");
    expect(source).toContain("queuesSource.includes('legacy child'");
    expect(source).toContain("!queuesSource.includes('enqueueTrendlyneMetricsFetchJobs('");
    expect(source).toContain('trendlyneGraceMinutes >= 30');
  });
});

// AF-20261028-20: pm2-out.log grew to 387 MB over two months with no rotation module installed.
describe('repo-doctor pm2 log rotation', () => {
  it('fails when the rotation module is missing', () => {
    expect(logRotationVerdict({ moduleInstalled: false, logBytes: 1e6 }).status).toBe('FAIL');
  });
  it('fails when the live log has outgrown rotation', () => {
    expect(logRotationVerdict({ moduleInstalled: true, logBytes: 387e6 }).status).toBe('FAIL');
  });
  it('passes with the module installed and a small live log', () => {
    expect(logRotationVerdict({ moduleInstalled: true, logBytes: 1.4e6 }).status).toBe('PASS');
  });
});

describe('repo-doctor log files to scan', () => {
  // 2026-11-07 00:43 IST: the scan named days by UTC (11-06, 11-05) and only looked for plain .log,
  // but app logs rotate at IST midnight to .log.gz -- it read no file and printed "0 error lines" PASS.
  it('names today and yesterday by IST date and falls back to the rotated .gz', async () => {
    const { appLogFilesForScan } = await import('./doctor-lib.mjs');
    const present = new Set(['logs/app-2026-11-07.log', 'logs/app-2026-11-06.log.gz']);
    const fwd = p => p.split(String.fromCharCode(92)).join('/');
    const files = appLogFilesForScan(atIst('2026-11-07T00:43:00'), 'logs', p => present.has(fwd(p)));
    expect(files.map(f => fwd(f.path))).toEqual(['logs/app-2026-11-07.log', 'logs/app-2026-11-06.log.gz']);
    expect(files.map(f => f.gz)).toEqual([false, true]);
  });

  it('returns nothing when no log exists, so the caller can refuse to report a PASS', async () => {
    const { appLogFilesForScan } = await import('./doctor-lib.mjs');
    expect(appLogFilesForScan(atIst('2026-11-07T00:43:00'), 'logs', () => false)).toEqual([]);
  });
});

describe('restart teardown classification (AF-20260910-27)', () => {
  const boot = logLineTimeMs('2026-11-16 08:23:41');
  const at = (t) => logLineTimeMs(t);

  it('reads the app log timestamp format', () => {
    expect(boot).not.toBeNull();
    expect(logLineTimeMs(undefined)).toBeNull();
  });

  it('treats a connection reset shortly before a server boot as restart teardown', () => {
    expect(isRestartTeardown('Error: read ECONNRESET', at('2026-11-16 08:20:02'), [boot])).toBe(true);
    expect(isRestartTeardown('[PY] x.py HOST/OS TERMINATION: DBG_TERMINATE_PROCESS', at('2026-11-16 08:14:00'), [boot])).toBe(true);
    expect(isRestartTeardown('Error: read ECONNRESET', at('2026-11-16 08:24:30'), [boot])).toBe(true);
  });

  it('still surfaces the same error when no boot is near it', () => {
    expect(isRestartTeardown('Error: read ECONNRESET', at('2026-11-16 13:05:00'), [boot])).toBe(false);
    expect(isRestartTeardown('Error: read ECONNRESET', at('2026-11-16 08:27:00'), [boot])).toBe(false);
    expect(isRestartTeardown('Error: read ECONNRESET', at('2026-11-16 08:20:02'), [])).toBe(false);
    expect(isRestartTeardown('Error: read ECONNRESET', null, [boot])).toBe(false);
  });

  it('never excuses an unrelated error because a restart happened', () => {
    expect(isRestartTeardown('[QUEUE] unified-ranker failed: relation does not exist', at('2026-11-16 08:20:02'), [boot])).toBe(false);
  });
});

describe('repo-doctor due times', () => {
  it('match the cron registered for the same job', () => {
    const doctor = fs.readFileSync(new URL('./doctor.mjs', import.meta.url), 'utf8');
    const registry = fs.readFileSync(new URL('../../../src/server/jobRegistry.ts', import.meta.url), 'utf8');
    const entries = [...doctor.matchAll(/\['([\w-]+)', \d+, 'nse-daily', \{ hourUtc: (\d+), minuteUtc: (\d+)/g)];
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const [, job, hour, minute] of entries) {
      const cron = registry.match(new RegExp(String.raw`jobName: '${job}',[^\n]*?cronPattern: '(\d+) (\d+) `));
      expect(cron, job).not.toBeNull();
      expect({ job, due: `${minute} ${hour}` }).toEqual({ job, due: `${Number(cron[1])} ${Number(cron[2])}` });
    }
  });
});
