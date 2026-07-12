/**
 * Schedule metadata for the pure-BullMQ queues NOT already covered by
 * MONITOR_SCRIPTS (monitor.router.ts) — that registry's queueName field
 * covers technical-signals, ml-weekly-retrain, ohlcv-backfill,
 * screener-performance, company-profiles-sync already, with real DB-freshness
 * checks. Do not duplicate those here.
 *
 * outcome-resolver and ml-daily-ops themselves are NOT MONITOR_SCRIPTS ids
 * (only their downstream effects — outcome-resolver-5d/15d, ml-ensemble-score,
 * etc. — are), so without an entry here they fell through to getStaleJobs()'s
 * flat 26h threshold, which doesn't know they're Mon-Fri-only and false-alarmed
 * every weekend. Listed here instead so lateness is judged against their real
 * cron schedule (see queues.ts's `repeat: { pattern }` for each).
 *
 * cronPattern values are copied verbatim from queues.ts `repeat: { pattern }`
 * configs and MUST be evaluated with `{ tz: 'Etc/UTC' }` (see Global Constraints
 * in the implementation plan) — addJobWithCatchup already forces that tz when
 * registering the repeatable job, so this must match to compute the same
 * "expected fire time".
 */
export interface JobScheduleEntry {
  jobName: string;
  label: string;
  cronPattern?: string;   // undefined + everyMs undefined = event-driven, no lateness check
  everyMs?: number;
  graceMinutes: number;
  critical: boolean;
}

// ── Market-hours policy (IST 09:15–15:30 = UTC 03:45–10:00, Mon–Fri, minus holidays) ──
// INTRADAY jobs run ONLY during market hours and no-op on holidays via an isMarketOpen() guard
// (holiday-aware, see marketStatusService): stock-refresh (live prices), intraday-fetcher,
// market-regime-refresh + intraday-ranker (the intraday pipeline), live-screener-collect.
// POSITIONAL/heavy jobs run OFF-HOURS (22:30 IST+ / weekends): stock-scoring, quant-scoring,
// mc/etnow screener syncs, fundamentals-sync, nse-sync, ml-daily-ops, outcome-resolver, unified-ranker.
// confluence-compute is positional but 24/7 by cadence — it SKIPS market hours (see queues.ts) so it
// doesn't compete with intraday work. news-sentiment stays 24/7 on purpose: breaking news is
// intraday-relevant, so pausing it would degrade intraday awareness.
export const JOB_REGISTRY: JobScheduleEntry[] = [
  { jobName: 'stock-refresh', label: 'Stock Price Refresh', cronPattern: '30 10 * * 1-5', graceMinutes: 30, critical: true },
  { jobName: 'ai-signals', label: 'AI Signal Analyzer', graceMinutes: 0, critical: false },
  { jobName: 'stock-scoring', label: 'Stock Scoring Sync', cronPattern: '0 17 * * 1-5', graceMinutes: 60, critical: true },
  { jobName: 'mc-screener-sync', label: 'MoneyControl Screener Sync', cronPattern: '30 17 * * 1-5', graceMinutes: 60, critical: true },
  { jobName: 'etnow-screener-sync', label: 'ETNow Screener Sync', cronPattern: '0 18 * * 1-5', graceMinutes: 90, critical: true },
  { jobName: 'nse-sync', label: 'NSE Master List Sync', cronPattern: '0 2 * * 0', graceMinutes: 120, critical: false },
  { jobName: 'fundamentals-sync', label: 'Fundamentals Sync', cronPattern: '0 22 * * 0', graceMinutes: 120, critical: false },
  { jobName: 'quant-scoring', label: 'Quant Score Engine', cronPattern: '30 17 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'signal-outcomes', label: 'Signal Outcome Tracker', cronPattern: '30 3 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'news-sentiment', label: 'News Sentiment Refresh', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: true },
  { jobName: 'trendlyne-intraday', label: 'Trendlyne Intraday Scan', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: false },
  { jobName: 'intraday-fetcher', label: 'Intraday Bar Fetcher', cronPattern: '*/30 3-10 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'research-premarket', label: 'Premarket Research', cronPattern: '0 3 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'research-postclose', label: 'Postclose Research', cronPattern: '45 10 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-macro-fetch', label: 'DL Macro Fetcher', cronPattern: '30 2 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'preopen-snapshot', label: 'Preopen Snapshot', cronPattern: '40 3 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'market-regime-refresh', label: 'Market Regime Refresh (intraday)', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'intraday-ranker', label: 'Intraday Ranker (regime + ranking)', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'dl-retrain-emergency', label: 'DL Emergency Retrain (drift-triggered)', graceMinutes: 0, critical: false },
  { jobName: 'confluence-compute', label: 'Confluence Engine', everyMs: 30 * 60 * 1000, graceMinutes: 45, critical: true },
  { jobName: 'confluence-outcomes', label: 'Confluence Outcomes', cronPattern: '30 17 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-data-scientist', label: 'Agent: Data Scientist', cronPattern: '30 1 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-strategist', label: 'Agent: Strategist', cronPattern: '0 3 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-auditor', label: 'Agent: Auditor', cronPattern: '0 11 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-optimizer', label: 'Agent: Optimizer', cronPattern: '0 12 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'unified-ranker', label: 'Unified Daily Ranker', cronPattern: '15 10 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'live-screener-collect', label: 'Live Screener Poller', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 30, critical: false },
  { jobName: 'quant-eod-sync', label: 'Quant EOD Sync', cronPattern: '30 16 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'outcome-resolver', label: 'Outcome Resolver', cronPattern: '0 4 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'ml-daily-ops', label: 'ML Daily Ops', cronPattern: '0 14 * * 1-5', graceMinutes: 60, critical: true },
  { jobName: 'trendlyne-daily-fetch', label: 'Trendlyne Daily Metrics Fetch', cronPattern: '30 4 * * 1-5', graceMinutes: 60, critical: false },
];
