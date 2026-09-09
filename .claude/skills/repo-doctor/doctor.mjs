#!/usr/bin/env node
/**
 * repo-doctor — ONE consolidated health check across codebase, database, frontend and logs,
 * encoding every recurring bug class this repo has seen (see .claude/rules/recurring-bugs.md).
 *
 * Usage:
 *   node .claude/skills/repo-doctor/doctor.mjs           # quick: static checks + DB + logs
 *   node .claude/skills/repo-doctor/doctor.mjs --full    # also runs tsc + vite build
 *
 * Exit code: 0 = all clear (warnings allowed), 1 = at least one FAIL.
 *
 * RULE: when a new recurring bug is root-caused, ADD A CHECK HERE (the grep/query that would
 * have caught it, negative-controlled so healthy code doesn't trip it) AND a row in
 * recurring-bugs.md. A bug class without a check here WILL silently recur.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import 'dotenv/config';

const ROOT = process.cwd();
const results = [];
const check = (id, lane, status, detail) => {
  results.push({ id, lane, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️ ' : status === 'SKIP' ? '➖' : '❌';
  console.log(`${icon} [${lane}] ${id} — ${detail}`);
};
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };

// ───────────────────────── A. CODEBASE static checks ─────────────────────────
console.log('\n━━━ A. Codebase ━━━');

// AF-20260909-07: 429 must be retried, never treated as final
const tg = read('src/server/telegramService.ts');
check('tg-429-retry', 'code',
  tg.includes('postWithRateLimitRetry') ? 'PASS' : 'FAIL',
  tg.includes('postWithRateLimitRetry') ? '429 retry helper present in telegramService' : 'postWithRateLimitRetry MISSING — 429s would silently drop digests again');

// AF-20260909-11 follow-up: unmocked test sends must be impossible
check('tg-vitest-guard', 'code',
  tg.includes('process.env.VITEST') ? 'PASS' : 'FAIL',
  tg.includes('process.env.VITEST') ? 'sendMarkdownMessage refuses to send under vitest' : 'VITEST guard MISSING — an unmocked test can message the production Telegram chat');

// AF-20260909-11 root: any test file that IMPORTS jobs/registerJob must either mock
// telegramService or mock registerJob itself (a full-module vi.mock never loads the real file).
// Comment-only path mentions don't count — match import statements, not prose.
let unmocked = [];
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/server/__tests__'))) {
    if (!f.endsWith('.test.ts')) continue;
    const t = read(path.join('src/server/__tests__', f));
    const imports = /from '[^']*jobs\/registerJob'/.test(t);
    const safe = t.includes("vi.mock('../telegramService'") || t.includes("vi.mock('../jobs/registerJob'");
    if (imports && !safe) unmocked.push(f);
  }
} catch { /* dir missing in odd checkouts */ }
check('tests-mock-telegram', 'code', unmocked.length ? 'FAIL' : 'PASS',
  unmocked.length ? `test files import jobs/registerJob WITHOUT mocking telegramService: ${unmocked.join(', ')}` : 'all registerJob-driving tests mock telegramService');

// AF-20260909-08: the dead winProbability gate must never come back
const tss = read('src/server/technicalSignalsService.ts');
check('scan-digest-gate', 'code',
  tss.includes('r.winProbability >= 0.85') ? 'FAIL' : (tss.includes('sendTelegramSignals') ? 'PASS' : 'WARN'),
  tss.includes('r.winProbability >= 0.85') ? 'dead winProbability gate RESURRECTED — scan digest would go silent again' : (tss.includes('sendTelegramSignals') ? 'scan digest gated on signalScore + export present' : 'sendTelegramSignals export not found — scan digest path changed, re-verify'));

// AF-20260909-09: benign stderr classification
const sweep = read('src/server/jobSweep.ts');
check('highflyer-benign', 'code',
  /HighFlyer.*skipped.*stat day/i.test(sweep) ? 'PASS' : 'WARN',
  /HighFlyer.*skipped.*stat day/i.test(sweep) ? 'HighFlyer skip-notice in BENIGN list' : 'HighFlyer benign pattern missing — successful runs will warn as real_error again');

