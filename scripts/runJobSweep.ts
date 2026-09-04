/**
 * Controlled one-job-at-a-time validation sweep runner.
 *
 * Runs a single scheduled job in isolation (with SCHEDULER_PAUSED=1 holding the rest of the
 * platform off its schedule), times it, and records WHICH TABLES IT ACTUALLY WROTE, derived by
 * diffing pg_stat_user_tables either side of the run rather than from a hand-maintained
 * job->table map. See src/server/jobSweep.ts for why that choice, and for the two correctness
 * traps it encodes (hypertable chunk rollup, cumulative-counter resets).
 *
 * Usage:
 *   tsx scripts/runJobSweep.ts --list
 *   tsx scripts/runJobSweep.ts --control --seconds 30
 *   tsx scripts/runJobSweep.ts --queue data-quality-daily --job data-quality-daily-run
 *
 * --control measures the AMBIENT write noise floor: the five services stay up during the sweep
 * and write heartbeats/cache rows of their own, so "this job wrote 40 rows" is only meaningful
 * against a measured baseline of what gets written when no job runs at all. Run it before
 * trusting any small row_delta.
 */
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import {
  rollupChunks,
  diffSnapshots,
  hasCounterReset,
  totalRowDelta,
  classifyStderr,
  type Snapshot,
} from '../src/server/jobSweep';

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

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2 });

