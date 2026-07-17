// One-off ops script: pause/resume every BullMQ queue in the app without killing
// the running node/python processes. Usage: node queue-control.mjs pause|resume|status
import { Queue } from 'bullmq';
import 'dotenv/config';

const REDIS = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
};

const QUEUE_NAMES = [
  'stock-refresh', 'ai-signals', 'stock-scoring', 'mc-screener-sync',
  'etnow-screener-sync', 'nse-sync', 'fundamentals-sync', 'quant-scoring',
  'technical-signals', 'signal-outcomes', 'news-sentiment', 'trendlyne-intraday',
  'outcome-resolver', 'ml-daily-ops', 'ml-weekly-retrain', 'intraday-fetcher',
  'research-premarket', 'research-postclose', 'dl-macro-fetch', 'dl-feature-refresh',
  'dl-inference', 'dl-regime-update', 'dl-retrain-weekly', 'dl-retrain-emergency',
  'ohlcv-backfill', 'confluence-compute', 'confluence-outcomes', 'screener-performance',
  'agent-data-scientist', 'agent-strategist', 'agent-auditor', 'agent-optimizer',
  'unified-ranker', 'company-profiles-sync', 'quant-eod-sync', 'trendlyne-daily-fetch',
  'trendlyne-midweek', 'trendlyne-ratios-monthly', 'tickertape-scorecard',
  'live-screener-collect', 'trendlyne-checklist-cycle', 'preopen-snapshot',
  'market-regime-refresh', 'closed-day-early-batch', 'job-digest',
];

const action = process.argv[2];
if (!['pause', 'resume', 'status'].includes(action)) {
  console.error('Usage: node queue-control.mjs pause|resume|status');
  process.exit(1);
}

const results = [];
for (const name of QUEUE_NAMES) {
  const q = new Queue(name, { connection: REDIS });
  try {
    if (action === 'pause') {
      await q.pause();
      results.push([name, 'paused']);
    } else if (action === 'resume') {
      await q.resume();
      results.push([name, 'resumed']);
    } else {
      const paused = await q.isPaused();
      results.push([name, paused ? 'PAUSED' : 'running']);
    }
  } catch (e) {
    results.push([name, `ERROR: ${e.message}`]);
  } finally {
    await q.close();
  }
}

for (const [name, state] of results) console.log(`${name.padEnd(28)} ${state}`);
process.exit(0);