// AF-20260909-10: vite watcher must ignore churn-only files
const vite = read('vite.config.ts');
check('vite-watch-ignored', 'code',
  vite.includes('.audit-files.txt') ? 'PASS' : 'WARN',
  vite.includes('.audit-files.txt') ? '.audit-files.txt in vite watch.ignored' : 'audit scratch files may re-trigger EBUSY rejections in vite watcher');

// Recurring class "notification gate reads a field its pipeline never populates" (heuristic)
const suspectGates = new Set();
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/server'))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    if (/\.winProbability\b/.test(read(path.join('src/server', f)))) suspectGates.add(f);
  }
} catch { /* ignore */ }
check('gate-field-writers', 'code', suspectGates.size ? 'WARN' : 'PASS',
  suspectGates.size ? `.winProbability readers exist in ${[...suspectGates].join(', ')} — verify the pipeline POPULATES each gated field (grep the WRITER, not the reader)` : 'no suspicious never-populated gate fields (winProbability class)');

// SQLite-ism guard: SQLite-only SQL in server TS (pgClient may translate — flag for a read)
const sqliteisms = [];
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/server'))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    if (/datetime\('now'\)|strftime\(/.test(read(path.join('src/server', f)))) sqliteisms.push(f);
  }
} catch { /* ignore */ }
check('sqlite-isms', 'code', sqliteisms.length ? 'WARN' : 'PASS',
  sqliteisms.length ? `SQLite-only SQL in ${sqliteisms.join(', ')} — confirm pgClient translates or convert` : 'no SQLite-only SQL in server TS');

// AF-20260909-14: classification colour mappings must never be inverted relative to
// direction. The Grafana "top losers" panel once mapped Strong Sell → dark-green / Strong
// Buy → dark-red (a correct Sell call showed green); this greps every grafana/*.json for
// the inverted signature so it cannot silently recur beside a correctly-coloured sibling.
const grafanaDir = 'grafana';
const invertedColourMappings = [];
try {
  for (const f of fs.readdirSync(path.join(ROOT, grafanaDir))) {
    if (!f.endsWith('.json')) continue;
    const g = read(path.join(grafanaDir, f));
    if (/"Strong Sell"\s*:\s*\{[^}]*"color"\s*:\s*"dark-green"/.test(g) ||
        /"Strong Buy"\s*:\s*\{[^}]*"color"\s*:\s*"dark-red"/.test(g)) invertedColourMappings.push(f);
  }
} catch { /* grafana/ absent */ }
check('grafana-systemcall-colors', 'code', invertedColourMappings.length ? 'FAIL' : 'PASS',
  invertedColourMappings.length
    ? `inverted System-call colour mapping (Sell=green / Buy=red) in ${invertedColourMappings.join(', ')} — flip it back` : 'all grafana classification mappings colour Sell=red, Buy=green');

// ───────────────────────── B. FRONTEND ─────────────────────────
console.log('\n━━━ B. Frontend ━━━');
const indexHtml = read('index.html');
check('frontend-shell', 'frontend', indexHtml ? 'PASS' : 'WARN',
  indexHtml ? 'index.html present (v1 shell is the only frontend since fd0cbd4)' : 'index.html not found — frontend shape changed?');
if (process.argv.includes('--full')) {
  try {
    execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 10 * 60_000 });
    check('tsc-noemit', 'frontend', 'PASS', 'tsc --noEmit clean');
  } catch (e) {
    check('tsc-noemit', 'frontend', 'FAIL', `tsc errors: ${String(e.stdout || e.message).slice(0, 400)}`);
  }
  try {
    execSync('npx vite build --logLevel error', { cwd: ROOT, stdio: 'pipe', timeout: 15 * 60_000 });
    check('vite-build', 'frontend', 'PASS', 'vite build clean');
  } catch (e) {
    check('vite-build', 'frontend', 'FAIL', `vite build failed: ${String(e.stdout || e.message).slice(0, 400)}`);
  }
} else {
  check('tsc-noemit', 'frontend', 'SKIP', 'run with --full to execute tsc/vite build');
}

