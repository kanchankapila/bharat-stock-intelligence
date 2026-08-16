import { Queue } from 'bullmq';
import 'dotenv/config';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

async function run() {
  const q = new Queue('ml-weekly-retrain', { connection: REDIS });
  const job = await q.add('ml-weekly-retrain-manual', {}, { jobId: 'manual-' + Date.now() });
  console.log(`Job added: ${job.id}`);
  await q.close();
}
run().catch(console.error);
