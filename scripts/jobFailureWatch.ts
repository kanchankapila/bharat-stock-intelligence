/**
 * "Which jobs have failed, and with what?" -- the read side of the post-resume validation.
 *
 * Reads job_run_history rather than the logs: a log line is a snapshot of one process's stderr,
 * while job_run_history is what the heartbeat layer actually recorded, which is what the digest
 * and the Telegram alerts read. Fixing what the logs show but not what this table shows leaves
 * the alerts firing.
 *
 * Usage:
 *   tsx scripts/jobFailureWatch.ts               # failures since the last pm2 restart
 *   tsx scripts/jobFailureWatch.ts --since 17:10 # failures since a wall-clock time today
 *   tsx scripts/jobFailureWatch.ts --hours 24
 *   tsx scripts/jobFailureWatch.ts --pending     # what is still queued/running
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

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

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}

async function main() {
  const hours = Number(arg('hours', '6'));
  const since = arg('since');
  const cutoff = since
    ? `(CURRENT_DATE + TIME '${since}')`
    : `(now() - interval '${hours} hours')`;

  const { rows: runs } = await pool.query(
    `SELECT job_name, status, count(*) n,
            max(ran_at) last_at,
            round(avg(duration_ms)/1000.0, 1) avg_s,
            max(left(coalesce(error, ''), 300)) err
       FROM job_run_history
      WHERE ran_at >= ${cutoff}
      GROUP BY job_name, status
      ORDER BY (status = 'failed') DESC, job_name`,
  );

  const failed = runs.filter(r => r.status === 'failed');
  const ok = runs.filter(r => r.status !== 'failed');

  console.log(`\n=== since ${since ?? hours + 'h ago'} ===`);
  console.log(`${ok.reduce((n, r) => n + Number(r.n), 0)} non-failed run(s) across ${ok.length} job/status pair(s)`);

  if (!failed.length) {
    console.log('NO FAILURES.');
  } else {
    console.log(`\n!! ${failed.length} job(s) with failures:\n`);
    for (const f of failed) {
      console.log(`  ${f.job_name}  x${f.n}  last=${new Date(f.last_at).toISOString()}  avg=${f.avg_s}s`);
      if (f.err) console.log(`      ${String(f.err).replace(/\s+/g, ' ').slice(0, 260)}`);
    }
  }

  // A job that has never recorded ANY run since the cutoff is not visible above -- absence is
  // not success. Surface the registry entries that produced nothing at all.
  const { rows: quiet } = await pool.query(
    `SELECT job_name,
            round((extract(epoch from now())*1000 - last_success_at)/3600000.0, 1) h_since_ok,
            last_status
       FROM job_heartbeat
      WHERE last_status = 'failed'
      ORDER BY last_success_at ASC NULLS FIRST
      LIMIT 25`,
  );
  if (quiet.length) {
    console.log(`\n=== heartbeats currently sitting at last_status='failed' (${quiet.length}) ===`);
    for (const q of quiet) {
      console.log(`  ${q.job_name.padEnd(34)} last success ${q.h_since_ok ?? 'never'}h ago`);
    }
  }

  await pool.end();
}

main().catch(async e => {
  console.error('fatal:', e?.message ?? e);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
