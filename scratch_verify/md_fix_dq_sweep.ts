/**
 * 2026-09-20 verification probe (measurement.md re-verification fixes).
 *
 * Runs the REAL DQ sweep (runDataQualityChecks) against production with the new per-check
 * job_heartbeat writer, then reports:
 *   1. the fundamentals-history-vendor-field-decay verdict -- expect PASS at ROE ~77.8%
 *      (1,924/2,474) after the InvestSights snapshot fallback backfilled the 2026-09-20
 *      snapshot (was 6.1%, 151/2,474, failing data-quality-daily 27x since 09-15);
 *   2. how many check-id heartbeat rows are now populated (was: 12 rows all
 *      last_status=NULL / run_count=0 -- "NULL = unmonitored, not healthy").
 *
 * Writes only the sweep's own tables (data_quality_results/_history + job_heartbeat) -- the
 * same writes the 15-min watchdog sweep already performs; no job_run_history append.
 */
import fs from 'fs';
import path from 'path';

(function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
})();

import { runDataQualityChecks } from '../src/server/dataQualityChecks';
import { dbAll } from '../src/server/dbAsync';

async function main() {
  const results = await runDataQualityChecks();
  const pass = results.filter(r => r.status === 'pass').length;
  const warn = results.filter(r => r.status === 'warn').length;
  const failed = results.filter(r => r.status === 'fail' || r.status === 'error');
  console.log(`sweep: ${results.length} checks -> pass=${pass} warn=${warn} fail/error=${failed.length}`);
  for (const f of failed) console.log(`  FAIL ${f.id} (critical=${f.critical}): ${f.detail.slice(0, 160)}`);

  const vfd = results.find(r => r.id === 'fundamentals-history-vendor-field-decay');
  console.log('vendor-field-decay:', JSON.stringify(vfd));

  const hb = await dbAll<{ job_name: string; last_status: string; run_count: string; fail_count: string }>(
    `SELECT hb.job_name, hb.last_status, hb.run_count, hb.fail_count
       FROM job_heartbeat hb
      WHERE hb.job_name IN (SELECT check_id FROM data_quality_results)
      ORDER BY hb.last_status NULLS FIRST, hb.job_name`,
  );
  const populated = hb.filter(r => r.last_status != null);
  const stillNull = hb.filter(r => r.last_status == null);
  console.log(`DQ check-id heartbeat rows: ${hb.length} total, ${populated.length} populated, ${stillNull.length} still NULL`);
  for (const r of populated.slice(0, 8)) console.log(`  ${r.job_name}: ${r.last_status} runs=${r.run_count} fails=${r.fail_count}`);
  process.exit(0);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
