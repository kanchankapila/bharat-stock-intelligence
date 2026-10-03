import { Queue } from 'bullmq';
import 'dotenv/config';
import { execSync } from 'child_process';
import pg from 'pg';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

const pgPool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
});

function getMemoryUsage() {
  try {
    const stdout = execSync('powershell -Command "Get-Process python* -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum"', { encoding: 'utf8' }).trim();
    const bytes = parseInt(stdout, 10);
    return isNaN(bytes) ? 0 : Math.round(bytes / 1024 / 1024);
  } catch {
    return 0;
  }
}

async function runJob(queueName, jobName, timeoutMs = 7200000) {
  console.log(`\n======================================================`);
  console.log(`[WEEKLY RUNNER] Starting job '${jobName}' on queue '${queueName}'`);
  console.log(`[WEEKLY RUNNER] Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  const queue = new Queue(queueName, { connection: REDIS });
  const jobId = `weekly-${jobName}-${Date.now()}`;

  const job = await queue.add(jobName, { manualTrigger: true, triggeredAt: Date.now() }, {
    jobId,
    removeOnComplete: 10,
    removeOnFail: 10,
  });

  console.log(`[WEEKLY RUNNER] Job enqueued with ID: ${job.id}`);
  const startTime = Date.now();
  let peakMemMb = 0;
  let lastLoggedSec = 0;

  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const state = await job.getState();
    const curMem = getMemoryUsage();
    if (curMem > peakMemMb) peakMemMb = curMem;

    if (elapsedSec - lastLoggedSec >= 15 || state === 'completed' || state === 'failed') {
      lastLoggedSec = elapsedSec;
      console.log(`[WEEKLY RUNNER] ${jobName} | State: ${state.toUpperCase()} | Elapsed: ${elapsedSec}s | Python RAM: ${curMem}MB (Peak: ${peakMemMb}MB)`);
    }

    if (state === 'completed') {
      console.log(`\n[WEEKLY RUNNER] >>> SUCCESS! Job ${jobName} completed in ${elapsedSec}s. Peak Python RAM: ${peakMemMb}MB`);
      break;
    }

    if (state === 'failed') {
      const failedReason = job.failedReason || 'Unknown error';
      console.error(`\n[WEEKLY RUNNER] >>> FAILED! Job ${jobName} failed after ${elapsedSec}s.`);
      console.error(`[WEEKLY RUNNER] Reason: ${failedReason}`);
      await queue.close();
      await pgPool.end();
      process.exit(1);
    }

    if (Date.now() - startTime > timeoutMs) {
      console.error(`\n[WEEKLY RUNNER] >>> TIMEOUT! Job ${jobName} exceeded timeout of ${Math.round(timeoutMs / 1000)}s.`);
      await queue.close();
      await pgPool.end();
      process.exit(1);
    }
  }

  // Verify DB heartbeat & run history
  try {
    const resHb = await pgPool.query(
      `SELECT job_name, last_status, to_char(to_timestamp(last_run_at / 1000.0) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as last_run, coalesce(last_error, 'None') as last_error FROM job_heartbeat WHERE job_name = $1`,
      [jobName]
    );
    if (resHb.rows.length > 0) {
      console.log(`[WEEKLY RUNNER] DB Heartbeat: Status=${resHb.rows[0].last_status}, LastRun=${resHb.rows[0].last_run}, Error=${resHb.rows[0].last_error}`);
    }

    const resHist = await pgPool.query(
      `SELECT job_name, status, to_char(ran_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as ran_at, round(duration_ms / 1000.0, 1) as duration_s, coalesce(error, 'None') as error FROM job_run_history WHERE job_name = $1 ORDER BY ran_at DESC LIMIT 1`,
      [jobName]
    );
    if (resHist.rows.length > 0) {
      console.log(`[WEEKLY RUNNER] DB Run History: Status=${resHist.rows[0].status}, Duration=${resHist.rows[0].duration_s}s, Error=${resHist.rows[0].error}`);
    }
  } catch (err) {
    console.warn(`[WEEKLY RUNNER] DB verification query warning: ${err.message}`);
  }

  await queue.close();
  await pgPool.end();
}

const targetJob = process.argv[2];

const JOB_MAP = {
  'mover-study-weekly': { queue: 'mover-reverse-engineering-study', timeout: 3600000 },
  'trendlyne-ratios-monthly': { queue: 'trendlyne-ratios-monthly', timeout: 7200000 },
  'ml-weekly-data': { queue: 'ml-weekly-data', timeout: 14400000 },
  'ml-weekly-retrain': { queue: 'ml-weekly-retrain', timeout: 14400000 },
};

if (!targetJob || !JOB_MAP[targetJob]) {
  console.error(`Usage: node scripts/run_single_weekly_job.mjs <job-name>`);
  console.error(`Available jobs: ${Object.keys(JOB_MAP).join(', ')}`);
  process.exit(1);
}

runJob(JOB_MAP[targetJob].queue, targetJob, JOB_MAP[targetJob].timeout).catch(err => {
  console.error(`[WEEKLY RUNNER] Fatal exception:`, err);
  process.exit(1);
});
