import { Queue } from 'bullmq';
import 'dotenv/config';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

// Usage: node scripts/trigger_job.mjs [queueName] [jobName]
// Both default to the original hardcoded ml-weekly-retrain target, so every existing
// invocation keeps its exact previous behaviour; the args exist because the same one-line
// BullMQ add is needed for other queues (first real use: re-running unified-ranker after an
// AF-20260917-20 timeout left unified_recommendations with zero rows for the session).
//
// The job NAME matters, not just the queue: unified-ranker's worker names its scheduled run
// 'unified-ranker-daily', and only that name queues a bounded make-up run on failure
// (queues.ts). Passing a different name here therefore cannot recurse.
const QUEUE_NAME = process.argv[2] || 'ml-weekly-retrain';
const JOB_NAME = process.argv[3] || 'ml-weekly-retrain-manual';

async function run() {
  const q = new Queue(QUEUE_NAME, { connection: REDIS });
  const job = await q.add(JOB_NAME, {}, { jobId: 'manual-' + Date.now() });
  console.log(`Job added: queue=${QUEUE_NAME} name=${JOB_NAME} id=${job.id}`);
  await q.close();
}
run().catch(console.error);
