/**
 * What is every BullMQ queue doing right now, and what jobName does each accept?
 *
 * Exists because the queue -> jobName map has no single static source: registrations live
 * across queues.ts and jobs/*.jobs.ts, and a job enqueued under the wrong queue name is
 * accepted silently by BullMQ and then never runs (live 2026-09-05: ohlcv-gap-fill sat in
 * 'waiting' for 30 minutes on a queue with no worker, and the sweep credited it with 282,823
 * rows another job had written). Reading Redis answers it authoritatively.
 *
 * Usage: tsx scripts/queueState.ts [--busy]
 */
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

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
const connection = {
  host: env.REDIS_HOST || '127.0.0.1',
  port: Number(env.REDIS_PORT || 6379),
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null as any,
};
const busyOnly = process.argv.includes('--busy');

(async () => {
  const r = new Redis(connection);
  const names = [...new Set((await r.keys('bull:*:meta')).map(k => k.split(':')[1]))].sort();
  for (const n of names) {
    const q = new Queue(n, { connection });
    const c = await q.getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed');
    const workers = (await q.getWorkers()).length;
    const busy = c.active || c.waiting || c.delayed;
    if (!busyOnly || busy) {
      console.log(
        `${n.padEnd(32)} workers=${workers} active=${c.active} wait=${c.waiting} delayed=${c.delayed} failed=${c.failed}`,
      );
      for (const j of await q.getJobs(['active'], 0, 5)) {
        const mins = j.processedOn ? Math.round((Date.now() - j.processedOn) / 60000) : 0;
        console.log(`      ACTIVE ${j.name} (id=${j.id}) running ${mins}m`);
      }
    }
    await q.close();
  }
  await r.quit();
})();
