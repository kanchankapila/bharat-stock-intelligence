import { Queue } from 'bullmq';
import 'dotenv/config';
import { execSync } from 'child_process';
import pg from 'pg';
import { isSuccessfulWeeklyJob } from './weeklyJobVerdict.mjs';

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

async function runJob(queueName, jobName, timeoutMs = 7200000, monitorName = jobName) {
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
  let returnValue;
  let completedElapsedSec = 0;

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
      const completedJob = await queue.getJob(job.id);
      returnValue = completedJob?.returnvalue;
      completedElapsedSec = elapsedSec;
      console.log(`\n[WEEKLY RUNNER] BullMQ execution completed in ${elapsedSec}s; verifying semantic result and persisted status...`);
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
  let heartbeatStatus;
  let historyStatus;
  try {
    const resHb = await pgPool.query(
      `SELECT job_name, last_status, to_char(to_timestamp(last_run_at / 1000.0) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as last_run, coalesce(last_error, 'None') as last_error FROM job_heartbeat WHERE job_name = $1`,
      [monitorName]
    );
    if (resHb.rows.length > 0) {
      heartbeatStatus = resHb.rows[0].last_status;
      console.log(`[WEEKLY RUNNER] DB Heartbeat: Status=${resHb.rows[0].last_status}, LastRun=${resHb.rows[0].last_run}, Error=${resHb.rows[0].last_error}`);
    }

    const resHist = await pgPool.query(
      `SELECT job_name, status, to_char(ran_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as ran_at, round(duration_ms / 1000.0, 1) as duration_s, coalesce(error, 'None') as error FROM job_run_history WHERE job_name = $1 ORDER BY ran_at DESC LIMIT 1`,
      [monitorName]
    );
    if (resHist.rows.length > 0) {
      historyStatus = resHist.rows[0].status;
      console.log(`[WEEKLY RUNNER] DB Run History: Status=${resHist.rows[0].status}, Duration=${resHist.rows[0].duration_s}s, Error=${resHist.rows[0].error}`);
    }
  } catch (err) {
    console.warn(`[WEEKLY RUNNER] DB verification query warning: ${err.message}`);
  }

  const succeeded = isSuccessfulWeeklyJob(returnValue, heartbeatStatus, historyStatus);
  if (succeeded) {
    console.log(`\n[WEEKLY RUNNER] >>> SUCCESS! Job ${jobName} completed in ${completedElapsedSec}s. Peak Python RAM: ${peakMemMb}MB`);
  } else {
    const failedSteps = Array.isArray(returnValue?.failedSteps) ? returnValue.failedSteps : [];
    console.error(`\n[WEEKLY RUNNER] >>> FAILED! BullMQ completed, but the job's semantic or persisted verdict failed.`);
    if (failedSteps.length > 0) {
      console.error(`[WEEKLY RUNNER] Failed steps: ${failedSteps.join(', ')}`);
    }
    process.exitCode = 1;
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
  'nse-bulk-block': {
    queue: 'nse-bulk-block',
    jobName: 'nse-bulk-block-daily',
    monitorName: 'nse-bulk-block',
    timeout: 600000,
  },
};

if (!targetJob || !JOB_MAP[targetJob]) {
  console.error(`Usage: node scripts/run_single_weekly_job.mjs <job-name>`);
  console.error(`Available jobs: ${Object.keys(JOB_MAP).join(', ')}`);
  process.exit(1);
}

const target = JOB_MAP[targetJob];
runJob(
  target.queue,
  target.jobName || targetJob,
  target.timeout,
  target.monitorName || targetJob,
).catch(err => {
  console.error(`[WEEKLY RUNNER] Fatal exception:`, err);
  process.exit(1);
});
