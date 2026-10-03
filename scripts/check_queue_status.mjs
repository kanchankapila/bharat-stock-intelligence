import { Queue } from 'bullmq';
import 'dotenv/config';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

const queues = [
  'stock-scoring',
  'quant-scoring',
  'confluence-compute',
  'outcome-resolver',
  'unified-ranker',
  'recommendations-digest',
  'data-quality-daily',
];

async function main() {
  for (const qName of queues) {
    const q = new Queue(qName, { connection: REDIS });
    try {
      const counts = await q.getJobCounts('active', 'waiting', 'delayed', 'failed');
      console.log(`${qName.padEnd(25)}: active=${counts.active} waiting=${counts.waiting} delayed=${counts.delayed} failed=${counts.failed}`);
    } catch (err) {
      console.error(`${qName}: ${err.message}`);
    } finally {
      await q.close();
    }
  }
}

main().catch(console.error);
