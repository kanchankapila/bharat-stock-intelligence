// Log + DB chase for the 2026-09-09 evening digest, round 2:
// marketsmojo 09-06 failure detail, nt-live-filter-capture runs/errors, step budgets.
import fs from 'fs';
import pg from 'pg';

function grepLog(day, patterns, max = 6) {
  const f = `logs/app-${day}.log`;
  if (!fs.existsSync(f)) { console.log(`${day}: (no log)`); return; }
  const ls = fs.readFileSync(f, 'utf8').trim().split('\n');
  for (const p of patterns) {
    const hits = ls.filter(l => l.toLowerCase().includes(p));
    console.log(`${day} [${p}]: ${hits.length}`);
    for (const h of hits.slice(0, max)) {
      try { const o = JSON.parse(h); console.log('   ', o.timestamp, o.level, String(o.message).replace(/\s+/g, ' ').slice(0, 200)); }
      catch { console.log('   ', h.slice(0, 200)); }
    }
  }
}
grepLog('2026-09-06', ['marketsmojo_financials', 'marketsmojo_shareholding', 'ml-weekly-retrain']);
grepLog('2026-09-09', ['nt-live-filter', 'niftytrader live filter', 'ml-weekly-retrain'], 4);

const c = new pg.Client({ connectionString: process.env.POSTGRES_URL || 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel' });
await c.connect();
async function q(label, sql) {
  try {
    const r = await c.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r.rows) console.log(JSON.stringify(row));
  } catch (e) { console.log(`\n=== ${label} === ERROR: ${e.message}`); }
}

await q('nt-live-filter-capture: runs since 09-08 (IST days)', `
  SELECT ran_at AT TIME ZONE 'Asia/Kolkata' AS ran_ist, status, left(coalesce(error,''),200) AS err
    FROM job_run_history
   WHERE job_name = 'nt-live-filter-capture' AND ran_at > now() - interval '2 days'
   ORDER BY ran_at DESC LIMIT 20`);

await q('nt-live-filter-capture: run counts by status/day', `
  SELECT ran_at::date AS day_utc, status, COUNT(*) AS n,
         left(max(coalesce(error,'')),150) AS sample_err
    FROM job_run_history
   WHERE job_name = 'nt-live-filter-capture' AND ran_at > now() - interval '3 days'
   GROUP BY 1, 2 ORDER BY 1 DESC, 2`);

await q('ml-weekly-retrain: last 5 runs raw', `
  SELECT status, ran_at AT TIME ZONE 'Asia/Kolkata' AS ran_ist,
         left(coalesce(error,''),200) AS err, duration_ms
    FROM job_run_history
   WHERE job_name = 'ml-weekly-retrain'
   ORDER BY ran_at DESC LIMIT 5`);

await q('nt live filter capture table: freshness', `
  SELECT column_name FROM information_schema.columns
   WHERE table_name LIKE '%nt_live%' OR table_name LIKE '%niftytrader_live%' ORDER BY table_name, ordinal_position LIMIT 40`);

await q('nt capture afternoon failures in today log via counts', `SELECT 1 AS x`);

client.end();