// ───────────────────────── C. DATABASE ─────────────────────────
console.log('\n━━━ C. Database ━━━');
let client = null;
try {
  const pg = (await import('pg')).default;
  client = new pg.Client({
    connectionString: process.env.POSTGRES_URL || 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel',
    statement_timeout: 15_000,
  });
  await client.connect();
} catch (e) {
  check('pg-connect', 'db', 'FAIL', `cannot reach Postgres: ${e.message}`);
}
if (client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const nowMs = Date.now();

  // job_heartbeat stores naive-UTC epochs: compare epoch ms directly, never AT TIME ZONE.
  // Ages = cadence + documented grace from JOB_REGISTRY (rounded up generously).
  const freshness = [
    ['ml-daily-ops', 30], ['ml-weekly-retrain', 24 * 9], ['data-quality-daily', 30],
    ['job-digest', 30], ['job-digest-morning', 30], ['recommendations-digest', 30],
    ['quant-eod-sync', 30], ['outcome-resolver', 30], ['trendlyne-midweek', 24 * 9],
    ['nt-live-filter-capture', 20], ['technical-signals', 2],
  ];
  for (const [job, maxAgeH] of freshness) {
    try {
      const rows = await q(`SELECT last_status, last_success_at FROM job_heartbeat WHERE job_name = '${job}'`);
      if (!rows.length) { check(`hb-${job}`, 'db', 'WARN', 'no heartbeat row (verify the job is heartbeat-less by design)'); continue; }
      const ageH = (nowMs - Number(rows[0].last_success_at || 0)) / 3_600_000;
      check(`hb-${job}`, 'db', ageH > maxAgeH ? 'WARN' : 'PASS',
        `last success ${ageH.toFixed(1)}h ago (tolerates ≤${maxAgeH}h), status ${rows[0].last_status}`);
    } catch (e) { check(`hb-${job}`, 'db', 'WARN', `query failed: ${e.message}`); }
  }

  // 7d fail-rate flags (same shape the digest uses)
  try {
    const fr = await q(`SELECT job_name, COUNT(*) AS total, COUNT(*) FILTER (WHERE status <> 'success') AS fails
      FROM job_run_history WHERE ran_at > now() - interval '7 days'
      GROUP BY job_name HAVING COUNT(*) >= 5`);
    const flagged = fr.filter(r => r.fails / r.total > 0.25);
    check('fail-rates-7d', 'db', flagged.length ? 'WARN' : 'PASS',
      flagged.length ? `>25% fail-rate (7d): ${flagged.map(r => `${r.job_name} ${r.fails}/${r.total}`).join('; ')} — classify each failure (vendor/timeout/real)` : 'no job above 25% fail-rate over 7d');
  } catch (e) { check('fail-rates-7d', 'db', 'WARN', e.message); }

  // 48h failures not explained by known-benign vendor/retry classes
  const KNOWN = /niftytrader|trendlyne|marketsmojo|waf|captcha|429|execution budget|vendor|steps failed|failed to send|403 Forbidden|Live Market Screener/i;
  try {
    const fails48 = await q(`SELECT job_name, ran_at, left(coalesce(error,''),160) AS err
      FROM job_run_history WHERE ran_at > now() - interval '48 hours' AND status <> 'success'
      ORDER BY ran_at DESC LIMIT 20`);
    const unexplained = fails48.filter(r => !KNOWN.test(r.err));
    check('failures-48h', 'db', unexplained.length ? 'WARN' : 'PASS',
      unexplained.length
        ? `failures needing root-cause: ${unexplained.map(r => `${r.job_name}@${new Date(r.ran_at).toISOString().slice(0, 16)}: ${r.err}`).join(' | ').slice(0, 400)}`
        : `${fails48.length} failures in 48h, all match known-benign vendor/retry classes`);
  } catch (e) { check('failures-48h', 'db', 'WARN', e.message); }

  // data-quality latest-per-check
  try {
    const dq = await q(`WITH latest AS (SELECT DISTINCT ON (check_id) check_id, status, critical
        FROM data_quality_results ORDER BY check_id, checked_at DESC)
      SELECT status, COUNT(*) AS n, SUM(CASE WHEN critical = 1 THEN 1 ELSE 0 END) AS crit FROM latest GROUP BY status`);
    const dqFail = dq.filter(r => r.status === 'fail' || r.status === 'error');
    check('dq-latest', 'db', dqFail.length ? 'FAIL' : 'PASS',
      dq.map(r => `${r.status}=${r.n}${Number(r.crit) ? `(crit ${r.crit})` : ''}`).join(' / '));
  } catch (e) { check('dq-latest', 'db', 'WARN', e.message); }

  // ml dispersion collapse (isotonic-calibration behaviour — trend-watch, not a fix)
  try {
    const disp = await q(`SELECT status, left(detail, 200) AS detail FROM data_quality_results
      WHERE check_id = 'ur-engine-dispersion-collapse' ORDER BY checked_at DESC LIMIT 1`);
    if (disp.length) check('ml-dispersion', 'db', disp[0].status === 'fail' ? 'WARN' : 'PASS',
      `${disp[0].status}: ${disp[0].detail} (measurement.md: do NOT "fix"; watch trend + retrain freshness)`);
  } catch { /* check may not exist */ }

  // producer freshness: engine composite / recommendations / research reports
  try {
    const ecs = await q(`SELECT MAX(computed_at) AS m FROM engine_composite_scores`);
    const ageD = ecs[0]?.m ? (nowMs - new Date(ecs[0].m).getTime()) / 86_400_000 : 1e9;
    check('engine-composite', 'db', ageD > 9 ? 'WARN' : 'PASS',
      `engine_composite_scores max computed_at ${ecs[0]?.m ?? 'NULL'} (${ageD.toFixed(1)}d old; producer = ml-weekly-retrain)`);
    const recs = await q(`SELECT 'unified' AS src, MAX(computed_at) AS m FROM unified_recommendations
      UNION ALL SELECT 'intraday', MAX(computed_at) FROM intraday_recommendations`);
    for (const r of recs) {
      const stale = !r.m || r.m.slice(0, 10) < new Date(nowMs - 36 * 3_600_000).toISOString().slice(0, 10);
      check(`recs-${r.src}`, 'db', stale ? 'WARN' : 'PASS', `max computed_at ${r.m}`);
    }
    const reports = await q(`SELECT status, COUNT(*) AS n FROM daily_research_reports
      WHERE report_date >= (SELECT MAX(report_date) FROM daily_research_reports) GROUP BY status`);
    check('research-reports', 'db', reports.some(r => r.status !== 'READY') ? 'WARN' : 'PASS',
      reports.map(r => `${r.status}=${r.n}`).join(' / ') || 'no rows');
  } catch (e) { check('producer-freshness', 'db', 'WARN', e.message); }

  // test-fixture contamination (AF-20260909-11 class)
  try {
    const contam = await q(`SELECT COUNT(*) AS n FROM job_heartbeat WHERE last_error LIKE '%fake-queue%'`);
    check('no-test-contamination', 'db', Number(contam[0].n) > 0 ? 'FAIL' : 'PASS',
      Number(contam[0].n) > 0 ? `${contam[0].n} heartbeat rows reference 'fake-queue' — test fixtures leaked into prod state` : 'no fake-queue contamination in job_heartbeat');
  } catch (e) { check('no-test-contamination', 'db', 'WARN', e.message); }

  // telegram settings + gemini key
  try {
    const tgset = await q(`SELECT key, CASE WHEN key='telegram_bot_token' THEN left(value,8)||'...' ELSE value END AS v
      FROM app_settings WHERE key LIKE 'telegram%'`);
    const enabled = tgset.find(r => r.key === 'telegram_enabled')?.v === 'true';
    const hasTok = !!tgset.find(r => r.key === 'telegram_bot_token');
    check('telegram-settings', 'db', enabled && hasTok ? 'PASS' : 'WARN',
      tgset.map(r => `${r.key}=${r.v}`).join(', '));
  } catch (e) { check('telegram-settings', 'db', 'WARN', e.message); }
  check('gemini-key', 'db', process.env.GEMINI_API_KEY ? 'PASS' : 'WARN',
    process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY present' : 'GEMINI_API_KEY empty — AI features degrade honestly (user action, AF-20260828-24)');
}
// ───────────────────────── D. LOGS (today + yesterday) ─────────────────────────
console.log('\n━━━ D. Logs ━━━');
const BENIGN_LOG = [
  [/waf|captcha/i, 'Trendlyne WAF captcha (vendor block, self-clears)'],
  [/niftytrader.*(unauthorized|403|timeout)|execution budget/i, 'NiftyTrader vendor block/budget (self-clears)'],
  [/marketsmojo/i, 'MarketsMojo crawl (progressive 7-day skip cache)'],
  [/EBUSY.*audit-files/i, 'vite watcher EBUSY (ignored since AF-10)'],
  [/error_code:? ?429|retry after/i, 'Telegram 429 (retried since AF-07)'],
  [/timeout exceeded when trying to connect/i, 'DB connect blip (documented transient family — verify it did not persist)'],
  [/Error fetching /i, 'fetcher vendor error (verify the next scheduled run succeeded)'],
];
try {
  const days = [new Date(), new Date(Date.now() - 86_400_000)].map(d => d.toISOString().slice(0, 10));
  const seen = new Map();
  for (const day of days) {
    const f = path.join(ROOT, 'logs', `app-${day}.log`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"level":"error"')) continue;
      let msg = line; try { msg = JSON.parse(line).message || line; } catch { /* raw */ }
      const key = String(msg).replace(/[0-9a-f-]{16,}|\d{3,}/g, '#').slice(0, 90);
      if (!seen.has(key)) {
        seen.set(key, { n: 0, sample: String(msg).slice(0, 140), benign: (BENIGN_LOG.find(([re]) => re.test(String(msg))) || [])[1] });
      }
      seen.get(key).n++;
    }
  }
  const unknown = [...seen.entries()].filter(([, v]) => !v.benign);
  const totalErr = [...seen.values()].reduce((a, v) => a + v.n, 0);
  check('log-errors', 'logs', unknown.length ? 'WARN' : 'PASS',
    unknown.length
      ? `${unknown.length} unclassified error signature(s): ${unknown.slice(0, 4).map(([, v]) => `${v.n}x ${v.sample}`).join(' | ')}`
      : `${totalErr} error lines, all match known-benign classes`);
  for (const [, v] of [...seen.entries()].filter(([, v]) => v.benign).slice(0, 6)) {
    console.log(`      · benign ${v.n}x — ${v.benign}`);
  }
} catch (e) {
  check('log-errors', 'logs', 'WARN', `log scan failed: ${e.message}`);
}

// ───────────────────────── summary ─────────────────────────
const fails = results.filter(r => r.status === 'FAIL');
const warns = results.filter(r => r.status === 'WARN');
console.log(`\n━━━ repo-doctor: ${results.length} checks — ${results.filter(r => r.status === 'PASS').length} PASS, ${warns.length} WARN, ${fails.length} FAIL ━━━`);
if (warns.length) console.log('WARN = needs a human read (documented-benign or trend-watch), not necessarily a fix.');
if (client) await client.end().catch(() => {});
if (fails.length) { console.log('FAIL = regression-guard breach — fix before commit.'); process.exit(1); }
