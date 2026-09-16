// One-off DB health query used by the 2026-09-09 full audit (telegram reports + job failures).
import pg from 'pg';

const client = new pg.Client({ connectionString: 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel' });
await client.connect();

async function q(label, sql) {
  try {
    const r = await client.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r.rows) console.log(JSON.stringify(row));
  } catch (e) {
    console.log(`\n=== ${label} === ERROR: ${e.message}`);
  }
}

await q('daily_research_reports (last 8)', `
  SELECT report_date, report_type, status,
         left(coalesce(error_message,''), 120) AS err,
         length(coalesce(ai_blurbs_json,''))   AS blurb_len,
         generated_at
    FROM daily_research_reports ORDER BY report_date DESC, report_type LIMIT 8`);

await q('job_run_history non-success (3d)', `
  SELECT job_name, status, COUNT(*) AS n, MAX(ran_at) AS last_at
    FROM job_run_history
   WHERE ran_at > now() - interval '3 days'
   GROUP BY job_name, status
  HAVING COUNT(*) FILTER (WHERE status <> 'success') > 0
   ORDER BY MAX(ran_at) DESC LIMIT 40`);

await q('job_run_history totals yesterday+today', `
  SELECT status, COUNT(*) AS n FROM job_run_history
   WHERE ran_at > now() - interval '2 days' GROUP BY status`);

await q('job_heartbeat columns', `
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'job_heartbeat' ORDER BY ordinal_position`);

await q('recommendations freshness', `
  SELECT 'unified' AS src, MAX(computed_at) AS max_at, COUNT(*) FILTER (WHERE computed_at::timestamp > now() - interval '36 hours') AS recent
    FROM unified_recommendations
   UNION ALL
  SELECT 'intraday', MAX(computed_at), COUNT(*) FILTER (WHERE computed_at::timestamp > now() - interval '36 hours')
    FROM intraday_recommendations`);

await q('unified recs today actionable', `
  SELECT classification, COUNT(*) AS n
    FROM unified_recommendations
   WHERE computed_at::date = (SELECT MAX(computed_at::date) FROM unified_recommendations)
   GROUP BY classification`);

await q('telegram settings (masked)', `
  SELECT key, CASE WHEN key='telegram_bot_token' THEN left(value,8)||'...' ELSE value END AS value
    FROM app_settings WHERE key LIKE 'telegram%'`);

await q('data_quality recent fails', `
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'data_quality_results' ORDER BY ordinal_position`);

await q('computed_at types', `
  SELECT table_name, data_type
    FROM information_schema.columns
   WHERE column_name = 'computed_at' AND table_name IN ('unified_recommendations','intraday_recommendations')`);

await q('job_heartbeat telegram jobs', `
  SELECT job_name, last_status, last_run_at, last_success_at, fail_count,
         left(coalesce(last_error,''), 300) AS err
    FROM job_heartbeat
   WHERE job_name LIKE '%digest%' OR job_name LIKE '%recommendations%'
   ORDER BY job_name`);

await q('data_quality fails/errors (2d)', `
  SELECT check_id, label, status, critical, checked_at, left(detail, 160) AS detail
    FROM data_quality_results
   WHERE status IN ('fail','error')
     AND checked_at > (EXTRACT(epoch FROM now() - interval '2 days') * 1000)
   ORDER BY checked_at DESC LIMIT 30`);

await q('dq current state (latest run per check)', `
  WITH latest AS (
    SELECT DISTINCT ON (check_id) check_id, label, status, critical, detail, checked_at
      FROM data_quality_results ORDER BY check_id, checked_at DESC)
  SELECT status, COUNT(*) AS n,
         SUM(CASE WHEN critical = 1 THEN 1 ELSE 0 END) AS critical_n
    FROM latest GROUP BY status`);

await q('dq critical non-pass detail', `
  WITH latest AS (
    SELECT DISTINCT ON (check_id) check_id, label, status, critical, detail, checked_at
      FROM data_quality_results ORDER BY check_id, checked_at DESC)
  SELECT check_id, label, status, left(detail,140) AS detail,
         to_timestamp(checked_at/1000.0) AT TIME ZONE 'Asia/Kolkata' AS checked_ist
    FROM latest
   WHERE critical = 1 AND status IN ('fail','error','warn')
   ORDER BY status, check_id LIMIT 30`);

await q('unified_recommendations computed_at sample', `
  SELECT computed_at FROM unified_recommendations ORDER BY computed_at DESC LIMIT 2`);

await q('win_probability distribution (latest technical_signals date)', `
  SELECT count(*) AS total,
         count(*) FILTER (WHERE win_probability >= 0.42) AS ge_042,
         count(*) FILTER (WHERE win_probability >= 0.60) AS ge_060,
         count(*) FILTER (WHERE win_probability >= 0.85) AS ge_085,
         round(max(win_probability)::numeric, 4) AS max_wp
    FROM technical_signals
   WHERE date = (SELECT max(date) FROM technical_signals)`);

client.end();