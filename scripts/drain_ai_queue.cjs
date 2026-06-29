// Drain the ai-signals queue (remove waiting + delayed jobs) so the stale whole-universe
// backlog does not process. Active job (if any) is left to finish.
const fs = require('fs');
const path = require('path');
const { Queue } = require('bullmq');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const get = (k, d) => { const m = env.match(new RegExp(`^${k}=(.+)$`, 'm')); return m ? m[1].trim() : d; };
const connection = {
  host: get('REDIS_HOST', 'localhost'),
  port: Number(get('REDIS_PORT', '6379')),
  password: get('REDIS_PASSWORD', '') || undefined,
};

(async () => {
  const q = new Queue('ai-signals', { connection });
  const before = await q.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  console.log('before:', JSON.stringify(before));
  await q.drain(true); // remove waiting + delayed
  const after = await q.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  console.log('after :', JSON.stringify(after));
  await q.close();
})();
