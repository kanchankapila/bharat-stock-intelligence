/**
 * One-screen readiness report for every registered job: has it run, did it succeed, how long ago.
 *
 * Answers the question a pre-trading-day check actually asks -- "which of these will I regret on
 * Monday" -- which no existing view answers on its own. `job_heartbeat` knows the last verdict but
 * not the schedule; JOB_REGISTRY knows the schedule but not the outcome; `queueState.ts` knows what
 * is running right now but nothing historical. This joins them.
 *
 * Deliberately reports NEVER-RUN separately from FAILED. A job with no heartbeat row at all is the
 * more dangerous state -- it looks clean in every "show me the failures" view precisely because it
 * has never produced one.
 *
 * Usage: tsx scripts/jobStatusReport.ts [--days 3]
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { JOB_REGISTRY } from '../src/server/jobRegistry';

function loadEnv(): Record<string, string> {
  const p = path.resolve(process.cwd(), '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const env = { ...loadEnv(), ...process.env } as Record<string, string>;
const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2 });

const days = Number(process.argv.includes('--days')
  ? process.argv[process.argv.indexOf('--days') + 1] : 3);

type Row = {
  job: string; label: string; critical: boolean; scheduled: boolean;
  status: string | null; hSinceOk: number | null; runs: number; fails: number; err: string | null;
};

(async () => {
  const hb = new Map<string, any>();
  for (const r of (await pool.query(
    `SELECT job_name, last_status, run_count, fail_count,
            round((extract(epoch from now())*1000 - last_success_at)/3600000.0, 1) h_ok,
            left(coalesce(last_error,''), 120) err
       FROM job_heartbeat`)).rows) hb.set(r.job_name, r);

  const recent = new Map<string, { ok: number; bad: number }>();
  for (const r of (await pool.query(
    `SELECT job_name,
            count(*) FILTER (WHERE status <> 'failed') ok,
            count(*) FILTER (WHERE status = 'failed') bad
       FROM job_run_history WHERE ran_at > now() - ($1 || ' days')::interval
      GROUP BY job_name`, [days])).rows) recent.set(r.job_name, { ok: Number(r.ok), bad: Number(r.bad) });

  const rows: Row[] = JOB_REGISTRY.map((j: any) => {
    const h = hb.get(j.jobName);
    return {
      job: j.jobName, label: j.label, critical: !!j.critical,
      scheduled: !!(j.cronPattern || j.everyMs),
      status: h?.last_status ?? null,
      hSinceOk: h?.h_ok == null ? null : Number(h.h_ok),
      runs: Number(h?.run_count ?? 0), fails: Number(h?.fail_count ?? 0),
      err: h?.err || null,
    };
  });

  const bucket = (r: Row) => {
    if (!r.scheduled) return 'event-driven';
    if (!hb.has(r.job)) return 'NEVER RUN';
    if (r.status === 'failed') return 'FAILING';
    if (r.hSinceOk == null) return 'NEVER SUCCEEDED';
    if (r.hSinceOk > 24 * 8) return 'stale >8d';
    return 'ok';
  };

  const order = ['FAILING', 'NEVER RUN', 'NEVER SUCCEEDED', 'stale >8d', 'ok', 'event-driven'];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const b = bucket(r);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(r);
  }

  console.log(`\nJOB READINESS — ${rows.length} registry entries, ${days}d run window\n${'='.repeat(78)}`);
  for (const b of order) {
    const g = groups.get(b);
    if (!g?.length) continue;
    console.log(`\n${b}  (${g.length})`);
    for (const r of g.sort((a, x) => (x.hSinceOk ?? 1e9) - (a.hSinceOk ?? 1e9))) {
      const rc = recent.get(r.job);
      const win = rc ? `${rc.ok}ok/${rc.bad}fail in ${days}d` : `no runs in ${days}d`;
      const age = r.hSinceOk == null ? 'never' : `${r.hSinceOk}h`;
      console.log(`  ${r.critical ? '!' : ' '} ${r.job.padEnd(28)} last_ok=${age.padStart(8)}  ${win.padEnd(20)} ${r.err ? '— ' + r.err.replace(/\s+/g, ' ').slice(0, 70) : ''}`);
    }
  }
  const bad = (groups.get('FAILING')?.length ?? 0) + (groups.get('NEVER RUN')?.length ?? 0)
            + (groups.get('NEVER SUCCEEDED')?.length ?? 0);
  console.log(`\n${'='.repeat(78)}\n${bad} job(s) need attention before a trading day.\n`);
  await pool.end();
})().catch(async e => {
  console.error('fatal:', e?.message ?? e);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
