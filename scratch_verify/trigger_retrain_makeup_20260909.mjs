// 2026-09-09 evening remediation:
// 1) nt-live-filter-capture afternoon state (log + capture table freshness)
// 2) inspect ml-weekly-retrain queue, then enqueue a DELAYED make-up (~01:00 IST tonight,
//    after the 19:30 IST ml-daily-ops chain finishes) so the weekly retrain + its
//    engine_composite_scores producer stop being stale from the failed 09-06 run.
import fs from 'fs';
import pg from 'pg';
import 'dotenv/config';
import { Queue } from 'bullmq';

// ── 1) capture log truth for today ─────────────────────────────────────────
const ls = fs.readFileSync('logs/app-2026-09-09.log', 'utf8').trim().split('\n');
const cap = ls.filter(l => l.includes('nt-live-filter-capture'));
const count = re => cap.filter(l => re.test(l)).length;
console.log('nt-live-filter-capture log lines today:', cap.length,
  '| completed:', count(/completed/), '| skipped:', count(/skipped/), '| failed:', count(/failed/i));
const fails = cap.filter(l => /failed/i.test(l));
for (const f of fails.slice(-3)) {
  try { const o = JSON.parse(f); console.log('  FAIL', o.timestamp, String(o.message).slice(0, 170)); }
  catch { console.log('  FAIL', f.slice(0, 170)); }
}
// last non-skipped activity
const real = cap.filter(l => /completed/.test(l) && !/skipped/.test(l));
if (real.length) {
  try { const o = JSON.parse(real[real.length - 1]); console.log('last completed slot ts:', o.timestamp); }
  catch { console.log('last completed slot ts: (unparsed)'); }
}

// ── 2) capture table freshness ─────────────────────────────────────────────
const c = new pg.Client({ connectionString: process.env.POSTGRES_URL || 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel' });
await c.connect();
async function q(label, sql) {
  try {
    const r = await c.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r.rows) console.log(JSON.stringify(row).slice(0, 300));
  } catch (e) { console.log(`\n=== ${label} === ERROR: ${e.message}`); }
}
const tbls = await c.query(`SELECT table_name FROM information_schema.tables
  WHERE table_name ILIKE '%live_filter%' OR table_name ILIKE '%nt_live%' OR table_name ILIKE '%niftytrader_live%'`);
console.log('\ncapture-like tables:', tbls.rows.map(r => r.table_name).join(', '));
for (const { table_name } of tbls.rows) {
  await q(`rows/day in ${table_name} (3d)`, `
    SELECT created_at::date AS day, COUNT(*) AS n, MAX(created_at) AS max_ts
      FROM ${table_name} WHERE created_at > now() - interval '3 days'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 5`);
}

// ── 3) inspect + enqueue the weekly retrain make-up ────────────────────────
const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
};
const qWeekly = new Queue('ml-weekly-retrain', { connection });
const delayed = await qWeekly.getJobs(['delayed', 'waiting', 'active']);
console.log('\nml-weekly-retrain pre-add jobs (delayed/waiting/active):', delayed.length,
  delayed.map(j => `${j.name}#${j.id}`).join(', '));

// ~01:00 IST tonight = 19:30 UTC: ml-daily-ops (19:30 IST slot, ~3h) is done by then;
// the weekly chain (~1.5-3h) finishes before the 08:15 IST morning digest.
const target = new Date(Date.now() + 4 * 3600_000);
const delay = Math.max(60_000, target.getTime() - Date.now());
const job = await qWeekly.add('ml-weekly-retrain',
  { isCatchup: true, trigger: 'manual-makeup-20260909-weekly-retrain', reason: '09-06 run failed on marketsmojo steps; engine_composite_scores stale since 09-06' },
  { jobId: 'manual-makeup-20260909-ml-weekly-retrain', delay, attempts: 1, removeOnComplete: 5, removeOnFail: 5 });
console.log(`enqueued make-up job id=${job.id} name=${job.name} delay=${Math.round(delay / 60000)}min (fires ~${new Date(Date.now() + delay).toISOString()} = ${new Date(Date.now() + delay).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)`);
await qWeekly.close();

await c.end();
console.log('\ndone');
