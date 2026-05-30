# Bharat Stock Intelligence — Full Stack Strategic Review & Fix Plan
**Date:** 2026-05-29  
**Scope:** All layers — Data pipeline, ML scoring, Signal quality, Backend API, Frontend, Infrastructure  
**Priority:** Signal accuracy + System reliability (equal weight)

---

## Executive Summary

The platform has a well-architected feedback loop on paper (screeners → signals → outcomes → ML → weights → signals) but the loop is **broken in three places**:

1. **Learned weights are never consumed** — `signal_type_weights`, `optimal_category_weights`, and `win_probability` are written by ML engines but never read by `scoreSignals()` or `confluenceEngine`
2. **Outcome resolution is incomplete** — 0 resolved 15D outcomes, RL Q-table has 0 rows; the system has no reward signal to learn from
3. **Deep learning never promotes** — BiLSTM quality gate never passes (NaN AUC stored as 0.0); DL layer adds zero value

Everything else (stale FII, noisy signals, BullMQ errors, frontend bloat) is secondary — fix the feedback loop first, then everything else compounds.

---

## Layer 1: Data Pipeline

### Current State
| Script | Status | Problem |
|--------|--------|---------|
| feature_engineering.py | OK (daily) | Minor: bin-edge error on some symbols (KALYANI) |
| fii_dii_fetcher.py | STALE 10 days | Not in daily BullMQ schedule; runs manually only |
| outcome_resolver --horizon 5 | OK | 2,157 resolved |
| outcome_resolver --horizon 15 | BROKEN | 0 resolved — signals too new or no OHLCV to check |
| ohlcv_backfill | OK | 570K rows, covers 30-day lookback |
| regime_detector | OK | 2 regimes stored |

### Fixes

**D1 — Add fii_dii_fetcher to daily BullMQ job (Critical)**  
`processOutcomeResolver` and `processMlDailyOps` in `queues.ts` already call fii_dii_fetcher, but the queues fire at 4 AM and 11:30 AM UTC. The 10-day staleness means neither fired successfully recently. Add a dedicated daily cron for it and verify Redis is persisting queue state across restarts.

**D2 — Fix outcome_resolver 15D horizon (Critical)**  
The resolver finds no signals older than 15 days that are PENDING. Root cause: `recommendation_log` entries may not be creating corresponding `signal_outcomes` rows with `horizon_days=15`. Check `outcome_resolver.py:35` — it queries `technical_signals` not `recommendation_log`. Signals are written but outcome rows may not be seeded. Fix: seed PENDING rows in `signal_outcomes` at signal creation time for both 5D and 15D.

