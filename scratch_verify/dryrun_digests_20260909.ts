// Post-restart error sweep + read-only dry-run of tonight's scheduled Telegram digests.
// NOTE: deliberately does NOT call buildDailyDigest() — it persists digest transition state
// (saveDigestState) and a preview would corrupt tonight's "changed since last report" baseline.
// buildRecommendationsDigest() is read-only (SELECT + render), so it is safe to preview.
import fs from 'fs';
import 'dotenv/config';

// 1) errors since the 18:58 restart
const t = fs.readFileSync('logs/app-2026-09-09.log', 'utf8').trim().split('\n');
const errs = t.filter(l => l.includes('"level":"error"') && /2026-09-09 (1[89]|2[0-3]):/.test(l));
console.log('errors since 19:00 IST:', errs.length);
for (const e of errs.slice(0, 5)) {
  try { const j = JSON.parse(e); console.log(' ', j.timestamp, '::', String(j.message).slice(0, 150)); }
  catch { console.log(' ', e.slice(0, 150)); }
}

// 2) read-only content dry-run of the 22:40 IST recommendations digest
const { buildRecommendationsDigest, renderDigest } = await import('../src/server/telegramRecommendations.ts');
const data = await buildRecommendationsDigest();
const text = renderDigest(data);
console.log('\n=== recommendations digest dry-run (NOT sent) ===');
console.log('regime:', data.regime, '| longTerm picks:', data.longTerm.length, '| intraday picks:', data.intraday.length,
  '| intradayGated:', data.intradayGated, '| totalBuys:', data.totalBuys);
console.log('rendered length:', text.length, '(Telegram cap 4096 →', Math.ceil(text.length / 4000), 'chunk(s))');
console.log('--- first 12 lines ---');
console.log(text.split('\n').slice(0, 12).join('\n'));

// 3) what the fixed NSE DAILY SCAN digest would report today (read-only mirror of actionable scan rows)
const { default: pg } = await import('pg');
const c = new pg.Client({ connectionString: process.env.POSTGRES_URL || 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel' });
await c.connect();
const r = await c.query(`
  SELECT count(*) AS n, max(signal_date) AS latest
    FROM recommendation_log
   WHERE source = 'technical_scan' AND signal_date = (SELECT max(signal_date) FROM recommendation_log WHERE source = 'technical_scan')`);
console.log('\n=== NSE DAILY SCAN digest source check ===');
console.log('actionable technical_scan rows on latest date:', r.rows[0].n, '(', r.rows[0].latest, ')');
await c.end();
