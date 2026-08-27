/**
 * Schedule metadata for the pure-BullMQ queues NOT already covered by
 * MONITOR_SCRIPTS (monitor.router.ts) — that registry's queueName field
 * covers ohlcv-backfill, screener-performance, company-profiles-sync
 * already, with real DB-freshness checks. Do not duplicate those here.
 *
 * outcome-resolver, ml-daily-ops, ml-weekly-retrain and trendlyne-ratios-monthly
 * are NOT themselves MONITOR_SCRIPTS ids (only their downstream effects —
 * outcome-resolver-5d/15d, ml-ensemble-score, ml-ensemble-train,
 * strategy-optimizer, financial-ratios, working-capital, etc. — are), so
 * without an entry here they fell through to getStaleJobs()'s flat 26h
 * threshold, which doesn't know some are Mon-Fri-only and others are weekly —
 * false-alarming every weekend (or every day of the week, for weekly jobs).
 * Listed here instead so lateness is judged against their real cron schedule
 * (see queues.ts's `repeat: { pattern }` for each).
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
  /**
   * Overrides cronPattern for getLateJobs()'s deadline math ONLY -- cronPattern itself is left
   * untouched so it keeps mirroring the real `repeat: { pattern }` registration byte-for-byte
   * (jobRegistryCronMirror.test.ts pins that). For a market-hours job whose cron includes a
   * generous post-close tail (every 15 minutes across hours 3 through 10 UTC, which fires
   * through 10:45 UTC as a safety margin even though the runtime isMarketOpen() gate correctly
   * closes it at 10:00 UTC and no-ops the rest), the literal LAST cron slot is not when the job
   * was actually last expected to do real work -- so a deadline computed from it is guaranteed
   * to have passed by the time the 18:45 UTC digest runs, every single trading day, regardless
   * of whether the job ran fine. Mirrors MONITOR_SCRIPTS' `technical-signals` entry
   * (monitorScripts.ts), which already solves the identical problem via computeCronLateness()'s
   * multi-pattern support.
   */
  lateDeadlineCronPatterns?: string[];
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
  { jobName: 'stock-scoring', label: 'Stock Scoring Sync', cronPattern: '0 15 * * 1-5', graceMinutes: 60, critical: true },
  // Screener syncs moved 2026-07-31 from the 11:00-11:35 PM IST block to 6:00-6:40 PM IST so
  // they run AHEAD of every consumer (ml-daily-ops 7:30 PM, stock-scoring 10:30 PM) instead of
  // hours behind them. Keep these three in lockstep with queues.ts — a stale cronPattern here
  // produces phantom "late" alerts against a deadline the job never had.
  // graceMinutes 60 -> 105: the queue's own Worker lockDuration is 90min (screeners.jobs.ts's
  // 'mc-sync' registration) -- 60min grace flagged 'late' (critical: true, real Telegram
  // alert) on any run that took longer than an hour, which its own declared 90min budget
  // says is normal. Found 2026-08-03 while building the graceMinutes mirror-consistency test.
  { jobName: 'mc-screener-sync', label: 'MoneyControl Screener Sync', cronPattern: '50 12 * * 1-5', graceMinutes: 105, critical: true },
  { jobName: 'etnow-screener-sync', label: 'ETNow Screener Sync', cronPattern: '10 13 * * 1-5', graceMinutes: 90, critical: true },
  { jobName: 'et-marketstats-sync', label: 'ET Marketstats Screener Sync', cronPattern: '30 12 * * 1-5', graceMinutes: 90, critical: false },
  // New 2026-08-04 (job-timing audit): Trendlyne screener-stock membership previously had NO
  // dedicated schedule of its own — it only synced as a side effect of quant-eod-sync (10:00 PM
  // IST) and stock-scoring's syncAndScore() (10:30 PM IST), both of which ALSO redundantly
  // re-synced MC/ETnow a 2nd/3rd time that same evening. Given its own slot alongside its
  // mc/etnow/et-marketstats siblings instead; graceMinutes matches mc-screener-sync's corrected
  // value (90min lockDuration + headroom), critical:true since it feeds
  // screener_features_fetcher.py's screener_momentum_score same as MC/ETnow.
  { jobName: 'trendlyne-screener-sync', label: 'Trendlyne Screener Sync', cronPattern: '40 12 * * 1-5', graceMinutes: 105, critical: true },
  { jobName: 'nse-sync', label: 'NSE Master List Sync', cronPattern: '0 2 * * 6', graceMinutes: 120, critical: false },
  // AF-20260828-21: closes the Mon-Thu is_nifty50/.../nifty_tier coverage gap left by
  // nse-sync's own weekly (Saturday-only) run of the same fetcher -- see sync.jobs.ts's
  // processIndexMembership() comment for the full root-cause. critical:false, same as
  // nse-sync: a supplementary ML feature, not a live-blended score input.
  { jobName: 'index-membership', label: 'Index Membership Daily', cronPattern: '35 15 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'fundamentals-sync', label: 'Fundamentals Sync', cronPattern: '0 3 * * 6', graceMinutes: 120, critical: false },
  { jobName: 'quant-scoring', label: 'Quant Score Engine', cronPattern: '20 15 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'signal-outcomes', label: 'Signal Outcome Tracker', cronPattern: '30 3 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'news-sentiment', label: 'News Sentiment Refresh', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: true },
  // Registered with `every: 15min` (24/7) but gated to market hours at runtime, where it returns
  // { skipped: true } — same shape as its intraday-fetcher / market-regime-refresh /
  // live-screener-collect siblings below, so it takes the identical deadline patterns. Needed as
  // of the everyMs fix in jobHeartbeat.ts: until then this entry could never report late at all,
  // so the absence of deadlines here was invisible rather than correct.
  { jobName: 'trendlyne-intraday', label: 'Trendlyne Intraday Scan', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: false,
    lateDeadlineCronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'] },
  { jobName: 'intraday-fetcher', label: 'Intraday Bar Fetcher', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false,
    lateDeadlineCronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'] },
  // 2026-08-13: gdeltService.ts existed with a working fetcher/parser but was never scheduled
  // anywhere -- wired into queues.ts (QUEUE_GDELT_SENTIMENT) the same day. Daily, no weekday
  // restriction (GDELT indexes news on weekends/holidays too), 90min grace for the ~13min
  // rate-limited run plus headroom.
  { jobName: 'gdelt-sentiment', label: 'GDELT News Sentiment Backfill', cronPattern: '0 19 * * *', graceMinutes: 90, critical: false },
  { jobName: 'research-premarket', label: 'Premarket Research', cronPattern: '0 3 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'research-postclose', label: 'Postclose Research', cronPattern: '45 10 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-macro-fetch', label: 'DL Macro Fetcher', cronPattern: '30 2 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'preopen-snapshot', label: 'Preopen Snapshot', cronPattern: '40 3 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'market-regime-refresh', label: 'Market Regime Refresh (intraday)', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false,
    lateDeadlineCronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'] },
  { jobName: 'intraday-ranker', label: 'Intraday Ranker (regime + ranking)', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false,
    lateDeadlineCronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'] },
  { jobName: 'closed-day-early-batch', label: 'Closed-Day Early Batch (holiday pipeline)', cronPattern: '40 1 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-retrain-emergency', label: 'DL Emergency Retrain (drift-triggered)', graceMinutes: 0, critical: false },
  // everyMs is its real cadence (30 min, 24/7) and stays the mirror of the registration, but the
  // job only does WORK inside isConfluenceComputeWindow() -- IST hours 6-7 and 17-23 -- and now
  // returns { skipped: true } outside it rather than faking a success. Without these deadlines the
  // raw 30-min cadence would flag this critical job 'late' through every skip window (~9h a day),
  // which is the phantom-alert failure mode the mc-screener-sync/quant-eod-sync grace bumps above
  // were written for. Patterns are the window's real 30-min slots in UTC (IST minus 5:30):
  // IST 06:00-07:30 -> UTC 00:30-02:00, IST 17:00-23:30 -> UTC 11:30-18:00.
  { jobName: 'confluence-compute', label: 'Confluence Engine', everyMs: 30 * 60 * 1000, graceMinutes: 45, critical: true,
    lateDeadlineCronPatterns: ['30 0 * * *', '0,30 1 * * *', '0 2 * * *', '30 11 * * *', '*/30 12-17 * * *', '0 18 * * *'] },
  { jobName: 'confluence-outcomes', label: 'Confluence Outcomes', cronPattern: '40 15 * * 1-5', graceMinutes: 60, critical: false },
  // Takes one bounded slice of one trendlyne.com fetcher per run (see trendlyneWeekly.jobs.ts).
  // critical:false — a single missed slice is made up by the next one; only a sustained outage
  // matters, which the 60min grace against a 20min cadence is what catches.
  { jobName: 'trendlyne-catchup', label: 'Trendlyne Catch-up Slice', cronPattern: '*/20 * * * *', graceMinutes: 60, critical: false },
  { jobName: 'agent-data-scientist', label: 'Agent: Data Scientist', cronPattern: '30 1 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-strategist', label: 'Agent: Strategist', cronPattern: '20 3 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-auditor', label: 'Agent: Auditor', cronPattern: '0 11 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-optimizer', label: 'Agent: Optimizer', cronPattern: '0 12 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'unified-ranker', label: 'Unified Daily Ranker', cronPattern: '0 17 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'live-screener-collect', label: 'Live Screener Poller', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 30, critical: false,
    lateDeadlineCronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'] },
  // graceMinutes 45 -> 360: the processor's own comment says "5.5h backstop... the last
  // three runs took 153/157/239 min" (queues.ts's withJobTimeout('quant-eod-sync', 5.5h,...)),
  // and the Worker's own lockDuration is 120min -- 45min grace flagged 'late' on every run
  // that took over 45 minutes, which per the job's own documented real runs is EVERY run.
  // Found 2026-08-03 while building the graceMinutes mirror-consistency test.
  { jobName: 'quant-eod-sync', label: 'Quant EOD Sync', cronPattern: '30 16 * * 1-5', graceMinutes: 360, critical: false },
  { jobName: 'outcome-resolver', label: 'Outcome Resolver', cronPattern: '0 4 * * 1-5', graceMinutes: 45, critical: true },
  // Listed here from the day the job was created (2026-08-16), deliberately: the ChromaDB index
  // this refreshes sat frozen at its 2026-06-20 initial ingest for ~8 weeks precisely because
  // nothing watched it. graceMinutes 90 covers a slow CPU embedding pass (lockDuration is 30min
  // per run, x2 attempts, plus catch-up stagger). Keep cronPattern identical to
  // operations.jobs.ts's `repeat: { pattern }` — a drifted mirror is its own recurring bug.
  { jobName: 'chatbot-reingest', label: 'Chatbot RAG Re-ingest', cronPattern: '0 20 * * *', graceMinutes: 90, critical: false },
  // graceMinutes 60 -> 270: the Worker's own lockDuration is 4h (240min, "covers the full
  // daily ops run" per queues.ts's own comment) and processMlDailyOps is wrapped in
  // withJobTimeout(..., 3.5h) -- 60min grace flagged 'late' (critical: true, real Telegram
  // alert) on every run past an hour, which is the norm for an ~11-15-step chain the source
  // itself budgets up to 4h for. CLAUDE.md's own job-schedule-review note independently
  // measured this job's real runtime at ~4.4h (and a separate note recorded a run completing
  // at 01:23 IST off a 19:30 IST start, ~5h53m) -- both exceed even the corrected 270min here,
  // so this may need revisiting once the pipeline-growth concern those notes already flag is
  // addressed; 270min is the source-DECLARED ceiling (240min) plus a modest margin, not a
  // number stretched to match those anecdotal figures. Found 2026-08-03 while building the
  // graceMinutes mirror-consistency test.
  { jobName: 'ml-daily-ops', label: 'ML Daily Ops', cronPattern: '20 13 * * 1-5', graceMinutes: 270, critical: true },
  { jobName: 'trendlyne-daily-fetch', label: 'Trendlyne Daily Metrics Fetch', cronPattern: '30 4 * * 1-5', graceMinutes: 60, critical: false },
  // graceMinutes 180 -> 390: the Worker's own lockDuration is 6h (360min) -- 180min grace
  // flagged 'late' on any run past 3 hours, well inside what the job's own declared budget
  // (which includes a 90min ml_ensemble.py --train --tune --score step alone) allows.
  // Found 2026-08-03 while building the graceMinutes mirror-consistency test.
  { jobName: 'ml-weekly-retrain', label: 'ML Weekly Retrain', cronPattern: '0 5 * * 6', graceMinutes: 390, critical: false },
  // Queue id kept as '-monthly' deliberately: renaming a BullMQ queue would orphan its
  // repeatable-job key and monitor state. As of 2026-07-31 the ratios step is WEEKLY (every
  // Saturday); only working_capital + mf_stock_holdings remain first-Saturday-only.
  // graceMinutes 60 -> 150: the weekly ratios leg alone is budgeted 60 min, and on a first
  // Saturday it is followed by working_capital (60) + mf_stock_holdings (30).
  // graceMinutes 150 -> 210: a first-Saturday run now chains 4 steps (financial_ratios 60min +
  // working_capital 60min + mf_stock_holdings 30min + mc_stockvitals_history 60min = up to
  // 210min worst case), not 3 -- same reasoning as the prior 150min bump when mf_stock_holdings
  // was added (see CLAUDE.md's session notes on this job's timeout history).
  // graceMinutes 210 -> 270: 2026-08-07 added 3 more WEEKLY (every-Saturday, not just first-
  // Saturday) steps -- mc_corporate_actions_fetcher.py (30min budget) + ohlcv_adjust.py --persist
  // (20min budget, measured ~3.3min real) + ohlcv_adjust.py --cross-validate --persist (10min
  // budget, measured ~9s real) = 60min more worst-case, same additive convention as every prior
  // bump on this entry.
  // cronPattern 30 12 * * 0 -> 30 0 * * 6 (2026-08-09): moved to 06:00 IST Saturday (early morning, ahead of the 07:30-11:30+ IST Saturday cluster)
  { jobName: 'trendlyne-ratios-monthly', label: 'ET Ratios (weekly) + Corporate Actions/OHLCV Adjust (weekly) + Working Capital/MF Holdings/MC StockVitals History (monthly)', cronPattern: '30 0 * * 6', graceMinutes: 270, critical: false },
  { jobName: 'dl-feature-refresh', label: 'DL Feature Refresh', cronPattern: '30 11 * * 1-5', graceMinutes: 90, critical: false },

  // ml-daily-ops (cron '20 13 * * 1-5', see queues.ts processMlDailyOps) writes each of its
  // StepTracker sub-steps as its OWN job_heartbeat row (see jobSteps.ts), so without entries
  // here they fell through to the flat 26h threshold too — same false-alarm-every-weekend bug
  // as the parent job had before this file existed (found 2026-07-19: dl-feature-refresh,
  // drift-detector, ml-ensemble-incremental were spamming STALE every Sat/Sun despite running
  // fine on their last scheduled weekday). Grace is wider than the parent's 60min since these
  // run partway through an ~11-step chain that can itself run late via addJobWithCatchup.
  { jobName: 'fii-dii-fetcher', label: 'ML Daily Ops: FII/DII Fetcher', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'fii-dii-history', label: 'ML Daily Ops: FII/DII Deep History', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'tickertape-deals', label: 'ML Daily Ops: Bulk/Block Deals (% of float)', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'finbert-scorer', label: 'ML Daily Ops: FinBERT Scorer', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'outcome-resolver-5d', label: 'ML Daily Ops: Outcome Resolver 5d', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'outcome-resolver-15d', label: 'ML Daily Ops: Outcome Resolver 15d', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'performance-tracker', label: 'ML Daily Ops: Performance Tracker', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  // critical: if this silently stops running, the enrichment half of the feature matrix goes
  // sparse again and every model trains on technicals alone without anything erroring.
  { jobName: 'densify-feature-matrix', label: 'ML Daily Ops: Densify Feature Matrix', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: true },
  // critical: this is the only survivorship-free record of the traded universe. Every day it
  // misses is a day whose delisted names are gone for good from nse_universe_history.
  { jobName: 'nse-bhavcopy-fetcher', label: 'ML Daily Ops: NSE Bhavcopy (PIT universe)', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: true },
  { jobName: 'ml-ensemble-incremental', label: 'ML Daily Ops: Ensemble Incremental', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'ml-ensemble-score', label: 'ML Daily Ops: Ensemble Score', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'drift-detector', label: 'ML Daily Ops: Drift Detector', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'reward-engine', label: 'ML Daily Ops: Reward Engine', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'rl-agent-update', label: 'ML Daily Ops: RL Agent Update', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'signal-type-stats', label: 'ML Daily Ops: Signal Type Stats', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },
  { jobName: 'news-symbol-link', label: 'ML Daily Ops: News Symbol Link', cronPattern: '20 13 * * 1-5', graceMinutes: 280, critical: false },

  // Same story for ml-weekly-retrain's (cron '0 5 * * 6') StepTracker sub-steps.
  { jobName: 'ml-ensemble-train', label: 'ML Weekly Retrain: Ensemble Train', cronPattern: '0 5 * * 6', graceMinutes: 400, critical: false },
  { jobName: 'strategy-optimizer', label: 'ML Weekly Retrain: Strategy Optimizer', cronPattern: '0 5 * * 6', graceMinutes: 400, critical: false },
  // These three T.run() siblings (queues.ts) were missing from this list entirely, so they fell
  // through to getStaleJobs()'s flat 26h legacy threshold instead of this file's cron-aware
  // getLateJobs() -- false-positiving "STALE" every week between Saturday runs (found live
  // 2026-08-21: backtest-optimizer logged STALE at ~77-83h while job_heartbeat showed
  // last_status='success' from the prior Saturday, no real failure).
  { jobName: 'exit-policy-train', label: 'ML Weekly Retrain: Exit Policy Train', cronPattern: '0 5 * * 6', graceMinutes: 400, critical: false },
  { jobName: 'cs-ranker-train', label: 'ML Weekly Retrain: CS Ranker Train', cronPattern: '0 5 * * 6', graceMinutes: 400, critical: false },
  { jobName: 'backtest-optimizer', label: 'ML Weekly Retrain: Backtest Optimizer', cronPattern: '0 5 * * 6', graceMinutes: 400, critical: false },

  // job-digest (queues.ts '20 17 * * *', runs all 7 days)
  { jobName: 'job-digest', label: 'Daily Job Digest (Telegram)', cronPattern: '20 17 * * *', graceMinutes: 60, critical: false },

  // Stock-recommendation digest. Runs after unified-ranker ('0 17 * * 1-5' = 22:30 IST) so it
  // reads the freshly-built ranking. Critical: this is the user-facing output of the whole
  // pipeline, and its predecessor (the websocketService confidence>=85 alert) went silent for
  // ~2 weeks without anything noticing, which is exactly what a heartbeat entry prevents.
  { jobName: 'recommendations-digest', label: 'Daily Stock Recommendations (Telegram)', cronPattern: '10 17 * * 1-5', graceMinutes: 90, critical: true },

  // Formal daily wrapper around dataQualityChecks.ts's 25-check suite (2026-08-01).
  { jobName: 'data-quality-daily', label: 'Daily Data-Integrity Report (Telegram)', cronPattern: '30 17 * * *', graceMinutes: 90, critical: true },
];
