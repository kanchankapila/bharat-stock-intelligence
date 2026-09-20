/**
 * 2026-09-20 deploy-verification probe.
 *
 * Mode 1 (default)  -- node tsx scratch_verify/md_fix_deploy_ops.ts check
 *   Pre-restart safety per the AF-20260910-04 protocol: scan every BullMQ queue's
 *   `bull:<queue>:active` list and report non-empty ones. Restart is only safe when all
 *   are empty (otherwise reclaimStaleActiveJobs will fail+requeue the run as an orphan).
 *
 * Mode 2            -- node tsx scratch_verify/md_fix_deploy_ops.ts trigger-profile-sync
 *   Post-restart make-up: add a one-off job to the company-profiles-sync queue so the
 *   freshly-restarted server's worker runs processCompanyProfilesSync under the fixed
 *   description-sourcing code (AF-20260920-01) instead of waiting for Monday 21:00 IST.
 *
 * Reads .env for REDIS_HOST/PORT/PASSWORD exactly like the server does.
 */
import fs from 'fs';
import path from 'path';

(function loadEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
})();

import Redis from 'ioredis';

const conn = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

async function check(): Promise<void> {
  await conn.connect();
  let cursor = '0';
  const busy: Array<{ queue: string; active: number }> = [];
  do {
    const [next, keys] = await conn.scan(cursor, 'MATCH', 'bull:*:active', 'COUNT', 500);
    cursor = next;
    for (const k of keys) {
      const n = await conn.llen(k);
      if (n > 0) busy.push({ queue: k.replace(/^bull:/, '').replace(/:active$/, ''), active: n });
    }
  } while (cursor !== '0');
  if (busy.length) {
    console.log('ACTIVE JOBS PRESENT — restart NOT safe now:');
    for (const b of busy) console.log(`  ${b.queue}: ${b.active} active`);
    process.exitCode = 1;
  } else {
    console.log('All BullMQ queues idle (0 active jobs) — restart safe.');
  }
}

async function triggerProfileSync(): Promise<void> {
  // BullMQ jobs must be added through the bullmq client (raw LPUSH would not build the
  // job hashes/streams the worker'sscripts consume). Same connection shape as queues.ts.
  const { Queue } = await import('bullmq');
  const queue = new Queue('company-profiles-sync', {
    connection: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
    } as any,
  });
  const job = await queue.add('company-profiles-sync', { reason: 'manual-makeup: post-deploy verification of AF-20260920-01 fix (AXISBANK/CHALET)' }, {
    // Do NOT let this become the repeatable's replacement — it is a one-off; removeOnComplete
    // keeps the queue tidy after the worker records the run in job_run_history/heartbeat.
    removeOnComplete: { age: 24 * 3600, count: 50 },
    removeOnFail: { age: 24 * 3600 },
    attempts: 1,
  });
  console.log(`queued company-profiles-sync make-up: job id=${job.id ?? '?'}`);
  await queue.close();
}

async function main() {
  const mode = process.argv[2] || 'check';
  try {
    if (mode === 'check') await check();
    else if (mode === 'trigger-profile-sync') await triggerProfileSync();
    else {
      console.error(`unknown mode: ${mode}`);
      process.exitCode = 1;
    }
  } finally {
    conn.disconnect();
  }
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });

