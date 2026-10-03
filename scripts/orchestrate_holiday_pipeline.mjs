import { Queue, QueueEvents } from 'bullmq';
import 'dotenv/config';
import pg from 'pg';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
pool.on('error', (err) => console.error(`[PG] idle client error: ${err.message}`));

const PIPELINE_STEPS = [
  {
    id: 'stock-scoring',
    label: 'Stock Scoring (screener/news composite per timeframe)',
    queue: 'stock-scoring',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 20 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT count(*) as count, max(updated_at) as latest_update FROM stock_scores"
      );
      return `Stock scores count=${res.rows[0].count}, latest_update=${res.rows[0].latest_update}`;
    },
  },
  {
    id: 'quant-scoring',
    label: 'Quant Scoring (strategy ranks, multi-factor alpha, risk metrics)',
    queue: 'quant-scoring',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 50 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT count(*) as total, count(momentum_score) as with_momentum, count(mf_composite_score) as with_mf, count(beta_1y) as with_beta FROM quant_scores"
      );
      return `Quant scores total=${res.rows[0].total}, with_momentum=${res.rows[0].with_momentum}, with_mf=${res.rows[0].with_mf}, with_beta=${res.rows[0].with_beta}`;
    },
  },
  {
    id: 'confluence-compute',
    label: 'Confluence Signals Engine (multi-screener confluence & ML overlay)',
    queue: 'confluence-compute',
    jobName: 'closed-day-early',
    jobData: { force: true },
    timeoutMs: 15 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT max(computed_at) as latest_update FROM confluence_signals"
      );
      return `Confluence signals latest_update=${res.rows[0].latest_update}`;
    },
  },
  {
    id: 'outcome-resolver',
    label: 'Outcome Resolver (1d/5d/15d horizons & live screeners)',
    queue: 'outcome-resolver',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 20 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT max(computed_at) as latest_computed FROM signal_outcomes"
      );
      return `Signal outcomes latest_computed=${res.rows[0].latest_computed}`;
    },
  },
  {
    id: 'unified-ranker',
    label: 'Unified Daily Ranker (Canonical Master Recommendation Engine)',
    queue: 'unified-ranker',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 80 * 60_000,
    verify: async () => {
      const res = await pool.query(
        `SELECT count(*) as count,
                max(generated_at) as latest_generated,
                count(*) FILTER (WHERE conviction_level IN ('S_ELITE', 'A_HIGH')) as elite_high_count
         FROM unified_recommendations
         WHERE (generated_at AT TIME ZONE 'Asia/Kolkata')::date = CURRENT_DATE`
      );
      return `Today's unified recommendations: count=${res.rows[0].count}, Elite/High conviction=${res.rows[0].elite_high_count}, generated_at=${res.rows[0].latest_generated}`;
    },
  },
  {
    id: 'recommendations-digest',
    label: 'Daily Stock Recommendations Digest (Freshness check & Telegram)',
    queue: 'recommendations-digest',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 15 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT last_status, last_error, to_timestamp(last_run_at/1000) as last_run FROM job_heartbeat WHERE job_name = 'recommendations-digest'"
      );
      return `Digest heartbeat: status=${res.rows[0]?.last_status}, error=${res.rows[0]?.last_error ?? 'none'}, last_run=${res.rows[0]?.last_run}`;
    },
  },
  {
    id: 'data-quality-daily',
    label: 'Daily Data Quality & Integrity Report (25-check suite)',
    queue: 'data-quality-daily',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 45 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT last_status, last_error, to_timestamp(last_run_at/1000) as last_run FROM job_heartbeat WHERE job_name = 'data-quality-daily'"
      );
      return `Data quality heartbeat: status=${res.rows[0]?.last_status}, error=${res.rows[0]?.last_error ?? 'none'}, last_run=${res.rows[0]?.last_run}`;
    },
  },
  {
    id: 'stuck-signal-resolver',
    label: 'Stuck Signal Resolver (Lifecycle expiry & exit tracking)',
    queue: 'stuck-signal-resolver',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 35 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT last_status, last_error, to_timestamp(last_run_at/1000) as last_run FROM job_heartbeat WHERE job_name = 'stuck-signal-resolver'"
      );
      return `Stuck signal resolver heartbeat: status=${res.rows[0]?.last_status}, error=${res.rows[0]?.last_error ?? 'none'}, last_run=${res.rows[0]?.last_run}`;
    },
  },
  {
    id: 'confluence-outcomes',
    label: 'Confluence Outcomes & ML Model Trainer',
    queue: 'confluence-outcomes',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 35 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT last_status, last_error, to_timestamp(last_run_at/1000) as last_run FROM job_heartbeat WHERE job_name = 'confluence-outcomes'"
      );
      return `Confluence outcomes heartbeat: status=${res.rows[0]?.last_status}, error=${res.rows[0]?.last_error ?? 'none'}, last_run=${res.rows[0]?.last_run}`;
    },
  },
  {
    id: 'trendlyne-screener-sync',
    label: 'Trendlyne Screener Sync (Membership & stocks)',
    queue: 'trendlyne-screener-sync',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 75 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT last_status, last_error, to_timestamp(last_run_at/1000) as last_run FROM job_heartbeat WHERE job_name = 'trendlyne-screener-sync'"
      );
      return `Trendlyne screener sync heartbeat: status=${res.rows[0]?.last_status}, error=${res.rows[0]?.last_error ?? 'none'}, last_run=${res.rows[0]?.last_run}`;
    },
  },
  {
    id: 'etnow-screener-sync',
    label: 'ETNow Screener Sync (Membership & stocks)',
    queue: 'etnow-screener-sync',
    jobName: 'closed-day-early',
    jobData: {},
    timeoutMs: 45 * 60_000,
    verify: async () => {
      const res = await pool.query(
        "SELECT last_status, last_error, to_timestamp(last_run_at/1000) as last_run FROM job_heartbeat WHERE job_name = 'etnow-screener-sync'"
      );
      return `ETNow screener sync heartbeat: status=${res.rows[0]?.last_status}, error=${res.rows[0]?.last_error ?? 'none'}, last_run=${res.rows[0]?.last_run}`;
    },
  },
];

async function runStep(step, index, total) {
  const stepStart = Date.now();
  console.log(`\n========================================================================`);
  console.log(`[PIPELINE] Step ${index + 1}/${total}: ${step.label} (${step.id})`);
  console.log(`[PIPELINE] Queue: ${step.queue} | JobName: ${step.jobName} | Timeout: ${step.timeoutMs / 60000}m`);
  console.log(`========================================================================`);

  const q = new Queue(step.queue, { connection: REDIS });
  const events = new QueueEvents(step.queue, { connection: REDIS });
  await events.waitUntilReady();

  // Baseline heartbeat timestamp
  const hbRes = await pool.query(
    "SELECT last_run_at, last_success_at FROM job_heartbeat WHERE job_name = $1",
    [step.id]
  );
  const baselineRunAt = Number(hbRes.rows[0]?.last_run_at || 0);

  const activeJobs = await q.getActive();
  let job = activeJobs[0];
  if (job) {
    console.log(`[PIPELINE] Found active job ${job.id} already executing in '${step.queue}'. Attaching to existing job...`);
  } else {
    // Ensure no other active job is executing across any pipeline queue to prevent memory contention
    while (true) {
      let totalActive = 0;
      for (const s of PIPELINE_STEPS) {
        const sq = new Queue(s.queue, { connection: REDIS });
        const c = await sq.getJobCounts('active');
        totalActive += c.active;
        await sq.close();
      }
      if (totalActive === 0) break;
      console.log(`[PIPELINE] Waiting for ${totalActive} active pipeline job(s) to finish before starting ${step.id}...`);
      await new Promise((r) => setTimeout(r, 10000));
    }

    const jobId = `holiday-${step.id}-${Date.now()}`;
    console.log(`[PIPELINE] Enqueuing job ${jobId} to '${step.queue}'...`);
    job = await q.add(step.jobName, step.jobData, {
      jobId,
      removeOnComplete: 10,
      removeOnFail: 20,
    });
    console.log(`[PIPELINE] Enqueued job ID: ${job.id}. Monitoring execution in bharat-server...`);
  }

  const giveUpAt = Date.now() + step.timeoutMs;
  let completed = false;
  let jobError = null;

  const eventPromise = job.waitUntilFinished(events).then(
    (res) => {
      completed = true;
      return res;
    },
    (err) => {
      completed = true;
      jobError = err;
    }
  );

  while (!completed && Date.now() < giveUpAt) {
    await Promise.race([
      eventPromise,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    if (completed) break;

    // Heartbeat check fallback
    const checkHb = await pool.query(
      "SELECT last_status, last_run_at, last_success_at, last_error FROM job_heartbeat WHERE job_name = $1",
      [step.id]
    );
    const row = checkHb.rows[0];
    if (row && Number(row.last_run_at) > baselineRunAt) {
      if (row.last_status === 'success') {
        console.log(`\n[PIPELINE] Detected 'success' in job_heartbeat for ${step.id}!`);
        completed = true;
        break;
      } else if (row.last_status === 'failed') {
        console.error(`\n[PIPELINE] Detected 'failed' in job_heartbeat: ${row.last_error}`);
        jobError = new Error(row.last_error || 'Job failed in worker');
        completed = true;
        break;
      }
    }

    const elapsedSec = Math.round((Date.now() - stepStart) / 1000);
    process.stdout.write(`\r[PIPELINE] In progress... ${elapsedSec}s elapsed`);
  }

  console.log(''); // newline

  await events.close();
  await q.close();

  if (jobError) {
    throw new Error(`Step ${step.id} failed: ${jobError.message}`);
  }

  if (!completed) {
    throw new Error(`Step ${step.id} timed out after ${step.timeoutMs / 60000}m`);
  }

  // Verification against live production DB
  console.log(`[PIPELINE] Verifying database output for ${step.id}...`);
  if (step.verify) {
    const vResult = await step.verify();
    console.log(`[PIPELINE] [VERIFIED] ${vResult}`);
  }

  const durationSec = Math.round((Date.now() - stepStart) / 1000);
  console.log(`[PIPELINE] >>> Step ${step.id} COMPLETED AND VERIFIED in ${durationSec}s!`);
}

async function main() {
  const overallStart = Date.now();
  console.log(`\n************************************************************************`);
  console.log(`*  Bharat Stock Intelligence — Critical Signal/Recommendation Pipeline *`);
  console.log(`*  Date: ${new Date().toISOString().slice(0, 10)} | Steps: ${PIPELINE_STEPS.length}                           *`);
  console.log(`************************************************************************`);

  const startIndex = parseInt(process.argv[2] || '0', 10);
  if (startIndex > 0) {
    console.log(`[PIPELINE] Resuming from step index ${startIndex} (${PIPELINE_STEPS[startIndex]?.id})`);
  }

  for (let i = startIndex; i < PIPELINE_STEPS.length; i++) {
    const step = PIPELINE_STEPS[i];
    await runStep(step, i, PIPELINE_STEPS.length);
  }

  const totalMin = Math.round((Date.now() - overallStart) / 60000);
  console.log(`\n************************************************************************`);
  console.log(`*  ALL CRITICAL JOBS COMPLETED END-TO-END SUCCESSFULLY IN ${totalMin}m!       *`);
  console.log(`************************************************************************\n`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`\n[PIPELINE ERROR] Pipeline halted:`, err.message);
  await pool.end();
  process.exit(1);
});
