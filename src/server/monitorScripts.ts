/**
 * MONITOR_SCRIPTS registry — the ~20 Python-engine / queue entries tracked via real
 * DB-freshness checks (see monitor.router.ts's getSystemStatus/getLastRunAt). Lives in
 * its own module (not monitor.router.ts) so jobHeartbeat.ts can import the id list
 * without pulling in monitor.router.ts's queues.ts/trpc dependency chain — that chain
 * loops back into jobHeartbeat.ts via queues.ts -> monitoringService.ts -> recordHeartbeat.
 */
export const MONITOR_SCRIPTS = [
  {
    id: 'technical-scan',
    label: 'Technical Signal Scan',
    category: 'Signals',
    critical: true,
    description: 'Scans 2000+ stocks for EMA, RSI, BB, divergence patterns',
    schedule: 'Every 30 min, 8:30 AM-4:00 PM IST weekdays',
    pyScript: null,          // queue-based
    queueName: 'technical-signals',
    // Was 1h when the job ran unrestricted 24/7. Now market-hours-gated (queues.ts) like
    // outcome-resolver-5d/performance-tracker/fii-dii-fetcher below -- 1h would false-alarm
    // 'stale' every single evening/weekend. staleLimitHours is only the FALLBACK now (used if
    // cronPatterns is ever absent); the real guard is cronPatterns below.
    //
    // A bare 26h number here (the historical/pre-cronPatterns state, restored 2026-08-03 while
    // auditing job/Telegram health -- this entry had drifted to having NO cronPatterns despite
    // its own comment claiming it "matches siblings' convention") does NOT tolerate the real
    // gap: the underlying job (queues.ts technicalSignalsQueue, '*/30 3-10 * * 1-5') is
    // Mon-Fri-only, so the true gap from Friday's last ~4pm IST run to Monday's first ~8:30am
    // IST run is ~64.5h, not "overnight" -- 26h flagged 'stale' (critical: true, real Telegram
    // alert) for roughly 38 hours every single weekend. cronPatterns makes this cron-aware like
    // its true siblings (fii-dii-fetcher etc.) instead of relying on the flat threshold.
    staleLimitHours: 26,
    cronPatterns: ['*/30 3-10 * * 1-5'],
    graceMinutes: 45,
  },
  {
    id: 'outcome-resolver-5d',
    label: 'Outcome Resolver (5D)',
    category: 'ML',
    critical: true,
    description: 'Labels signal WIN/LOSS against OHLCV — 5-day horizon',
    schedule: 'Daily 9:30 AM',
    pyScript: 'outcome_resolver.py --horizon 5',
    queueName: 'outcome-resolver',
    staleLimitHours: 26,
    // Actually touched twice a day: the 9:30am outcome-resolver queue AND again inside the
    // 6:50pm ml-daily-ops batch (queues.ts processMlDailyOps). Cron-aware lateness takes the
    // more recent of the two expected fire times instead of a flat hours threshold, so a
    // mid-day check (before either run) doesn't false-flag "stale" off Friday's success.
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['0 4 * * 1-5', '20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'outcome-resolver-15d',
    label: 'Outcome Resolver (15D)',
    category: 'ML',
    critical: false,
    description: 'Labels signal WIN/LOSS against OHLCV — 15-day horizon',
    schedule: 'Daily 9:30 AM',
    pyScript: 'outcome_resolver.py --horizon 15',
    queueName: 'outcome-resolver',
    staleLimitHours: 26,
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['0 4 * * 1-5', '20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'performance-tracker',
    label: 'Performance Tracker',
    category: 'ML',
    critical: true,
    description: 'Computes win rate, alpha vs Nifty, Sharpe — segmented by signal type / regime / sector',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: 'performance_tracker.py --horizon 5',
    queueName: null,
    staleLimitHours: 26,
    // Runs as a step inside ml-daily-ops (20 13 * * 1-5), same as sibling entries below
    // (fii-dii-fetcher, finbert-scorer, ml-ensemble-score, reward-engine, rl-agent-update,
    // signal-type-stats) -- but unlike them had NO cronPatterns, so the flat 26h
    // staleLimitHours false-flagged 'stale' (critical: true, real Telegram alert) every
    // Saturday off Friday's success (it also runs inside ml-weekly-retrain on Sunday, but
    // that doesn't help Saturday). Found 2026-08-03 while auditing job/Telegram health.
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'fii-dii-fetcher',
    label: 'FII/DII Fetcher',
    category: 'Data',
    critical: true,
    description: 'Fetches institutional flow data from NSE API',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: 'fii_dii_fetcher.py',
    queueName: null,
    staleLimitHours: 30,
    // Runs as a step inside ml-daily-ops (20 13 * * 1-5 = 6:50pm IST); checked before that
    // hasn't run yet today, not actually stale off Friday's run.
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'finbert-scorer',
    label: 'FinBERT Sentiment',
    category: 'Data',
    critical: false,
    description: 'Scores news sentiment onto technical_signals rows',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: 'finbert_scorer.py --days 1',
    queueName: null,
    staleLimitHours: 30,
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'ml-ensemble-score',
    label: 'ML Ensemble Score',
    category: 'ML',
    critical: true,
    description: 'Scores pending signals with stacking ensemble win probability',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: 'ml_ensemble.py --score',
    queueName: 'ml-daily-ops',
    staleLimitHours: 26,
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'ml-ensemble-train',
    label: 'ML Ensemble Train',
    category: 'ML',
    critical: false,
    description: 'Retrains GB+RF+ET+LR stacking ensemble on accumulated outcomes',
    schedule: 'Weekly Sunday',
    pyScript: 'ml_ensemble.py --train --score',
    queueName: 'ml-weekly-retrain',
    staleLimitHours: 200,
  },
  {
    id: 'strategy-optimizer',
    label: 'Strategy Optimizer',
    category: 'ML',
    critical: false,
    description: 'Optimizes category/source weights via differential evolution',
    schedule: 'Weekly Sunday',
    pyScript: 'strategy_optimizer.py',
    queueName: 'ml-weekly-retrain',
    staleLimitHours: 200,
  },
  {
    id: 'ohlcv-backfill',
    label: 'OHLCV Gap Fill',
    category: 'Data',
    critical: true,
    description: 'Backfills missing daily OHLCV from Yahoo Finance (30-day lookback)',
    schedule: 'Weekly Saturday',
    pyScript: 'backfill_ohlcv.py --mode gap-fill --lookback 30',
    queueName: 'ohlcv-backfill',
    staleLimitHours: 200,
  },
  {
    id: 'regime-detector',
    label: 'Market Regime Detector',
    category: 'ML',
    critical: true,
    description: '5-state HMM classifier: BULL / SIDEWAYS / HIGH_VOL / BEAR / CRASH. Writes daily regime to market_regimes.',
    schedule: 'Daily 4:45 PM IST',
    pyScript: 'regime_detector.py --mode update',
    queueName: null,
    staleLimitHours: 26,
    // Driven by the dedicated DL Regime Update queue ('dl-regime-daily' in
    // src/server/jobs/dl.jobs.ts), which is Mon-Fri only (15 11 * * 1-5 = 4:45pm IST) -- this
    // entry had no cronPatterns at all, so the flat 26h staleLimitHours false-flagged 'stale'
    // (critical: true, real Telegram alert) every Sat/Sun off Friday's success, the exact
    // "false-alarm every weekend" bug class already fixed for dl-feature-refresh/drift-detector/
    // ml-ensemble-incremental on 2026-07-19. Found 2026-08-03 while auditing job/Telegram health.
    cronPatterns: ['15 11 * * 1-5'],
    graceMinutes: 45,
  },
  {
    id: 'feature-engineering',
    label: 'Feature Engineering',
    category: 'Data',
    critical: true,
    description: 'Computes 84 ML-ready features per symbol (OHLCV, macro, FII, fundamentals) into feature_store.',
    schedule: 'Daily 5:00 PM IST',
    pyScript: 'feature_engineering.py --date today',
    queueName: null,
    staleLimitHours: 26,
    // Dedicated DL Feature Refresh queue ('dl-feature-daily' in src/server/jobs/dl.jobs.ts).
    // MOVED 2026-07-31 from 0 10 * * 1-5 (3:30pm IST, the closing bell -- ran before that
    // day's OHLCV bar was persisted) to 30 11 * * 1-5 (5:00pm IST). This mirror was not
    // updated at the time, so feature-engineering false-alarmed 'stale' (critical: true,
    // real Telegram alert) every weekday between the old 4:30pm deadline and the real
    // 5:00pm+ run completing -- found 2026-08-03 while auditing job/Telegram health. Keep
    // in lockstep with dl.jobs.ts's 'dl-feature-daily' repeat pattern.
    cronPatterns: ['30 11 * * 1-5'],
    graceMinutes: 60,
  },
  {
    id: 'reward-engine',
    label: 'Reward Engine',
    category: 'ML',
    critical: false,
    description: 'EMA-smoothed reward propagation — updates signal_type_weights from resolved outcomes.',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: 'reward_engine.py',
    queueName: null,
    staleLimitHours: 26,
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'rl-agent-update',
    label: 'RL Agent Update',
    category: 'ML',
    critical: false,
    description: 'Q-learning meta-controller update — writes Q-values to rl_q_table from recent episodes.',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: 'rl_agent.py --update',
    queueName: null,
    staleLimitHours: 26,
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'dl-engine-infer',
    label: 'DL Engine Inference',
    category: 'ML',
    critical: false,
    description: 'Deep learning model inference — writes win probabilities to deep_learning_predictions.',
    schedule: 'Chain-triggered after dl-feature-refresh; 5:00 AM IST fallback',
    pyScript: 'dl_engine.py --mode infer',
    queueName: null,
    staleLimitHours: 26,
    // Dedicated DL Inference queue. 2026-08-06: primary trigger is now dl.jobs.ts's
    // featureRefresh.worker completion chain (fires the moment feature_store actually has
    // fresh data, typically hours before the fallback below) -- '0 16' = 9:30 PM IST is a
    // fallback-only cron for the rare case the chain never fired.
    // Keep in lockstep with queues.ts.
    cronPatterns: ['0 16 * * 1-5'],
    graceMinutes: 45,
  },
  {
    id: 'dl-trainer',
    label: 'DL Model Trainer',
    category: 'ML',
    critical: false,
    description: 'Trains / retrains deep learning model on feature_store. Writes metrics to dl_model_performance.',
    schedule: 'Weekly Sunday',
    pyScript: 'dl_trainer.py --trigger scheduled',
    queueName: null,
    staleLimitHours: 200,
  },
  {
    id: 'signal-type-stats',
    label: 'Signal Type Stats',
    category: 'Signals',
    critical: false,
    description: 'Computes win rate / avg return per signal type × regime from resolved signal outcomes.',
    schedule: 'Daily 6:50 PM IST (inside ml-daily-ops)',
    pyScript: null,
    queueName: null,
    tsFunction: 'computeSignalTypeStats',
    staleLimitHours: 26,
    // graceMinutes 60 -> 280: this entry is a step inside the ml-daily-ops chain (the
    // '20 13 * * 1-5' pattern above), whose Worker lockDuration is 4h (240min) --
    // jobRegistryGraceMinutesConsistency.test.ts already found and fixed the equivalent
    // JOB_REGISTRY entry for this same underlying job, but this is a SEPARATE, independently
    // tracked registry (DB-freshness via monitor.router.ts, not job_heartbeat), so fixing one
    // never touched the other. 60min grace flagged 'stale' on every run that took over an
    // hour into the chain, which per ml-daily-ops's own declared budget is normal. Bumped to
    // match the corresponding JOB_REGISTRY sub-step fix (270min parent + 10min). Found
    // 2026-08-03 while building the graceMinutes mirror-consistency test.
    cronPatterns: ['20 13 * * 1-5'],
    graceMinutes: 280,
  },
  {
    id: 'screener-performance',
    label: 'Screener Performance Engine',
    category: 'ML',
    critical: false,
    description: 'Fills screener_appearances returns, computes Bayesian tiers (A/B/C/D), classifies new screeners via Ollama',
    // Was labelled "Daily 6 PM" but the queue used `every: 24h`, which drifts on every
    // restart — it actually last succeeded at 5:42 AM IST. Pinned to a real cron 2026-07-31.
    schedule: 'Daily 10:10 PM IST',
    pyScript: 'screener_performance.py',
    queueName: 'screener-performance',
    staleLimitHours: 26,
    cronPatterns: ['40 16 * * 1-5'],
    graceMinutes: 180,
  },
  {
    id: 'company-profiles-sync',
    label: 'Company Profile & AI Sync',
    category: 'Data',
    critical: false,
    description: 'Fetches Trendlyne company descriptions and scores high-growth potential via Gemini AI.',
    // Actually daily, all 7 days, 21:00 IST (sync.jobs.ts 'sync-company-profiles', 30 15 * * *)
    // -- shards the universe by day-of-year, one run/day needed for full coverage every ~7
    // days. Label corrected 2026-08-03 (was stale "Bi-weekly Sunday", pure display text with
    // no effect on the staleLimitHours=360 threshold below, which was already generously
    // sized for the real daily cadence).
    schedule: 'Daily (all 7 days), universe sharded across ~7 days',
    pyScript: null,
    queueName: 'company-profiles-sync',
    staleLimitHours: 360,
  },
  {
    id: 'trendlyne-fundamentals',
    label: 'Trendlyne Fundamentals (EPS + DVM)',
    category: 'Data',
    critical: false,
    description: 'EPS_TTM + DivYield series and DVM scores (PE/PB now fed by mc_pricefeed_fetcher.py)',
    schedule: 'Weekly Sunday',
    pyScript: 'trendlyne_fundamentals_fetcher.py',
    queueName: 'ml-weekly-retrain',
    // 200h assumed a flat 168h (Sunday-to-Sunday) worst case, but the written `date` value is
    // logical_write_floor()-anchored to the last completed trading session (Friday), not the
    // Sunday run itself -- so the OLD value sits 2 extra days stale before each week's run
    // overwrites it. True worst case (checked right before this week's ~10:30 IST run, off the
    // OLD Friday-anchored value from 9 days earlier): ~221h. 260h leaves real margin. Found
    // 2026-08-09: this exact boundary false-flagged 'stale' in the daily digest, then silently
    // "recovered" a few hours later once the week's run landed -- a real, weekly-recurring
    // false positive, not a one-off.
    staleLimitHours: 260,
  },
  {
    id: 'trendlyne-midweek',
    label: 'Trendlyne Midweek (Adv-Tech + Price Analysis)',
    category: 'Data',
    critical: false,
    description: 'Advanced technical analysis + price-performance alpha, moved off Sunday',
    schedule: 'Weekly Tuesday',
    pyScript: null,
    queueName: 'trendlyne-midweek',
    staleLimitHours: 200,
    // Weekly Tuesday 30 14 * * 2 = 8pm IST. MOVED 2026-07-31 from 30 12 * * 2 (6pm IST) when
    // the three screener syncs relocated into the 6:00-6:40pm block and landed on this job's
    // old slot (see src/server/jobs/trendlyneWeekly.jobs.ts's 'trendlyne-midweek-batch'). This
    // mirror was not updated at the time, so every Tuesday this entry false-flagged 'stale' in
    // the daily digest between the old 8pm deadline and the real 8pm+ run completing -- found
    // 2026-08-03 while auditing job/Telegram health. Cron-aware grace still correctly flags
    // this one stale if it's genuinely missed 2+ weekly cycles (its MIN() of two source tables
    // means a single broken underlying fetcher pins the whole entry stale) -- that is a real
    // data problem to chase (see trendlyne_adv_tech_fetcher.py / trendlyne_price_analysis_fetcher.py),
    // not a timing false-positive, so this field only removes the "checked mid-week" noise.
    cronPatterns: ['30 14 * * 2'],
    graceMinutes: 120,
  },
  {
    id: 'financial-ratios',
    label: 'Financial Ratios (ET_Stats)',
    category: 'ML',
    critical: false,
    description: 'FCF yield (approx) + interest coverage, rewritten against ET_Stats after Trendlyne retired the params',
    // Was "First Sunday of month" / staleLimitHours: 900 -- both stale. financial_ratios_fetcher.py
    // was moved OUT of the first-Sunday gate on 2026-07-31 (see trendlyneWeekly.jobs.ts's
    // processTrendlyneRatiosMonthly: it now runs unconditionally on every Sunday, before the
    // `isFirstSundayOfMonth` check that still gates working_capital_fetcher.py/
    // mf_stock_holdings_fetcher.py below it) -- this entry's own label/threshold were never
    // updated to match, so it was carrying a 5x-looser threshold than its real weekly cadence
    // needs (not a false-alarm risk, since 900h > the true 168h worst case, but a real
    // staleness-detection blind spot: a genuine break wouldn't have been flagged for up to 900h
    // instead of ~200h). Found 2026-08-03 while building the staleLimitHours mirror-consistency
    // test -- corrected to match its ml-weekly-retrain/trendlyne-fundamentals siblings' convention
    // (168h worst case + margin). working-capital below is genuinely still monthly-gated and
    // keeps its own correct 900h.
    schedule: 'Weekly Sunday',
    // 200h was still wrong, found 2026-08-09: `as_of_date` is logical_write_floor()-anchored to
    // the last completed trading session (Friday), 2 days behind the Sunday run that writes it --
    // same lag as trendlyne-fundamentals above. True worst case checked right before that week's
    // ~18:00 IST run: ~228h. Confirmed live-recurring (flagged 'stale' at 216-222h, well under a
    // genuine break) -- bumped to match trendlyne-fundamentals' 260h.
    // Same day (2026-08-09): the driving job (trendlyneWeekly.jobs.ts) moved from 18:00 IST to
    // 06:00 IST -- 12h earlier means ~12h LESS elapsed since Friday's close, so the real gap is
    // now ~216h, not ~228h. 260h stays a safe (now slightly more generous) margin; no change
    // needed to the threshold itself.
    pyScript: 'financial_ratios_fetcher.py',
    queueName: 'trendlyne-ratios-monthly',
    staleLimitHours: 260,
  },
  {
    id: 'working-capital',
    label: 'Working Capital Cycle (ET_Stats, annual)',
    category: 'ML',
    critical: false,
    description: 'Cash conversion cycle per fiscal year, rewritten against ET_Stats after Trendlyne retired the params',
    schedule: 'First Sunday of month',
    pyScript: 'working_capital_fetcher.py',
    queueName: 'trendlyne-ratios-monthly',
    // Same "first Sunday of month" worst-case-gap fix as financial-ratios above (840h > 800h).
    staleLimitHours: 900,
  },
  {
    id: 'tickertape-scorecard',
    label: 'Tickertape Scorecard (ordinal tags)',
    category: 'Data',
    critical: false,
    description: 'Performance/Valuation/Growth/Profitability ordinal tags (numeric values are premium-gated)',
    schedule: 'Weekly Saturday',
    pyScript: 'tickertape_scorecard_fetcher.py',
    queueName: 'tickertape-scorecard',
    staleLimitHours: 200,
  },
  {
    id: 'corporate-actions-ingest',
    label: 'Corporate Actions Ingest (splits/dividends)',
    category: 'Data',
    critical: false,
    // 2026-08-07 dead-column-sweep fix: ingest_corporate_actions() was real and correct but
    // never scheduled with ingest enabled (both existing ohlcv_quality.py calls pass
    // --no-ingest for performance) -- corporate_actions.ratio was 0/389 rows before this.
    description: 'Split ratios + dividend amounts from yfinance into corporate_actions (ratio column)',
    schedule: 'Weekly Saturday',
    pyScript: 'ohlcv_quality.py',
    queueName: 'corporate-actions-ingest',
    staleLimitHours: 200,
  },
  {
    id: 'intraday-breadth-capture',
    label: 'Intraday Breadth Capture',
    category: 'Data',
    critical: true,
    description: 'Live adv/dec breadth nowcast off the 5-min quote refresh, feeding intraday_regime.py. Snapshot is throttled to every 15 min (matching the regime detector cadence) to avoid 3× redundant DB writes — the 20-min staleness guard in intraday_regime.py still sees a fresh row every cycle. Runs inside the market-regime-refresh BullMQ worker (queues.ts) -- no catch-up on a restart, so this is the one guard that catches a silent capture outage (e.g. the 2026-07-16 all-day gap).',
    schedule: 'Every 15 min, market hours',
    pyScript: null,
    queueName: null,
    staleLimitHours: 1,
    // Real window is 9:15am-3:30pm IST (3:45-10:00 UTC). market-regime-refresh's own
    // isMarketOpen() guard (queues.ts) only calls persistIntradayBreadth() inside real NSE
    // trading hours, and only stamps recordHeartbeat('intraday-breadth-capture', ...) on THAT
    // branch (unlike its siblings market-regime-refresh/intraday-ranker, which also stamp
    // 'success' on the closed-market early-return). The underlying job's own *registered* cron
    // ('*/15 3-10 * * 1-5' in queues.ts) is rounded to hour boundaries for BullMQ's benefit, so
    // it fires through 10:45 UTC -- 45 min past the real 10:00 UTC close. Mirroring that coarse
    // pattern here made computeCronLateness() expect an occurrence as late as 10:45 UTC, and
    // since no later occurrence exists until the next trading day it pins expectedAt there for
    // the rest of the evening -- while the real MAX(snapshot_at) freezes at ~10:00:00 (the last
    // genuine capture). Net effect: a real "Critical engine stale" Telegram alert fired every
    // single trading-day evening (deadline = 10:15 UTC prev-occurrence + 25min grace = 10:40 UTC
    // onward) -- confirmed live 2026-08-04/05 (last real snapshot_at 2026-08-04T10:00:00.238Z,
    // matching the digest's own stale alert). Fixed by bounding the expected-occurrence set to
    // the REAL 3:45-10:00 UTC window with 3 sub-patterns instead of one coarse hour-range one --
    // deliberately NOT the literal repeat pattern registered in queues.ts (see the
    // monitorScriptsCronMirror.test.ts exclusion for this id, matching the news-sentiment
    // precedent for a synthesized-but-verified-equivalent cron set).
    // graceMinutes: 25 = 15-min interval + 10 min tolerance for a slow quote-fetch cycle.
    cronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'],
    graceMinutes: 25,
  },
  // Both entries below (2026-08-03) close a gap found while auditing whether JOB_REGISTRY's
  // everyMs-driven jobs (news-sentiment, trendlyne-intraday, confluence-compute) should also
  // have an independent MONITOR_SCRIPTS DB-freshness watch, not just the job_heartbeat
  // "did it run" signal. Both ids are added to KNOWN_SAFE_OVERLAPS in
  // jobRegistryVsMonitorScripts.test.ts -- this is a deliberate, intentional overlap (same
  // convention as the 11 existing ones there), not an accidental id clash.
  {
    id: 'confluence-compute',
    label: 'Confluence Engine',
    category: 'ML',
    critical: true,
    description: 'Cross-sectional confluence scoring (screener-membership confluence + ML probability overlay) across the full universe, feeding unified_ranker.py\'s confluence blend component.',
    // The strongest of the three candidates: its JOB_REGISTRY job_heartbeat entry is
    // STRUCTURALLY BLIND to whether this job is actually writing fresh data.
    // confluence.jobs.ts's processConfluenceCompute() returns `{ computed: 0, ... }` --
    // success, not a throw -- whenever isMarketOpen() is true (a deliberate skip: this is a
    // positional signal that intentionally doesn't run during market hours, to avoid
    // contending with the intraday pipeline). BullMQ's Worker fires its 'completed' handler
    // (and recordHeartbeat('confluence-compute', 'success')) on ANY non-throwing return,
    // identically whether real computation happened or the run was skipped -- so
    // job_heartbeat reports "success" every 30 minutes forever, even if confluence_signals
    // silently stopped getting real updates entirely. Only a DB-freshness check like this one
    // can catch that.
    schedule: 'Every 30 min, real writes only OUTSIDE weekday market hours (9:15am-3:30pm IST)',
    pyScript: null,
    queueName: 'confluence-compute',
    // Real worst-case gap between fresh writes is the weekday market-hours window itself
    // (~6h15m) -- isMarketOpen() is holiday/weekend-aware (queries live BSE/NSE status), so
    // weekends and holidays get real 30-min writes all day, same as any off-hours weekday
    // slot; there is no multi-day gap to model here, unlike the market-hours-ONLY jobs this
    // session already found and fixed (technical-scan, regime-detector). Not expressed as
    // cronPatterns: "every 30 min except weekday market hours" needs an inverted hour range
    // combined with a day-of-week exception that doesn't reduce to one clean 5-field cron
    // pattern -- a flat threshold generously above the real ~6h15m gap is the simpler, more
    // robust choice here, not a workaround.
    staleLimitHours: 10,
  },
  {
    id: 'news-sentiment',
    label: 'News Sentiment Refresh',
    category: 'Data',
    critical: false,
    description: 'Aggregates and AI-scores news/RSS items into news_sentiment_items, feeding finbert-scorer and the ML sentiment feature.',
    schedule: 'Every 15 min, 24/7 (no market-hours gating -- news is intraday-relevant around the clock)',
    pyScript: null,
    queueName: 'news-sentiment',
    staleLimitHours: 26, // fallback only; cronPatterns below is the real guard
    // Genuinely unrestricted 24/7 cadence (queues.ts: "news-sentiment stays 24/7 on purpose:
    // breaking news is intraday-relevant, so pausing it would degrade intraday awareness") --
    // unlike confluence-compute/trendlyne-intraday, there's no day/hour gating to model, so a
    // plain every-15-min cron is exact rather than an approximation.
    cronPatterns: ['*/15 * * * *'],
    // Worker lockDuration is 10min (queues.ts's newsSentimentWorker); graceMinutes generously
    // exceeds it to tolerate a slow RSS-fetch cycle without false-alarming.
    graceMinutes: 45,
  },
] as const;