**D3 — Fix feature_engineering bin-edge error on constant-value columns**  
`pd.qcut()` fails when a column has all-equal values (e.g., KALYANI's volume feature). Fix: wrap `qcut` in try/except, fall back to `pd.cut` with explicit bins `[-inf, median, inf]`.

**D4 — Extend OHLCV backfill to 252 trading days for all symbols**  
BiLSTM needs ≥252 rows per symbol. Currently only 2048 symbols qualify. Run `backfill_ohlcv.py --mode full --lookback 365` once to cover the gap.

---

## Layer 2: ML Scoring Pipeline

### Current State
| Engine | Status | AUC / Accuracy | Problem |
|--------|--------|----------------|---------|
| ml_ensemble (stacking) | Active | Unknown (no model_registry check) | Trained 2026-05-27, scoring 4,250 signals |
| online_learner (SGD) | Active | Unknown | 40% blend with ensemble |
| BiLSTM (dl_engine) | BROKEN | 0.0 (NaN) | Quality gate always fails |
| RL agent | BROKEN | 0 Q-table rows | No resolved outcomes for reward |
| reward_engine | Active | 48 signal_type_weights rows | Written but never consumed |
| strategy_optimizer | Active | 1 screener_weight_history row | Runs weekly; weights stored in app_settings |

### Fixes

**M1 — Wire signal_type_weights into scoreSignals() (Highest Impact)**  
`technicalSignalsService.ts:scoreSignals()` ignores the EMA-smoothed per-(signal_type, regime) weights from `signal_type_weights`. Fix: load weights at scan start, multiply `SIGNAL_SCORES[type][strength]` by the stored weight (default 1.0 if absent). This is a ~20-line change that immediately makes scoring data-driven.

```typescript
// Load once per scan:
const weights = db.prepare(`
  SELECT signal_type, regime, weight
  FROM signal_type_weights
  WHERE regime = ? OR regime = 'ALL'
`).all(currentRegime);
const weightMap = new Map(weights.map(w => [`${w.signal_type}:${w.regime}`, w.weight]));

// In scoreSignals(), multiply base score:
const learned = weightMap.get(`${sig.type}:${regime}`) ?? weightMap.get(`${sig.type}:ALL`) ?? 1.0;
score += baseScore * learned;
```

**M2 — Feed win_probability back into signal ranking (High Impact)**  
`technical_signals.win_probability` (ML ensemble output) is stored but never used to filter or re-rank signals shown to the user. Fix: in `getTechnicalSignals` tRPC procedure, apply a multiplier: signals with `win_probability < 0.40` get downgraded, `> 0.60` get promoted. Add a `effective_score = signal_score * (0.5 + win_probability)` computed column.

**M3 — Fix BiLSTM quality gate (Medium Impact)**  
Two sub-fixes:
1. Treat NaN AUC as "insufficient data" not "failed" — skip gate if `np.isnan(auc)`, still write model_registry entry with `is_active=0`, increment version so inference can use it optionally
2. Lower hard gate: `directional_accuracy > 0.50` alone is sufficient to promote (random = 0.50, any improvement is value)
3. Add `CUBLAS_WORKSPACE_CONFIG` before torch import + `cudnn.enabled = False` (already done) to fix Windows GPU training crash

**M4 — Seed RL episodes from historical signal outcomes (Medium Impact)**  
`rl_agent.py --update` finds no episodes because `rl_episodes` table is empty. Fix: add a `--backfill` mode to `rl_agent.py` that constructs synthetic episodes from `signal_outcomes` (state = regime at signal_date × sector × score_bucket, action = inferred from signal_type, reward = return_pct − nifty_return_pct). Run once to bootstrap Q-table.

**M5 — Add time-split CV to ml_ensemble training (Medium Impact)**  
Current training uses all data without temporal split, risking look-ahead bias. Fix: use `TimeSeriesSplit(n_splits=5)` instead of random KFold. OOF predictions should only look backward.

**M6 — strategy_optimizer objective: weight by sample count**  
Current: `0.5×win_rate + 0.3×profit_factor + 0.2×sharpe` — a strategy with 3 trades and 100% win rate beats one with 500 trades and 65%. Fix: multiply objective by `min(n_signals, 100) / 100`.

---

## Layer 3: Signal Quality

### Current State
- 5,476 rows in `technical_signals`, 4,250 have `win_probability`
- 2,157 resolved 5D outcomes (win rate unknown without query)
- 0 resolved 15D outcomes
- 45 signal_type_stats rows
- `confluenceEngine` scores 0–100 with ELITE/STRONG/MODERATE/WEAK conviction
- No deduplication between technical signals and confluence signals for the same stock

### Fixes

**S1 — Consolidate signal view: technical × confluence × ML (High Impact)**  
A stock can have contradictory signals across the three systems. Add a `unified_signal_score` computed as:
```
unified = 0.4 × (signal_score/10) + 0.4 × (win_probability) + 0.2 × (confluence_score/100)
```
Cap at 1.0. Filter UI to show only stocks where `unified_signal_score > 0.55` AND `confluence_score ≥ 40` (MODERATE+). This immediately reduces noise from 5,476 → ~200 actionable signals.

**S2 — Add conviction gating: minimum 2 independent signals (High Impact)**  
A stock should only appear in the actionable list if at least 2 of 3 independent engines agree: technical scanner (signal_score ≥ 6), ML ensemble (win_probability ≥ 0.55), confluence (score ≥ 60). No single-engine signals.

**S3 — Fix outcome seeding for 15D horizon at signal creation**  
When `runTechnicalSignalScan()` writes to `recommendation_log`, it should also insert a `signal_outcomes` row with `outcome='PENDING'` and `horizon_days=15`. Currently this only happens for 5D. Fix in `technicalSignalsService.ts` where recommendation_log is written.

**S4 — Add signal expiry: mark signals older than horizon as EXPIRED**  
Signals with `signal_date < today - horizon_days` that are still PENDING should be resolved as NEUTRAL (no meaningful exit found). Add this to `outcome_resolver.py` as a final sweep.

---

## Layer 4: Backend API

### Current State
- 199 tRPC procedures across 21 routers
- No circuit breaker on external APIs (Yahoo Finance, MoneyControl, Trendlyne)
- AbortSignal timeouts only (8–15s)
- No retry with backoff on Yahoo Finance batch fetching
- `router.ts` is modular but `technicalSignalsService.ts` is 1,300+ lines

### Fixes

**B1 — Add exponential backoff to Yahoo Finance batching (Critical)**  
`liveStockData.ts` fires 8 concurrent batches with no retry. Yahoo Finance 429s are silently dropped. Add: max 3 retries per batch, exponential backoff (1s, 2s, 4s), circuit breaker (if 3 consecutive batches fail, pause 5 min).

**B2 — Add circuit breaker for Trendlyne/MC (High Impact)**  
Both providers return 503s periodically. Currently the error is swallowed. Add a module-level `failCount` counter per provider; if ≥3 failures in 10 min, skip that provider for 30 min and return cached data.

**B3 — Split technicalSignalsService.ts (Medium Impact)**  
1,300+ lines with signal detection, scoring, AI insights, DB writes, and stats computation all mixed. Split into:
- `signalDetector.ts` — pattern detection only
- `signalScorer.ts` — scoring + learned weights
- `signalPersistence.ts` — DB reads/writes
- `technicalSignalsService.ts` — orchestration only (~100 lines)

**B4 — Cache getSystemStatus (Low Impact)**  
`getSystemStatus` runs 17 DB queries synchronously on every poll (30s interval × all clients). Add 10s in-memory cache.

---

## Layer 5: Frontend

### Current State
- `App.tsx`: 3,853 lines, 57 routes
- `PremarketPanel` imported but never rendered (dead code)
- No error boundaries around tabs
- No loading skeleton on slow tRPC calls
- `TradeDecisionCockpit` visible but no clear entry/exit action flow

### Fixes

**F1 — Add unified signal dashboard as default landing (High Impact)**  
Current landing is `dashboard` which shows many widgets. The most actionable view is the intersection of signals from all three engines. Create a "Today's Picks" tab at position 1 showing the unified_signal_score top 10, with colour-coded conviction (ELITE=green, STRONG=amber, MODERATE=grey). This requires S1 (unified score) to be implemented first.

**F2 — Add error boundaries per tab (High Impact)**  
A single failing tRPC call crashes the entire tab view. Wrap each tab's root component in React `ErrorBoundary`. Show "Service temporarily unavailable" with retry button instead of blank screen.

**F3 — Remove dead code: PremarketPanel (Low Impact)**  
`import PremarketPanel` at line 71 is never used. Remove import and the component file if unused.

**F4 — Lazy-load heavy tabs (Medium Impact)**  
Tabs like `backtest`, `screener`, `trendlyne` load heavy components on initial mount. Use `React.lazy()` + `Suspense` to defer until tab is selected. Reduces initial bundle parse time.

---

## Layer 6: Infrastructure

### Current State
- BullMQ: "Missing lock" errors on high-frequency jobs (news-sentiment every 30s, confluence every 30min) — partially fixed with error event handlers
- Monitor page: shows 5 stale scripts
- DL trainer: BiLSTM never promotes; quality gate logic broken
- No Telegram alerts for critical failures
- Redis: single instance, no persistence config visible

### Fixes

**I1 — Increase news-sentiment interval from 30s to 5min (High Impact)**  
30-second repeatable jobs are the primary source of "Missing lock" errors. The sentiment data doesn't change in 30 seconds. Change to `every: 5 * 60 * 1000`. This eliminates 90% of BullMQ noise.

**I2 — Add Telegram alert for critical script failures (High Impact)**  
`telegramService.ts` exists and is configured. Wire it: when `monitor_${id}` is set to 'failed' in app_settings AND `script.critical === true`, send a Telegram message. Add this to `triggerScript` in `monitor.router.ts`.

**I3 — Add Redis persistence config (Medium Impact)**  
BullMQ relies on Redis. If Redis restarts without persistence, all repeatable job schedules are lost and must be re-registered on next app boot. Add `appendonly yes` to Redis config and document the startup dependency.

**I4 — Reduce DL trainer MAX_TRAIN_SYMBOLS dynamically based on free RAM (Medium Impact)**  
Currently hardcoded to 150. If other processes (Ollama, LM Studio) are using RAM, even 150 symbols can OOM. Add: `import psutil; free_gb = psutil.virtual_memory().available / 1e9; MAX = min(150, int(free_gb * 80))` to set a dynamic cap.

**I5 — Move Python path from hardcoded string to env var (Low Impact)**  
`monitor.router.ts` and `queues.ts` both hardcode `C:\Users\amit_\AppData\Local\Programs\Python\Python311\python.exe`. This breaks on any other machine. Use `process.env.PYTHON_PATH || 'python3'` (already partially done in monitor.router.ts, not consistent in queues.ts).

---

## Implementation Order (Phased)

### Phase 1 — Fix the Feedback Loop (Week 1)
Priority: without this, nothing learns.

| # | Fix | File | Lines |
|---|-----|------|-------|
| 1 | Seed signal_outcomes PENDING rows for 15D at signal creation | technicalSignalsService.ts | ~10 |
| 2 | Wire signal_type_weights into scoreSignals() | technicalSignalsService.ts | ~25 |
| 3 | Feed win_probability into signal ranking (effective_score) | router.ts | ~15 |
| 4 | Fix BiLSTM quality gate (NaN handling + lower threshold) | dl_trainer.py | ~15 |
| 5 | Backfill RL episodes from historical outcomes | rl_agent.py (new --backfill mode) | ~50 |

### Phase 2 — Signal Quality (Week 2)
| # | Fix | File | Lines |
|---|-----|------|-------|
| 6 | Unified signal score + conviction gating | router.ts + new endpoint | ~60 |
| 7 | Signal expiry sweep in outcome_resolver | outcome_resolver.py | ~20 |
| 8 | Fix feature_engineering bin-edge error | feature_engineering.py | ~5 |
| 9 | strategy_optimizer sample-weight objective | strategy_optimizer.py | ~10 |

### Phase 3 — Reliability (Week 3)
| # | Fix | File | Lines |
|---|-----|------|-------|
| 10 | Increase news-sentiment to 5min | queues.ts | ~3 |
| 11 | Telegram alert on critical script failure | monitor.router.ts | ~20 |
| 12 | Yahoo Finance backoff + circuit breaker | liveStockData.ts | ~40 |
| 13 | Trendlyne/MC circuit breaker | marketData.ts | ~30 |
| 14 | Dynamic MAX_TRAIN_SYMBOLS via psutil | dl_engine.py | ~5 |

### Phase 4 — Frontend & Cleanup (Week 4)
| # | Fix | File | Lines |
|---|-----|------|-------|
| 15 | "Today's Picks" unified signal tab | new component | ~150 |
| 16 | React ErrorBoundary per tab | App.tsx | ~40 |
| 17 | Lazy-load heavy tabs | App.tsx | ~20 |
| 18 | Split technicalSignalsService.ts | 4 new files | refactor |
| 19 | Remove PremarketPanel dead code | App.tsx | ~2 |

---

## Success Metrics

After Phase 1+2:
- `signal_outcomes` 15D resolved count > 500 within 3 weeks
- `rl_q_table` row count > 0 (RL agent has learned)
- `win_probability` correlation with actual outcomes (measure via `getAccuracyMetrics`)
- Actionable signals reduced from 5,476 → < 300 per day (unified_score > 0.55 + multi-engine agreement)

After Phase 3+4:
- Zero "Missing lock" BullMQ errors in logs
- All 17 monitor scripts showing green (not stale)
- BiLSTM promoting at least one model with `directional_accuracy > 0.50`
- Telegram alert fires within 5 min of any critical script failure

---

## What NOT to Build

- More screener integrations (already have 3; quality > quantity)
- More ML model types (fix the feedback loop before adding models)
- New frontend tabs (already 57 routes; consolidate before adding)
- Real-time WebSocket price streaming (Yahoo Finance rate limits make this unreliable)
