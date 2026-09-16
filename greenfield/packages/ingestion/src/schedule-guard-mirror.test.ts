// Mirror-consistency check for the pm2-registration-launch guards added 2026-09-03 (see
// session-calendar.ts's isWithinScheduleWindow doc comment for the live incident this closes).
//
// Each guarded entrypoint states its own intended fire time as a local `SCHEDULE` constant
// (TS) or `_SCHEDULE_IST_HOUR`/`_SCHEDULE_IST_MINUTE` pair (backup_pg.py) -- a SECOND,
// independent statement of the exact time already declared in ecosystem.config.cjs's
// `cron_restart` string for that same pm2 app. Nothing links the two except a code comment.
// This is the identical "cron mirror drift" class src/server/__tests__/jobRegistryCronMirror.test.ts
// and monitorScriptsCronMirror.test.ts already guard on the BullMQ side (see
// .claude/rules/recurring-bugs.md's "Dates & scheduling" table) -- except a drift here is worse
// than a phantom alert: it makes the guard silently and permanently reject the REAL scheduled
// fire every day, the exact false-negative failure mode the guard exists to avoid introducing.
//
// Same two-layer shape as the BullMQ mirror tests: a parser sanity check, then one pinned
// assertion per job so drift on any single entry is caught precisely.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const INGESTION_SRC = join(__dirname);

interface JobSchedule {
  jobName: string;
  hour: number;
  minute: number;
  /** Normalised day-of-week set, 0=Sun..6=Sat; undefined = every day. */
  daysOfWeek: readonly number[] | undefined;
}

function parseCronRestartDow(dow: string): readonly number[] | undefined {
  if (dow === '*') return undefined;
  if (/^\d+$/.test(dow)) return [Number(dow)];
  const range = dow.match(/^(\d+)-(\d+)$/);
  if (range) {
    const [, a, b] = range;
    const out: number[] = [];
    for (let d = Number(a); d <= Number(b); d++) out.push(d);
    return out;
  }
  throw new Error(`unrecognised cron day-of-week field: "${dow}"`);
}

/** Every {name, cron_restart} pair declared in ecosystem.config.cjs, parsed from source text
 * (not `require()`d -- that file parses .env and builds real service configs as a side effect,
 * which this test has no business triggering).
 *
 * Each app object is `{ ..., name: '<x>', ... cron_restart: '<mm> <hh> * * <dow>', ... }`, but a
 * single regex spanning name->cron_restart is unsafe: the 5 always-on services (bharat-server,
 * alphaquant-api, ...) declare `name` with NO `cron_restart` anywhere in their object, so a lazy
 * `name:...cron_restart:` match starting at one of THOSE names skips forward across object
 * boundaries and wrongly pairs a service's name with the NEXT app's cron_restart entirely
 * (caught live: it silently mis-paired 'bharat-server' with gf-bhavcopy-daily's schedule and
 * dropped gf-bhavcopy-daily's own entry). Instead: find every `name:` occurrence's position,
 * then only look for `cron_restart:` in the slice up to the NEXT `name:` occurrence -- i.e.
 * within that same object literal, never past it. */
function readEcosystemSchedules(): Map<string, JobSchedule> {
  const src = readFileSync(join(REPO_ROOT, 'ecosystem.config.cjs'), 'utf8');
  const out = new Map<string, JobSchedule>();

  const nameRe = /name:\s*'([^']+)'/g;
  const nameMatches: Array<{ jobName: string; start: number; end: number }> = [];
  for (let m = nameRe.exec(src); m; m = nameRe.exec(src)) {
    nameMatches.push({ jobName: m[1]!, start: m.index, end: m.index + m[0].length });
  }

  const cronRe = /cron_restart:\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+(\S+)'/;
  for (let i = 0; i < nameMatches.length; i++) {
    const { jobName, end } = nameMatches[i]!;
    const sliceEnd = i + 1 < nameMatches.length ? nameMatches[i + 1]!.start : src.length;
    const m = cronRe.exec(src.slice(end, sliceEnd));
    if (!m) continue; // no cron_restart in this app's own object -- an always-on service, fine.
    const [, minute, hour, dow] = m;
    out.set(jobName, { jobName, hour: Number(hour), minute: Number(minute), daysOfWeek: parseCronRestartDow(dow!) });
  }
  return out;
}