/** Chunk -> parent hypertable. Read fresh each run; chunks are created continuously. */
async function chunkParentMap(): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT chunk_name, hypertable_name FROM timescaledb_information.chunks`,
  );
  return Object.fromEntries(rows.map((r: any) => [r.chunk_name, r.hypertable_name]));
}

async function snapshot(chunkParent: Record<string, string>): Promise<Snapshot> {
  // pg_stat only flushes a backend's counters at commit or on a timer, so a job that has just
  // finished may not be fully reflected yet. Ask for a flush of our own view first.
  await pool.query(`SELECT pg_stat_force_next_flush()`).catch(() => {});
  const { rows } = await pool.query(
    `SELECT relname, n_tup_ins, n_tup_upd, n_tup_del
       FROM pg_stat_user_tables
      WHERE n_tup_ins + n_tup_upd + n_tup_del > 0`,
  );
  return rollupChunks(rows as any, chunkParent);
}

function redisConn() {
  return {
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null as any,
  };
}

async function waitForJob(queue: Queue, jobId: string, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const job = await queue.getJob(jobId);
    if (!job) return { state: 'gone', failedReason: null as string | null, returnvalue: null as any };
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      return { state, failedReason: job.failedReason ?? null, returnvalue: job.returnvalue ?? null };
    }
    if (Date.now() - started > timeoutMs) {
      return { state: `timeout(${state})`, failedReason: `sweep timeout after ${timeoutMs}ms`, returnvalue: null };
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function record(row: Record<string, any>) {
  await pool.query(
    `INSERT INTO job_sweep_results
       (sweep_id, job_name, lane, started_at, finished_at, duration_ms, status,
        stderr_class, error, tables_written, row_delta, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (sweep_id, job_name) DO UPDATE SET
       started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at,
       duration_ms=EXCLUDED.duration_ms, status=EXCLUDED.status,
       stderr_class=EXCLUDED.stderr_class, error=EXCLUDED.error,
       tables_written=EXCLUDED.tables_written, row_delta=EXCLUDED.row_delta, notes=EXCLUDED.notes`,
    [row.sweep_id, row.job_name, row.lane, row.started_at, row.finished_at, row.duration_ms,
     row.status, row.stderr_class, row.error, JSON.stringify(row.tables_written), row.row_delta, row.notes],
  );
}

function summarise(diff: Snapshot) {
  return Object.entries(diff)
    .sort((a, b) => (b[1].ins + b[1].upd + b[1].del) - (a[1].ins + a[1].upd + a[1].del))
    .slice(0, 12)
    .map(([t, d]) => `    ${t}: +${d.ins} ins / ${d.upd} upd / ${d.del} del`)
    .join('\n');
}

async function main() {
  const sweepId = arg('sweep-id', new Date().toISOString().slice(0, 10))!;

  if (flag('list')) {
    const { rows } = await pool.query(
      `SELECT job_name, status, duration_ms, row_delta FROM job_sweep_results
        WHERE sweep_id=$1 ORDER BY started_at`, [sweepId]);
    console.table(rows);
    await pool.end();
    return;
  }

  const chunkParent = await chunkParentMap();

  if (flag('control')) {
    const secs = Number(arg('seconds', '30'));
    console.log(`[SWEEP] control: measuring ambient write noise over ${secs}s with no job running...`);
    const before = await snapshot(chunkParent);
    await new Promise(r => setTimeout(r, secs * 1000));
    const after = await snapshot(chunkParent);
    const diff = diffSnapshots(before, after);
    console.log(`[SWEEP] ambient noise floor: ${totalRowDelta(diff)} rows across ${Object.keys(diff).length} table(s)`);
    if (Object.keys(diff).length) console.log(summarise(diff));
    await record({
      sweep_id: sweepId, job_name: `__control_${secs}s`, lane: 'control',
      started_at: new Date(Date.now() - secs * 1000), finished_at: new Date(),
      duration_ms: secs * 1000, status: 'control', stderr_class: 'clean', error: null,
      tables_written: diff, row_delta: totalRowDelta(diff),
      notes: 'ambient write noise with scheduler paused and services up',
    });
    await pool.end();
    return;
  }

  const queueName = arg('queue');
  const jobName = arg('job');
  const lane = arg('lane', 'unassigned');
  const timeoutMs = Number(arg('timeout-ms', String(30 * 60_000)));
  if (!queueName || !jobName) {
    console.error('need --queue <name> --job <jobName>  (or --control / --list)');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const connection = redisConn();
  const queue = new Queue(queueName, { connection });

  console.log(`[SWEEP] ${queueName} :: ${jobName}  (timeout ${Math.round(timeoutMs / 60000)}m)`);
  const before = await snapshot(chunkParent);
  const startedAt = new Date();
  const t0 = Date.now();

  const sweepJobId = `sweep-${sweepId}-${jobName}-${t0}`;
  await queue.add(jobName, { isSweep: true }, { jobId: sweepJobId, removeOnComplete: false, removeOnFail: false });

  const res = await waitForJob(queue, sweepJobId, timeoutMs);
  const durationMs = Date.now() - t0;

  // Let the just-finished worker's stats reach the shared stats store before snapshotting.
  await new Promise(r => setTimeout(r, 3000));
  const after = await snapshot(chunkParent);
  const diff = diffSnapshots(before, after);
  const reset = hasCounterReset(diff);

  const stderrClass = classifyStderr(res.failedReason);
  // A processor that gated itself (weekend, market-closed, already-ran) returns { skipped: true }.
  // Recording that as 'success' would reproduce, inside the sweep's own results, the exact
  // "skip path stamped as success" defect the sweep exists to find -- and a skip that wrote no
  // rows is indistinguishable from a silent failure unless it is labelled.
  const skipped = Boolean(res.returnvalue && (res.returnvalue as any).skipped);
  // A processor that returns { success: false } has FAILED, but BullMQ still marks the job
  // 'completed' because nothing threw -- registerJob.ts's handler is what turns that into a
  // failed heartbeat. Reading only the BullMQ state would report such a run as a success and
  // reproduce, in the sweep's own output, the defect the sweep exists to detect (seen live
  // 2026-09-05: company-profiles-sync returned success:false and the harness said 'success').
  const selfReportedFailure = Boolean(res.returnvalue && (res.returnvalue as any).success === false);
  const status = reset ? 'unmeasured_counter_reset'
    : res.state === 'completed'
      ? (selfReportedFailure ? 'failed' : skipped ? 'skipped' : 'success')
    : res.state.startsWith('timeout') ? 'timeout' : 'failed';

  console.log(`[SWEEP] status=${status} duration=${(durationMs / 1000).toFixed(1)}s rows=${totalRowDelta(diff)} tables=${Object.keys(diff).length}`);
  if (skipped) console.log(`    skip reason (job returnvalue): ${JSON.stringify(res.returnvalue).slice(0, 240)}`);
  if (Object.keys(diff).length) console.log(summarise(diff));
  else console.log('    (no tables written -- this is the finding, not a gap)');
  if (res.failedReason) console.log(`[SWEEP] error: ${String(res.failedReason).slice(0, 400)}`);

  await record({
    sweep_id: sweepId, job_name: jobName, lane,
    started_at: startedAt, finished_at: new Date(), duration_ms: durationMs,
    status, stderr_class: stderrClass, error: res.failedReason ? String(res.failedReason).slice(0, 4000) : null,
    tables_written: diff, row_delta: totalRowDelta(diff),
    notes: `queue=${queueName}`,
  });

  await queue.close();
  const r = new Redis(connection); await r.quit().catch(() => {});
  await pool.end();
}

main().catch(async (e) => {
  console.error('[SWEEP] fatal:', e?.message ?? e);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
