import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';

const BASELINE_MS = Date.now();
const TARGETS = ['quant-eod-sync', 'company-profiles-sync', 'fundamentals-sync'];
const POLL_MS = 5 * 60 * 1000;
const MAX_HOURS = 5;
const deadline = BASELINE_MS + MAX_HOURS * 3600_000;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
// Without this, an idle pooled connection dropping (Postgres restart, network blip)
// throws an unhandled 'error' event and kills the whole process — same fix pgClient.ts
// already applies to the app's main pool.
pool.on('error', (err) => log(`[PG] idle client error: ${err.message}`));

async function getStatus() {
  const r = await pool.query(
    `SELECT job_name, last_status, last_run_at, last_success_at, last_error
     FROM job_heartbeat WHERE job_name = ANY($1)`,
    [TARGETS]
  );
  const byName = Object.fromEntries(r.rows.map(row => [row.job_name, row]));
  return TARGETS.map(name => {
    const row = byName[name];
    const succeededSinceBaseline = row && Number(row.last_success_at) > BASELINE_MS;
    return { name, row, done: !!succeededSinceBaseline };
  });
}

async function sendDigest() {
  const { getSystemStatus } = await import('../src/server/routers/monitor.router.ts');
  const { getLateJobs } = await import('../src/server/jobHeartbeat.ts');
  const { JOB_REGISTRY } = await import('../src/server/jobRegistry.ts');
  const { telegramService } = await import('../src/server/telegramService.ts');

  const now = new Date();
  const late = await getLateJobs(now);
  const lateNames = new Set(late.map(l => l.job));

  const registryLines = JOB_REGISTRY
    .filter(j => j.cronPattern || j.everyMs)
    .map(j => `${lateNames.has(j.jobName) ? '⚠️' : '✅'} ${j.label}`)
    .join('\n');

  const eventDrivenLines = JOB_REGISTRY
    .filter(j => !j.cronPattern && !j.everyMs)
    .map(j => `⏳ ${j.label} (event-driven)`)
    .join('\n');

  const scriptStatuses = await getSystemStatus();
  const scriptIcon = (state) => state === 'success' ? '✅' : state === 'stale' ? '⚠️' : state === 'failed' ? '❌' : '⏳';
  const scriptLines = scriptStatuses.map((s) => `${scriptIcon(s.runState)} ${s.label} (${s.runState})`).join('\n');

  const digest = [
    `📋 *Daily Job Health Digest* — ${now.toISOString().slice(0, 10)}`,
    '',
    '*Scheduled queues:*',
    registryLines,
    '',
    '*Event-driven:*',
    eventDrivenLines,
    '',
    '*ML/data engines:*',
    scriptLines,
  ].join('\n');

  await telegramService.sendMarkdownMessage(digest);
  log('Digest sent.');
  log(digest);
}

async function cleanup() {
  try { await pool.end(); } catch {}
  try {
    const { closePool } = await import('../src/server/pgClient.ts');
    await closePool();
  } catch {}
}

async function main() {
  log(`Watcher started. Waiting for fresh success (after baseline) on: ${TARGETS.join(', ')}`);
  while (Date.now() < deadline) {
    const statuses = await getStatus();
    for (const s of statuses) {
      log(`${s.name}: last_status=${s.row?.last_status ?? 'unknown'} last_success_at=${s.row?.last_success_at ? new Date(Number(s.row.last_success_at)).toISOString() : 'never'} done=${s.done}`);
    }
    if (statuses.every(s => s.done)) {
      log('All target jobs have succeeded since baseline. Sending final digest.');
      await sendDigest();
      await cleanup();
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  log(`Deadline (${MAX_HOURS}h) reached without all targets succeeding. Sending digest anyway (reflects current true state).`);
  await sendDigest();
  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  log(`FATAL: ${e.stack || e.message}`);
  await cleanup();
  process.exit(1);
});
