import { Queue } from 'bullmq';
import 'dotenv/config';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

async function run() {
  const q = new Queue('ml-weekly-retrain', { connection: REDIS });
  
  const active = await q.getActive();
  const waiting = await q.getWaiting();
  const completed = await q.getCompleted();
  const failed = await q.getFailed();
  const delayed = await q.getDelayed();

  console.log(`Active: ${active.length}`);
  console.log(`Waiting: ${waiting.length}`);
  console.log(`Completed: ${completed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Delayed: ${delayed.length}`);
  
  if (active.length > 0) {
    console.log('Active jobs:');
    active.forEach(j => console.log(`- ${j.id} (processed for ${j.processedOn ? new Date(j.processedOn).toISOString() : 'N/A'})`));
  }
  
  await q.close();
}
run().catch(console.error);