/** Reads a TS entrypoint's `const SCHEDULE = { hour: N, minute: N, daysOfWeek: [...] }` (or the
 * inline object literal form used by run-compute-features.ts) via source-text regex -- these
 * are plain numeric-literal object shapes by construction (see the isWithinScheduleWindow call
 * sites added 2026-09-03), never anything computed, so this is safe. */
function readTsSchedule(relPath: string): { hour: number; minute: number; daysOfWeek: readonly number[] | undefined } {
  const src = readFileSync(join(INGESTION_SRC, relPath), 'utf8');
  const m = src.match(/hour:\s*(\d+),\s*minute:\s*(\d+)(?:,\s*daysOfWeek:\s*\[([^\]]*)\])?/);
  if (!m) throw new Error(`no SCHEDULE-shaped object literal found in ${relPath}`);
  const [, hour, minute, dowList] = m;
  const daysOfWeek = dowList !== undefined && dowList.trim().length > 0
    ? dowList.split(',').map((s) => Number(s.trim()))
    : undefined;
  return { hour: Number(hour), minute: Number(minute), daysOfWeek };
}

/** Same idea for backup_pg.py's `_SCHEDULE_IST_HOUR, _SCHEDULE_IST_MINUTE = HH, MM`. pg-backup
 * runs daily (cron_restart's dow field is '*'), so there's no daysOfWeek to cross-check. */
function readPythonSchedule(): { hour: number; minute: number } {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'backup_pg.py'), 'utf8');
  const m = src.match(/_SCHEDULE_IST_HOUR,\s*_SCHEDULE_IST_MINUTE\s*=\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error('no _SCHEDULE_IST_HOUR/_SCHEDULE_IST_MINUTE assignment found in backup_pg.py');
  const [, hour, minute] = m;
  return { hour: Number(hour), minute: Number(minute) };
}

const ecosystemSchedules = readEcosystemSchedules();

describe('greenfield schedule-guard mirror consistency (ecosystem.config.cjs vs. each entrypoint\'s SCHEDULE)', () => {
  it('parser sanity: finds all 12 guarded pm2 apps in ecosystem.config.cjs', () => {
    expect(ecosystemSchedules.size).toBeGreaterThanOrEqual(12);
  });

  const cases: Array<{ jobName: string; relPath: string; isPython?: boolean }> = [
    { jobName: 'gf-bhavcopy-daily', relPath: 'nse/run-daily-bhavcopy.ts' },
    { jobName: 'gf-fii-dii-daily', relPath: 'stage3/run-daily-fii-dii.ts' },
    { jobName: 'gf-features-daily', relPath: 'stage4/run-compute-features.ts' },
    { jobName: 'gf-stage3-dq-daily', relPath: 'stage3/run-dq-checks.ts' },
    { jobName: 'gf-stage4-dq-daily', relPath: 'stage4/run-dq-checks.ts' },
    { jobName: 'gf-ranker-daily', relPath: 'stage5/run-ranker.ts' },
    { jobName: 'gf-divergence-daily', relPath: 'stage5/run-divergence-analysis.ts' },
    { jobName: 'gf-kayal-weekly', relPath: 'stage3/transfer-screener-membership.ts' },
    { jobName: 'gf-fundamentals-weekly', relPath: 'stage3/transfer-fundamentals.ts' },
    { jobName: 'gf-analyst-estimates-weekly', relPath: 'stage3/transfer-analyst-estimates.ts' },
    { jobName: 'gf-insider-activity-weekly', relPath: 'stage3/transfer-insider-activity.ts' },
    { jobName: 'pg-backup-nightly', relPath: '', isPython: true },
  ];

  it.each(cases)('$jobName: entrypoint SCHEDULE matches ecosystem.config.cjs\'s cron_restart', ({ jobName, relPath, isPython }) => {
    const real = ecosystemSchedules.get(jobName);
    expect(real, `${jobName} not found in ecosystem.config.cjs`).toBeDefined();

    if (isPython) {
      const declared = readPythonSchedule();
      expect(declared.hour).toBe(real!.hour);
      expect(declared.minute).toBe(real!.minute);
    } else {
      const declared = readTsSchedule(relPath);
      expect(declared.hour).toBe(real!.hour);
      expect(declared.minute).toBe(real!.minute);
      expect(declared.daysOfWeek).toEqual(real!.daysOfWeek);
    }
  });
});
