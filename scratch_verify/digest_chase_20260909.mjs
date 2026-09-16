// Chase the 2026-09-09 evening digest findings: orphan-alert log source, job failure rates.
import fs from 'fs';
import pg from 'pg';

// 0) which DAYS' logs contain the fake-queue orphan alerts, and did Telegram actually send?
for (const day of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']) {
  const f = `logs/app-${day}.log`;
  if (!fs.existsSync(f)) continue;
  const ls = fs.readFileSync(f, 'utf8').trim().split('\n');
  const blocks = ls.filter(l => l.includes('Orphaned job reclaimed after restart'));
  const fake = ls.filter(l => l.includes('fake-queue'));
  const sent = ls.filter(l => /telegram/i.test(l) && /orphan/i.test(l));
  console.log(`${day}: orphanAlertLines=${blocks.length} fakeQueueLines=${fake.length} telegram+orphanLines=${sent.length}`);
  for (const l of sent.slice(0, 2)) {
    try { const o = JSON.parse(l); console.log('   ', o.timestamp, o.level, String(o.message).slice(0, 130)); }
    catch { console.log('   ', l.slice(0, 130)); }
  }
}

// 1) where did the orphan alerts in today's log come from, and did Telegram actually send them?
const lines = fs.readFileSync('logs/app-2026-09-09.log', 'utf8').trim().split('\n');
const orphanIdx = [];
lines.forEach((l, i) => { if (l.includes('Orphaned job reclaimed after restart')) orphanIdx.push(i); });
console.log('orphan alert blocks in log:', orphanIdx.length);
for (const i of [...orphanIdx.slice(0, 3), ...orphanIdx.slice(-2)]) {
  const ts = (() => { try { return JSON.parse(lines[i]).timestamp; } catch { return '?'; } })();
  console.log(`  block@line${i + 1} ts=${ts}`);
  for (let j = i + 1; j <= Math.min(i + 5, lines.length - 1); j++) {
    let s = lines[j]; try { const o = JSON.parse(s); s = `${o.timestamp} ${o.level} ${String(o.message).slice(0, 130)}`; } catch {}
    if (s.includes('Orphaned job reclaimed')) break;
    console.log(`    +${j - i}: ${s.slice(0, 150)}`);
  }
}
// telegram send/skip lines around vitest hours
const tg = lines.filter(l => /telegram/i.test(l) && /"level":"(warn|error|info)"/.test(l) &&
  /orphan|skip|disabled|sent/.test(l));
console.log('\ntelegram send/skip lines mentioning orphan:', tg.filter(l => /orphan/i.test(l)).length);
for (const l of tg.filter(l => /orphan/i.test(l)).slice(0, 3)) {
  try { const o = JSON.parse(l); console.log('  ', o.timestamp, o.level, String(o.message).slice(0, 160)); }
  catch { console.log('  ', l.slice(0, 160)); }
}

// 2) DB: heartbeats + failure details for the flagged jobs
const c = new pg.Client({ connectionString: process.env.POSTGRES_URL || 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel' });
await c.connect();
async function q(label, sql) {
  try {
    const r = await c.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r.rows) console.log(JSON.stringify(row));
  } catch (e) { console.log(`\n=== ${label} === ERROR: ${e.message}`); }
}

await q('heartbeat: flagged jobs', `
  SELECT job_name, last_status, last_run_at, last_success_at, fail_count,
         left(coalesce(last_error,''),180) AS err
    FROM job_heartbeat
   WHERE job_name IN ('ml-weekly-retrain','niftytrader-live-filter','niftytrader-live-filter-capture',
                      'ml-daily-ops','trendlyne-midweek','data-quality-daily','quant-eod-sync','job-digest')
      OR job_name ILIKE '%niftytrader%' OR job_name ILIKE '%weekly%'
   ORDER BY job_name`);

await q('7d failure detail: flagged jobs', `
  SELECT job_name, status, ran_at, left(coalesce(error,''),220) AS err
    FROM job_run_history
   WHERE ran_at > now() - interval '7 days'
     AND (job_name IN ('ml-weekly-retrain','niftytrader-live-filter-capture','ml-daily-ops',
                       'trendlyne-midweek','data-quality-daily','quant-eod-sync','job-digest')
          OR job_name ILIKE '%niftytrader%')
     AND status <> 'success'
   ORDER BY ran_at DESC LIMIT 40`);

await q('ml-weekly-retrain: all runs 10d', `
  SELECT status, ran_at, left(coalesce(error,''),120) AS err
    FROM job_run_history
   WHERE job_name = 'ml-weekly-retrain' AND ran_at > now() - interval '10 days'
   ORDER BY ran_at DESC LIMIT 12`);

await q('heartbeat epochs decoded (IST)', `
  SELECT job_name, last_status,
         to_timestamp(last_run_at/1000.0) AT TIME ZONE 'Asia/Kolkata' AS last_run_ist,
         to_timestamp(last_success_at/1000.0) AT TIME ZONE 'Asia/Kolkata' AS last_ok_ist
    FROM job_heartbeat
   WHERE job_name IN ('ml-weekly-retrain','ml-daily-ops','trendlyne-midweek','job-digest')
   ORDER BY job_name`);

client.end();
