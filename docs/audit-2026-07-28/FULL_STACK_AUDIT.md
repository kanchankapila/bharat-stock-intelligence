# Bharat Stock Intelligence — Full-Stack Quantitative & Systems Audit
**Date:** 2026-07-28 | **Scope:** Data pipeline, ML/quant logic, strategy benchmarking, system infrastructure
**Method:** 5 independent deep-read passes (data ingestion, math/concurrency, ML/quant leakage, institutional-strategy benchmarking, performance/memory), each grounded in direct file reads with file:line citations. This codebase has already been through many prior audit/fix cycles (see `CLAUDE.md` "Recent session notes" and the memory system) — every finding below was checked against that history and is a **new, previously undocumented** gap, not a re-report of something already fixed.

**Round 1 coverage:** ~35 of ~145 Python engines/fetchers, all 26 `routers/*.ts` (spot-checked for loop patterns), `unified_ranker.py`, `scoring_engine.py`, `ml_ensemble.py`, `cs_ranker.py`, `confluence_ml_engine.py`, `online_learner.py`, `breakout_classifier.py`, `relative_strength.py`, `multi_factor_scorer.py`, `exit_policy.py`/`exit_labeler.py`/`outcome_resolver.py`, `atrBarriers.ts`, `technicalScanner.ts`, `candlestickUtils.ts`, `cacheService.ts`, `pythonRunner.ts`, `queues.ts`, `db/schema.postgres.sql`.

**Round 2 (this update) extends coverage to:** all remaining strategy/portfolio quant engines (`rl_agent.py`, `strategy_optimizer.py`, `backtester.py`, `intraday_ranker.py`, `intraday_regime.py`, `reward_engine.py`, `performance_tracker.py`, `backtest_optimizer.py`, `ml_signal_scorer.py`, and 8 more), all remaining F&O/options/macro fetchers (24 files), all remaining NLP/earnings/insider fetchers (15 files), all remaining OHLCV/technical/sector/misc fetchers (25 files, all full-read), the React frontend (`src/components/`, `src/App.tsx`, `src/services/`, ~18 files fully read plus targeted `App.tsx` sections), and — new in this round — **live verification against the actual production Postgres database** (`bharat_intel` on `127.0.0.1:5433`, read-only `EXPLAIN ANALYZE`/row-count queries, no writes) to confirm or correct several Round 1 findings with real numbers rather than static inference alone.

**Round 2 coverage:** ~120 of ~145 Python engines/fetchers (test/utility/one-off scripts like `test.py`, `explore_mc_tl.py`, `python_api.py` excluded as non-production), all `routers/*.ts`, the core scoring/ranking/ML pipeline, ~20 of ~76 frontend components (prioritized by money/scoring/chart relevance) plus targeted sections of `App.tsx` (~450 of ~4,319 lines).

**Round 3 (this update) closes out every remaining gap Round 2 flagged:** an exact file-tree diff (not estimation) identified the true remaining Python surface — 23 files, read in full: `as_of.py`, `et_stats_client.py`, `tickertape_client.py`, `feature_engineering.py`, `live_screener_ml_ranker.py`, `live_screener_optimizer.py`, `live_screener_resolver.py`, `backtest_live_screener.py`, `ml_calibration.py`, `market_regime_fetcher.py`, `movement_predictor.py`, `early_hours_predictor.py`, `daily_ml_update.py`, `dl_trainer.py`, `mc_earnings_fetcher.py`, `mc_techscanner_fetcher.py`, `mf_stock_holdings_fetcher.py`, `preopen_fetcher.py`, `screener_features_fetcher.py`, `screener_performance.py`, `stock_option_chain_fetcher.py`, `intraday_features.py`, `extra_endpoints_fetcher.py`, `endpoint_registry.py`, `drift_detector.py`, plus targeted re-verification of `asm_gsm_fetcher.py` against the two known recurring bug patterns. `src/App.tsx` was read to completion (all 4,319 lines). All remaining 66 `src/components/*.tsx` files were read in full. A repo-wide grep sweep for the two recurring systemic patterns (as Round 2's own priority table recommended) was run directly against the codebase, which is what surfaced Findings #82 and #83 below before any file was even opened.

**Total coverage after Round 3: essentially the full production codebase** — every Python file in `src/server/` except test/exploratory scripts (`test.py`, `explore_mc_tl.py`, `python_api.py`) and the Python test suite itself; all `routers/*.ts`; `src/App.tsx` in full; all `src/components/*.tsx` files; the shared DB/translation layer (`db_compat.py`, `sql_translate.py`); and live read-only verification against the production Postgres database for 6 findings across all three rounds. **What remained out of scope going into Round 4:** `v3`/`v4` frontend directories beyond the one file checked in Round 2, the Python test suite itself (not audited as "code under test," only used to confirm/refute findings), and a full `EXPLAIN ANALYZE` sweep of every performance finding (6 of ~15 performance-related findings across all rounds were live-verified; the rest remain static-inference only, clearly labeled as such where they appear).

**Round 4 (this update) closes both of those gaps**: all 7 remaining `v3`/`v4` files were read in full (`V3Dashboard.tsx`, `MarketCommandCenter.tsx`, `StockIntelligencePage.tsx`, and 4 `v4/components/*.tsx` widgets), and the production Postgres database was reachable for a full live-verification pass over the 7 previously-static-only Dimension-5 findings (#35-#41) — see "ROUND 4" and its "Live Database Verification (Round 4 additions)" section below. The Python test suite itself remains the one deliberately-unaudited area (used only to confirm/refute findings, never as code-under-test).

**Priority summary after Round 4** (verified by direct count against the report's own finding headers): 9 **Critical**, 34 **High**, 47 **Medium**, 17 **Low** — 109 findings total (2 additional entries, Findings #78 and #109, are "confirmed clean, no action needed" corrections rather than defects, and are excluded from these counts). 2 findings were corrected/retracted after Round 2's live DB verification; 2 Round 3 findings (#82, #83) were confirmed with direct live evidence; and Round 4's own DB pass live-verified all 7 remaining Dimension-5 findings (#35-#41), further revising Finding #41's Round 2 retraction now that the underlying tables have grown (real measured join cost is 1,436ms today, not the ~6ms previously reported — see the Live Database Verification sections for exact numbers).

---

## DIMENSION 1 — Data Collection & Pipeline Integrity

### 📌 Finding #1: Silent all-endpoint failure exits 0 in `mc_global_macro_fetcher.py`
- 🎯 Location: `src/server/mc_global_macro_fetcher.py:123-130` (`_get`), `:425-493` (`run`)
- 🏷️ Category: Data Integrity
- 🔴 Severity: High

#### 1. Problem Description
`_get()` bare-`except Exception: return None`s on all 5 macro endpoints (Asia indices, USD/INR, ADRs, commodities, global indices). `run()` never checks whether at least one endpoint succeeded — if all 5 fail (site block, schema change), it still prints "Done. 0 records written" and exits 0.

#### 2. Strategy & Benchmark Comparison
Industry-standard ETL practice treats "zero rows written" as a distinguishable failure state from "confirmed empty result," typically via a dead-man's-switch / minimum-row-count assertion before a job is allowed to report success.

#### 3. Root Cause & Impact
`ml_ensemble.py` consumes these as macro features (Asia sentiment, USD/INR, ADR bullishness). A silent full-outage degrades those features to stale/missing with zero operator visibility — the same failure class that caused the 2026-07-23 URL-corruption incident to go undetected for weeks.

#### 4. Actionable Correction
```python
# After run() finishes fetching all 5 endpoints:
if records == 0:
    logger.error("mc_global_macro_fetcher: 0 records from all 5 endpoints — treating as failed run")
    sys.exit(1)
```

---

### 📌 Finding #2: `credit_rating_fetcher.py` and `eps_surprise_fetcher.py` never signal failure
- 🎯 Location: `src/server/credit_rating_fetcher.py` (`main()`, no `sys.exit(1)` path, no `import sys`); `src/server/eps_surprise_fetcher.py:154-167,401-442`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
Both fetchers log a warning on total fetch failure but always exit 0. `eps_surprise_fetcher.py`'s `_fetch_per_stock` (lines 221-230) also silently skips per-stock failures with no aggregate failure-rate report.

#### 2. Strategy & Benchmark Comparison
Contrast with the fixed sibling `mc_broker_reco_fetcher.py`, which explicitly treats an empty result as a failed run — that pattern should be the house standard, not the exception.

#### 3. Root Cause & Impact
An NSE/MC API break is indistinguishable from "no ratings/surprises today" in the job monitor; the entire quarterly-EPS-surprise feature set can silently zero out.

#### 4. Actionable Correction
Mirror `mc_broker_reco_fetcher.py`'s explicit empty-result-is-failure guard in both files; log `{failed}/{total}` per-stock failure counts, not just an aggregate success line.

---

### 📌 Finding #3: Retry/backoff library built but rolled out to only 3 of ~50 fetchers
- 🎯 Location: `src/server/fetch_utils.py` (the `retry_get`/`FetchTracker` module) vs. `credit_rating_fetcher.py:109`, `eps_surprise_fetcher.py:162,225`, `mc_global_macro_fetcher.py:125`, `fno_rollover_fetcher.py:114`, `insider_transactions_fetcher.py:119`
- 🏷️ Category: Data Integrity
- 🔴 Severity: High

#### 1. Problem Description
`fetch_utils.py`'s own docstring says it was built because "none of the ~47 fetcher scripts used a retry/backoff library." A repo-wide check shows adoption stalled at 3 fetchers (`mc_broker_reco_fetcher.py`, `pcr_fetcher.py`, `fii_dii_fetcher.py`). The 5 files above (and likely more, not all fetchers were checked) still make single-attempt HTTP calls with no retry.

#### 2. Strategy & Benchmark Comparison
Standard resilient-ingestion practice is exponential backoff + jitter on every external call, exactly as this codebase already does correctly in `liveStockData.ts`'s `exponentialBackoffWithJitter` helper on the TypeScript side.

#### 3. Root Cause & Impact
A single dropped connection = one silently-empty run, for every fetcher that hasn't adopted the module — the exact reliability gap the module exists to close, still open across most of the codebase.

#### 4. Actionable Correction
Roll out `retry_get`/`FetchTracker` to the 5 cited call sites as a mechanical, drop-in replacement (per the module's own docstring); track adoption in the fetcher test/health tracker (`docs/FETCHER_HEALTH_TRACKER.md`) so partial rollout doesn't recur silently.

---

### 📌 Finding #4: `fundamentals_snapshot.py` actively NULLs historical rows on any date mismatch
- 🎯 Location: `src/server/fundamentals_snapshot.py:111-115, 127-141, 149`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Critical

#### 1. Problem Description
`_UPDATE_TS_SQL` does `SET pledge_chg_90d = CASE WHEN date >= ? THEN ? ELSE NULL END`, anchored on `as_of = datetime.date.today().isoformat()`. This is the identical `date.today()`-anchored `CASE WHEN…ELSE NULL` pattern that the 2026-07-25 session found and fixed in 6 sibling fetchers (`trendlyne_fundamentals_fetcher.py`, `trendlyne_adv_tech_fetcher.py`, `trendlyne_price_analysis_fetcher.py`, `trendlyne_overview_fetcher.py`, `mf_holdings_fetcher.py`, `financial_ratios_fetcher.py`) — but the fix was never propagated to this file.

#### 2. Strategy & Benchmark Comparison
The already-fixed sibling files now anchor to the last completed trading session (or an equivalent `MAX(date)` per symbol), not `date.today()`. That is the correct, already-proven pattern in this same codebase.

#### 3. Root Cause & Impact
On any run where "today" doesn't exactly match an existing `technical_signals` row for a symbol (weekend/holiday run, a job racing the daily grid-ensurer), **every historical row for that symbol gets `pledge_chg_90d` explicitly NULLed** — this is the active-corruption variant, not merely a stale-skip. Given this is the exact class of bug that corrupted ~2.1M rows across 7 tables in the 2026-07-23 incident, this is a live, unpatched instance of the same failure mode.

#### 4. Actionable Correction
```python
# Before (line ~149):
as_of = datetime.date.today().isoformat()
# After — anchor to last completed trading session per symbol, matching the 6 already-fixed sibling files:
as_of = get_last_trading_session_date(conn, symbol)  # or a shared as_of.py helper
```
Apply the identical fix pattern used in the 6 already-remediated fetchers; add a regression test asserting a weekend/holiday run does not null any existing row.

---

### 📌 Finding #5: `credit_rating_fetcher.py`/`insider_transactions_fetcher.py` write via exact-date match, not `MAX(date)`
- 🎯 Location: `src/server/credit_rating_fetcher.py:280-291`, `src/server/insider_transactions_fetcher.py:322-336`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
Both write today's feature columns via `WHERE symbol=? AND date=?` with `date.today()`, instead of joining to the latest-available `technical_signals` row per symbol (contrast the already-fixed `mc_broker_reco_fetcher.py`'s `MAX(date)` join). Neither checks the UPDATE's affected-row count.

#### 2. Strategy & Benchmark Comparison
`mc_broker_reco_fetcher.py`'s `MAX(date)`-per-symbol pattern is the proven, already-adopted house standard for this exact "attach today's fetch to the right technical_signals row" problem.

#### 3. Root Cause & Impact
On any day the exact literal date has no `technical_signals` row yet, the UPDATE silently matches zero rows and the feature simply never lands — no error, no visibility, a quieter sibling of Finding #4's corruption mechanism.

#### 4. Actionable Correction
Switch both to the `MAX(date)`-per-symbol join pattern already used by `mc_broker_reco_fetcher.py`/`eps_surprise_fetcher.py`; log affected-row counts and alert if `0 < written < expected`.

---

### 📌 Finding #6: Split-adjustment basis seam between two writers of the same `stock_ohlcv` table
- 🎯 Location: `src/server/mc_ohlcv_backfill.py:6-9` (split-only, per its own docstring) vs. `src/server/backfill_ohlcv.py:289,350-353,465-468` (`yf.download(..., auto_adjust=True)` — splits **and** dividends), wired weekly via `queues.ts:2626-2639` (`ohlcv-backfill`, default `--lookback 30`)
- 🏷️ Category: Data Integrity
- 🔴 Severity: High

#### 1. Problem Description
`mc_ohlcv_backfill.py` populated `stock_ohlcv` back to 2021 with split-only-adjusted prices (its dividend-adjustment claim was never actually verified, only split-adjustment was). The weekly `backfill_ohlcv.py` job then overwrites (`ON CONFLICT DO UPDATE`) the most recent ~30 days with yfinance's `auto_adjust=True` bars, which adjust for both splits **and** dividends. The two adjustment bases permanently disagree at the ~30-day rolling boundary.

#### 2. Strategy & Benchmark Comparison
Any quant platform computing multi-period returns across an adjustment-basis seam (e.g. total-return vs. price-return) produces a step artifact at the boundary — standard practice is a single consistent adjustment convention end-to-end, or an explicit adjustment-basis flag per row so downstream code can detect and correct for a seam.

#### 3. Root Cause & Impact
Every feature spanning the ~30-day boundary (`relative_strength.py`'s 21d/63d return windows, multi-year ML training in `ml_ensemble.py`, `breakout_classifier.py`'s 5yr labels) picks up a step artifact proportional to cumulative dividends — worst for high-yield names (ITC, Coal India, PSU banks, ONGC), where the discontinuity can be several percent.

#### 4. Actionable Correction
Either (a) strip dividend-adjustment from the yfinance leg (`auto_adjust=False`, apply split-only adjustment manually to match MC's basis), or (b) add an `adjustment_basis` column to `stock_ohlcv` and have `relative_strength.py`/`ml_ensemble.py` skip or correct any return window that straddles a basis change.

---

### 📌 Finding #7: `liveStockData.ts` stamps OHLCV rows with UTC calendar date, not IST trading date
- 🎯 Location: `src/server/liveStockData.ts:621` (`persistTodayOHLCVData`), lower-severity siblings at `src/server/queues.ts:1042,1049`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
`const today = new Date().toISOString().split('T')[0]` uses UTC calendar date to stamp what should be the IST trading-day date. The same file's `scheduleDailyPriceCacheClear()` (lines 790-798) correctly does an IST-based offset a few lines away, proving the correct pattern is known and just not applied here.

#### 2. Strategy & Benchmark Comparison
Every date-anchor bug this codebase has hit (the `date('now')` cast bugs, the 2026-07-25 fetcher-anchor bugs) traces to exactly this class of naive-timezone mistake; the house standard fix is explicit IST conversion via `Intl`/`toLocaleDateString('en-CA', {timeZone:'Asia/Kolkata'})`.

#### 3. Root Cause & Impact
Under the current cron (job fires ~15:35 IST / 10:05 UTC) this is safe today, but there is no time-of-day guard on `fetchAndPersistOHLCVData()` — any incident-driven manual re-run between 00:00–05:30 IST stamps the canonical `stock_ohlcv` table with the wrong calendar date.

#### 4. Actionable Correction
```ts
// Before:
const today = new Date().toISOString().split('T')[0]
// After:
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
```

---

## DIMENSION 2 — Logical Flaws & Algorithmic Errors

### 📌 Finding #8: Four mutually-exclusive candlestick patterns fire simultaneously on a halted/circuit-limit candle
- 🎯 Location: `src/lib/candlestickUtils.ts:34-92` (Doji, Hammer/Hanging-Man, Shooting-Star/Inverted-Hammer, Marubozu)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
All four pattern checks use non-strict `>=`/`<=` thresholds against `bodySize`/`candleRange` with no `candleRange > 0` guard. On a trading-halt or circuit-limit day (`open===high===low===close`, both values 0), all four evaluate true at once.

#### 2. Strategy & Benchmark Comparison
Standard candlestick-pattern libraries treat a zero-range candle as a degenerate case handled by a single early return (typically classified as Doji only), never as multiple simultaneous, contradictory reversal/indecision/momentum labels.

#### 3. Root Cause & Impact
The function can simultaneously return "Doji" (indecision), "Hanging Man"/"Shooting Star" (bearish reversal), and "Bearish Marubozu" (strong directional momentum) for the identical zero-movement candle — actively misleading for exactly the days (halts, circuit limits) where signal quality matters most.

#### 4. Actionable Correction
```ts
if (candleRange === 0) return [{ name: 'Doji', ... }]
// then proceed to Hammer/Shooting-Star/Marubozu checks only when candleRange > 0
```

---

### 📌 Finding #9: "Golden Cross"/"Death Cross" mislabels a sustained state as a one-time event
- 🎯 Location: `src/server/technicalScanner.ts:79-82`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`if (sma50 > sma200) push('Golden Cross')` fires from a single snapshot with no prior-day SMA comparison — there's no crossover detection, only a level comparison.

#### 2. Strategy & Benchmark Comparison
`technical_analysis_engine.py` in the same codebase already implements a correct 4-state label (state vs. event distinction) for MACD; the same fix pattern should be applied here.

#### 3. Root Cause & Impact
Every 30-min-cached scan re-announces "Golden Cross" for as long as sma50 stays above sma200 — potentially months — rather than only on the day the cross actually happened, degrading the signal's information content to near-zero for anyone treating it as an event trigger.

#### 4. Actionable Correction
Persist yesterday's sma50/sma200 relationship (or read `prev` from `fetchHistoricalOHLC`) and only label a "Cross" when the relationship flipped since the last scan; otherwise emit a state label ("Above/Below 200 DMA"), matching the 4-state pattern already used in `technical_analysis_engine.py`.

---

### 📌 Finding #10: MACD scanner structurally cannot emit a bearish signal
- 🎯 Location: `src/server/technicalScanner.ts:98-99`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
`if (macd === 'Bullish') signals.push(...)` has no corresponding `else if (macd === 'Bearish')` branch — the bearish case is silently dropped.

#### 2. Strategy & Benchmark Comparison
Any production technical scanner must emit symmetric bullish/bearish signals for a symmetric indicator; a one-sided emission path is a straightforward logic bug, not a design choice.

#### 3. Root Cause & Impact
This scanner can never emit a bearish MACD signal, structurally skewing its output bullish regardless of actual market momentum — the same class of directional bias already documented elsewhere in this codebase's LLM path (`ai_signal_gate` memory), here reproduced in the technical-indicator path.

#### 4. Actionable Correction
```ts
if (macd === 'Bullish') signals.push({ ..., sentiment: 'Bullish' })
else if (macd === 'Bearish') signals.push({ ..., sentiment: 'Bearish' })
```

---

### 📌 Finding #11: "Volatility Calculation" is not a volatility calculation
- 🎯 Location: `src/server/technicalScanner.ts:52-55`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`volatilityScore` starts at a hardcoded `45` and only adds `+20` if `overallIndication` is `'Strong Bullish'`/`'Strong Bearish'` — there are only ever two possible output values (45 or 65), and neither is derived from price dispersion, ATR, or standard deviation.

#### 2. Strategy & Benchmark Comparison
Standard volatility measures (realized stdev of returns, ATR/close) are already computed elsewhere in this same codebase (`atrBarriers.ts`) and should be the input here.

#### 3. Root Cause & Impact
The UI's "Volatility: High/Moderate/Low" label misrepresents actual price dispersion to any user or downstream consumer reading `ScanResult.volatility` — it's a repackaged directional-sentiment flag, not a risk measure.

#### 4. Actionable Correction
Replace with `wilderATR(highs, lows, closes, 14) / lastClose` or a realized-return-stdev calculation, reusing the existing ATR helper from `atrBarriers.ts`.

---

### 📌 Finding #12: `fetchWithCache`'s in-flight dedup doesn't cover the opening burst it's meant to protect
- 🎯 Location: `src/server/cacheService.ts:153-176`
- 🏷️ Category: Performance / State Bug
- 🔴 Severity: Medium

#### 1. Problem Description
`_inFlight` is only populated *after* `await cacheGet(key)` resolves (line 158). When Redis is up, `cacheGet` is a real network round-trip, so multiple near-simultaneous callers can all observe a cache miss and find `_inFlight` empty before any registers a promise.

#### 2. Strategy & Benchmark Comparison
Standard cache-stampede prevention registers the in-flight placeholder synchronously, before any await, so concurrent callers are guaranteed to see it.

#### 3. Root Cause & Impact
A burst of near-simultaneous first requests for the same key all invoke `fetcher()` independently — exactly the stampede the function's own docstring claims to prevent, just not for the cold-start burst.

#### 4. Actionable Correction
```ts
// Register a synchronous placeholder before the cacheGet await, or check _inFlight first:
if (_inFlight.has(key)) return _inFlight.get(key)
const promise = (async () => { const cached = await cacheGet(key); ... })()
_inFlight.set(key, promise)
```

---

### 📌 Finding #13: Duplicate price-alert notifications on any overlapping/re-run job execution
- 🎯 Location: `src/server/queues.ts:290-300` (`checkPriceAlerts`)
- 🏷️ Category: State & Concurrency Bug
- 🔴 Severity: Medium

#### 1. Problem Description
The DB transition (`UPDATE ... WHERE id=? AND status='ACTIVE'`) is correctly guarded, but `dbRun`'s `changes` count is never checked before the unconditional `broadcastAlert(...)` call that follows.

#### 2. Strategy & Benchmark Comparison
Standard idempotent-notification design only fires the side-effect (push/SSE/email) when the guarded state transition actually happened (`changes > 0`), never unconditionally after the guarded write.

#### 3. Root Cause & Impact
This codebase has already hit BullMQ stalled-job re-runs via lock-duration issues (`lockDuration: 600000`); if `checkPriceAlerts()` ever runs twice concurrently for the same alert, the DB correctly transitions once but the user still gets a duplicate notification.

#### 4. Actionable Correction
```ts
const res = await dbRun(`UPDATE price_alerts SET status='TRIGGERED' WHERE id=? AND status='ACTIVE'`, [id])
if (res.changes > 0) broadcastAlert(...)
```

---

### 📌 Finding #14: Breakout classifier's volume-ratio features unguarded against zero-volume denominators, inconsistent with sibling features in the same function
- 🎯 Location: `src/server/breakout_classifier.py:122,131` vs. `:134,137,138`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Low

#### 1. Problem Description
`vol_ratio` and `vol_surge_5v20` divide by `vol.rolling(20).mean()` with no zero-guard, while three sibling features (`range_contraction`, `up_vol_ratio_10`, `hv_ratio_10_60`) a few lines later in the same function explicitly `.replace(0, np.nan)` their denominators.

#### 2. Strategy & Benchmark Comparison
The already-guarded siblings in the same function are the correct, internally-proven pattern.

#### 3. Root Cause & Impact
A stock with 20+ days of zero volume (extended suspension/ASM) produces `inf`/`NaN`, blanket-converted to `0.0` by `_feature_matrix()` — this silently conflates "volume went to zero for weeks" with "no volume-surge, normal 0," which the guarded sibling features would instead leave as a distinguishable `NaN`.

#### 4. Actionable Correction
Apply the same `.replace(0, np.nan)` guard to `vol.rolling(20).mean()` in both features.

---

### 📌 Finding #15: `breakout_classifier.py`'s RSI uses plain SMA smoothing, diverging from this codebase's own Wilder-RSI implementation
- 🎯 Location: `src/server/breakout_classifier.py:95-100` vs. `technical_analysis_engine.py`'s `ta.momentum.RSIIndicator` (confirmed Wilder-smoothed: `.ewm(alpha=1/window, adjust=False)`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`gain`/`loss` use `.rolling(period).mean()` (simple moving average — "Cutler's RSI") instead of Wilder's exponential smoothing (`alpha=1/period, adjust=False`).

#### 2. Strategy & Benchmark Comparison
Wilder's original RSI formula uses exponential smoothing, not SMA; this codebase already implements it correctly elsewhere (`technical_analysis_engine.py`), proving the divergence is an inconsistency, not a considered choice.

#### 3. Root Cause & Impact
The breakout model's `rsi14` is more reactive/choppier and disagrees with `technical_analysis_engine.py`'s `rsi` for the same stock/day — a feature named identically across the codebase means two different things depending which engine computed it, which matters if any cross-engine feature/threshold reuse (e.g. hardcoded "RSI < 30") is attempted.

#### 4. Actionable Correction
```python
gain = delta.clip(lower=0).ewm(alpha=1/period, adjust=False).mean()
loss = (-delta.clip(upper=0)).ewm(alpha=1/period, adjust=False).mean()
```
Or explicitly rename to `rsi14_sma` if the SMA variant was validated to perform better for this specific model, and re-validate either way.

---

## DIMENSION 3 — Prediction Accuracy & Quant Gaps

### 📌 Finding #16: `confluence_ml_engine.py` scores CV with shuffled K-Fold on overlapping-horizon labels
- 🎯 Location: `src/server/confluence_ml_engine.py:127 (WHERE so.horizon_days = 7)`, `:236-238 (StratifiedKFold(shuffle=True))`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Critical

#### 1. Problem Description
Training rows carry 7-day-forward-return labels; adjacent trading days' rows have heavily overlapping forward windows and correlated outcomes — exactly the situation `ml_ensemble.py` built `TimeSeriesSplit(gap=embargo)` to handle. But `train()` scores with `StratifiedKFold(n_splits=5, shuffle=True, random_state=42)` fed into `cross_val_score`. The underlying SQL has no `ORDER BY signal_date`, so even disabling shuffle wouldn't make the folds chronological.

#### 2. Strategy & Benchmark Comparison
Industry standard for overlapping-label time series is Purged Group Time Series Split (purge + embargo by date), exactly as `ml_ensemble.py._fit_stack` already implements in the same codebase. A random shuffle on correlated overlapping-window rows is a textbook CV leakage pattern.

#### 3. Root Cause & Impact
The `cv_roc_auc` written to `model_registry` and displayed as this model's quality metric is inflated versus true forward performance — the exact CV-vs-live AUC gap this codebase has repeatedly root-caused and fixed elsewhere (`ml_ensemble.py`, `breakout_classifier.py`), reintroduced here in a sibling engine.

#### 4. Actionable Correction
Sort training rows by `signal_date` (add the missing `ORDER BY`), and switch to `TimeSeriesSplit(gap=embargo_rows)` mirroring `ml_ensemble._fit_stack`, or a date-based holdout like `cs_ranker.py` uses (once Finding #19 below is also fixed).

---

### 📌 Finding #17: No promotion/regression gate on 3 of 5 training pipelines — any retrain replaces the live model unconditionally
- 🎯 Location: `src/server/confluence_ml_engine.py:212-260`, `src/server/cs_ranker.py:228-256`, `src/server/online_learner.py:189-204`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Critical

#### 1. Problem Description
`ml_ensemble.py` (`PROMOTION_MARGIN`, candidate-rejection at `promote_or_register`) and `live_screener_ml_ranker.py` (`PROMOTION_MARGIN = 0.01`) both refuse to activate a retrain that scores worse than the currently-active model. The other three don't: `confluence_ml_engine.train()` unconditionally overwrites `confluence_ml.pkl` regardless of AUC; `cs_ranker._register_cs_model()` unconditionally deactivates the previous model and activates the new one — the code even logs "rho below threshold... model saved anyway" and proceeds to activate it; `online_learner.register_update()` inserts every incremental SGD update as `is_active=1` with no comparison to pre-update state.

#### 2. Strategy & Benchmark Comparison
Standard MLOps practice for any production scoring model is a champion/challenger gate — a new model is compared against the live one on held-out data and only promoted if it doesn't regress. This codebase already builds this correctly in two of five training paths; it should be uniform.

#### 3. Root Cause & Impact
A single noisy or adverse-regime training run can silently degrade the live `ml_breakout_probability`, `cs_score`, or SGD-blended `win_probability` for every downstream consumer with no safety net and no rollback signal — this directly undermines the "canonical scoring authority" governance model documented in `CLAUDE.md`.

#### 4. Actionable Correction
Apply the same held-out-metric-must-not-regress gate (with a small margin, as `ml_ensemble.py`/`live_screener_ml_ranker.py` already do) uniformly across `confluence_ml_engine.py`, `cs_ranker.py`, and `online_learner.py` before any `is_active=1` write.

---

### 📌 Finding #18: Hyperparameter tuning evaluated on folds overlapping the later "held-out" test window
- 🎯 Location: `src/server/ml_ensemble.py:2952` (`tune_hyperparameters` call inside `run()`) vs. `:2264-2321` (`train_ensemble`'s own date-based test/val cutoff)
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
`tune_hyperparameters(X, y, ...)` is called on the **full** `X`/`y` before `train_ensemble()` computes its own honest date-based test/val boundary. Optuna's internal `TimeSeriesSplit` validates each trial against late folds that span the same calendar dates later reported as the "held-out" test set.

#### 2. Strategy & Benchmark Comparison
Correct practice is to carve out the final test window **first**, then run all hyperparameter search exclusively inside the remaining training data — the test set must never influence any modeling decision, including architecture/hyperparameter choice.

#### 3. Root Cause & Impact
The architecture/hyperparameters were implicitly selected using information from the period later reported as "held-out" — the printed `test_auc` is optimistic by an unknown amount tied to how much the tuner's late folds overlap the final test window.

#### 4. Actionable Correction
Compute the date-based `tr_end` cutoff once, before tuning, and pass only `X.iloc[:tr_end]`/`y.iloc[:tr_end]` into `tune_hyperparameters`.

---

### 📌 Finding #19: Regime feature collapses HIGH_VOL and CRASH into the same encoding as SIDEWAYS
- 🎯 Location: `src/server/ml_ensemble.py:51 (REGIME_MAP)`, `:139-140 (X['regime'] = ...fillna(0.0))`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
`REGIME_MAP = {'BULL': 1.0, 'SIDEWAYS': 0.0, 'BEAR': -1.0}` is the only regime encoding fed into the model. Any `HIGH_VOL`/`CRASH` value falls through `.fillna(0.0)` and is indistinguishable from `SIDEWAYS` to the model — even though the same file's `_REGIME_THRESHOLDS` treats all 5 regimes as distinct, and the 2026-07-23 regime-calibration work explicitly treats HIGH_VOL/CRASH as materially different volatility states.

#### 2. Strategy & Benchmark Comparison
A model conditioning on market regime should represent all operationally-distinct regimes it's evaluated/thresholded on; collapsing two volatility-distinct states into the calm-market encoding defeats the purpose of regime conditioning.

#### 3. Root Cause & Impact
The classifier itself cannot learn "this is a crash" vs. "this is calm sideways drift" — it only ever sees a function blind to that distinction, even though downstream logic (regime thresholds, position sizing) treats them as materially different. This is the reason regime-conditioning inside the model is present but degenerate for 2 of 5 states.

#### 4. Actionable Correction
Expand `REGIME_MAP` to a 5-value ordinal/one-hot encoding that distinguishes all 5 states (e.g. `HIGH_VOL: 0.5, CRASH: -2.0` or a proper one-hot block), then retrain and re-validate per-regime AUC uplift.

---

### 📌 Finding #20: `cs_ranker.py` train/test split has zero embargo despite 5-day-forward labels
- 🎯 Location: `src/server/cs_ranker.py:173-181`, `:122 (horizon_days = 5)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
The held-out split takes the last 20% of unique dates as `test_dates`, everything else as train, with zero gap between the last training date and first test date — but `load_cs_training_data()` filters 5-day-forward labels, so training rows near the boundary mechanically overlap the test period's own dates.

#### 2. Strategy & Benchmark Comparison
`ml_ensemble.py` in the same codebase explicitly subtracts an embargo equal to the label horizon between train/test — the exact fix needed here already exists as a proven pattern one file over.

#### 3. Root Cause & Impact
Inflates the reported held-out Spearman rho — the number the model was accepted on even below its own 0.10 threshold ("model saved anyway") — relative to genuine forward generalization.

#### 4. Actionable Correction
Subtract `horizon_days` (5) trading days as an embargo between the train split's last date and the test split's first date, mirroring `ml_ensemble.py`'s date-based gap logic.

---

### 📌 Finding #21: `online_learner.py`'s informational val-AUC split also has no embargo
- 🎯 Location: `src/server/online_learner.py:294-297`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
A plain positional 80/20 cut on date-sorted data, no gap subtracted for the outcome horizon (typically 15 days per `ml_ensemble.py`'s default).

#### 2. Strategy & Benchmark Comparison
Same fix as Finding #20 — a date/horizon-based embargo, not a positional split.

#### 3. Root Cause & Impact
Lower severity than #20 because nothing currently gates on this number (per Finding #17, `online_learner.py` has no promotion gate at all) — but it's misleading if anyone starts trusting it as a real quality signal, and becomes load-bearing the moment Finding #17 is fixed.

#### 4. Actionable Correction
Apply the same embargo logic as `ml_ensemble.py`/the Finding #20 fix; fix this at the same time as Finding #17 so the newly-added gate isn't itself fed a leaky metric.

---

### 📌 Finding #22: Quality features (ROE/ROCE/margins) are raw levels, not sector-relative — despite the codebase already knowing how to do this
- 🎯 Location: `src/server/ml_ensemble.py:402-406` vs. `:360 (pe_pct_rank_252d)`, `:439 (mc_pe_vs_ind)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
`roe_annual`, `roce_annual`, `ebitda_margin`, `np_margin` are clipped and linearly rescaled but never sector-demeaned or sector-percentile-ranked, while `pe_pct_rank_252d` (own-history percentile) and `mc_pe_vs_ind` (sector-relative valuation) in the same function prove the pattern already exists.

#### 2. Strategy & Benchmark Comparison
Standard factor construction (Fama-French quality factor) always compares fundamentals within a peer/sector group, since a "good" ROE for a bank is structurally different from a "good" ROE for a capital-intensive industrial.

#### 3. Root Cause & Impact
A 15% ROE means very different things for a bank/NBFC vs. a commodity producer, but the model sees the same normalized number for both — the model must implicitly re-derive "is this good for its sector" rather than being handed the signal directly, likely diluting the true information content of quality factors across a universe spanning banks/industrials/IT.

#### 4. Actionable Correction
Add sector-demeaned or sector-percentile versions of ROE/ROCE/margins, reusing the cross-sectional-rank pattern already implemented in `relative_strength.py`/`ownership_relative.py`.

---

### 📌 Finding #23: Inner OOF/tuning embargo is a row-count approximation, not a date-based gap — same file already fixed this for the outer split
- 🎯 Location: `src/server/ml_ensemble.py:2159-2163,2051-2055 (row-based effective_embargo)` vs. `:2255-2278 (date-based outer test/val fix, with an explicit comment documenting why the row-based approach failed there)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
`effective_embargo = min(embargo, len(X)//10)` and the `TimeSeriesSplit(gap=effective_embargo)` fed to Optuna operate on row position, using a global average rows/day. The file's own comment block documents that this exact approximation failed for the outer split ("a blind 10%-of-rows split can collapse to almost no calendar coverage whenever row density varies... immediately after a multi-week gap") and was fixed there by switching to date-based cuts — that fix was never propagated to the inner CV/tuning gap.

#### 2. Strategy & Benchmark Comparison
The already-fixed outer-split logic in the same file is the correct pattern; row-count-based purging is a known-fragile approximation whenever data density varies across dates (holidays, outages, partial universe).

#### 3. Root Cause & Impact
Near any fold boundary landing right after a sparse-data day, the row-based gap under-purges, letting overlapping-window rows leak across the OOF fold boundary — inflating the reported purged-OOF AUC by an amount that varies with how lumpy the data happens to be on a given run.

#### 4. Actionable Correction
Compute the inner embargo as an actual date offset (`dates >= boundary_date - horizon_days`), matching the outer split's already-fixed logic.

---

### 📌 Finding #24: `factor_edge.py` assumes a zero-lag same-close entry, inconsistent with the platform's own execution-timing convention
- 🎯 Location: `src/server/factor_edge.py:66 (_forward_returns, close.shift(-N)/close - 1)`, `:127-128 (same-date join)` vs. `src/server/outcome_resolver.py:290-305` ("PHASE 1 FIX" — enters at next trading day's open)
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
The forward-return construction buys at the same day's close the factor score is stamped with. `outcome_resolver.py` deliberately does not do this, entering at the next trading day's open specifically to avoid assuming a same-bar fill.

#### 2. Strategy & Benchmark Comparison
`outcome_resolver.py`'s next-open convention is the more realistic, already-adopted house standard for measuring achievable strategy performance.

#### 3. Root Cause & Impact
Not classic look-ahead (the forward window genuinely starts after the score date), but an execution-timing optimism — `factor_edge.py`'s rank-IC/hit-AUC/quantile-spread numbers (including the already-documented "Trendlyne m_score has no forward edge" finding) are measured against an unachievable fill price, modestly overstating any real factor's edge.

#### 4. Actionable Correction
Shift the base price for `fwd_N` to the next trading day's open, consistent with `outcome_resolver.py`, or explicitly document the one-day optimism as a known, accepted approximation if changing it is deferred.

---

## DIMENSION 4 — Benchmarking Against Proven Strategies

### 📌 Finding #25: The correctly-built Jegadeesh-Titman skip-month momentum factor is unused; the ranker runs on the naive, contamination-prone version instead
- 🎯 Location: `src/server/relative_strength.py:120-121 (naive rets = wide.pct_change(w))` — consumed by `unified_ranker.py:569-581` — vs. `src/server/multi_factor_scorer.py:79-89 (jt = r12m - r1m, correctly skip-month)` and `feature_engineering.py:102`, neither read anywhere by `unified_ranker.py`/`scoring_engine.py`; `multi_factor_scorer.py` is absent from `queues.ts`/`jobRegistry.ts` entirely
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
`relative_strength.py` computes momentum as plain trailing return over 21/63 days with no skip-month, then percentile-ranks it — this is the version the canonical ranker actually consumes. `multi_factor_scorer.py` implements the textbook-correct 12-month-minus-1-month momentum, explicitly citing Jegadeesh-Titman in its own docstring, but its output is never read by `unified_ranker.py`/`scoring_engine.py` and the script isn't even scheduled anywhere.

#### 2. Strategy & Benchmark Comparison
Jegadeesh-Titman (1993) cross-sectional momentum specifically skips the most recent month because 1-month reversal is a distinct, opposite-signed effect — mixing them in dilutes and can invert the momentum signal in the exact window it's most sensitive to.

#### 3. Root Cause & Impact
The `cs` engine's momentum signal is partly polluted by the short-term reversal effect it should isolate from, while the one component built correctly in this codebase sits completely unused and unscheduled.

#### 4. Actionable Correction
Either wire `multi_factor_scorer.py`'s `mf_momentum_score` into `unified_ranker.py`'s `engine_maps` (schedule the script in `queues.ts`/`jobRegistry.ts` first), or apply the same skip-month transform directly inside `relative_strength.py`'s momentum computation.

---

### 📌 Finding #26: No systematic mean-reversion factor anywhere in the portfolio-construction path
- 🎯 Location: `src/server/unified_ranker.py:59,61 (SUBCAT_MOD oscillator_reversal=0.85, candlestick_reversal=0.80)`, `:29 (CAT_BASE_WT technical_reversal=0.0396, smallest of any category)`, `:111 (BEAR regime further discounts it to 0.80x)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
The only "reversal" exposure in the system is third-party discretionary screener categories, explicitly down-weighted (multiplier < 1.0), not a quantitative factor the platform computes and treats as a counter-balancing signal.

#### 2. Strategy & Benchmark Comparison
Institutional multi-strategy books typically pair momentum/breakout exposure with an explicit short-term mean-reversion sleeve (Lehmann 1990 / Jegadeesh 1990 style 1-week contrarian sort) specifically to reduce correlation between sleeves and dampen momentum-crash tail risk.

#### 3. Root Cause & Impact
The book is structurally one-sided toward trend-following/breakout (breakout classifier weighted up to 0.15 in BULL); in a genuinely mean-reverting or choppy tape, nothing in the construction offsets over-concentration in the same momentum-crowded names that just spiked.

#### 4. Actionable Correction
Build an explicit cross-sectional short-term-reversal factor (e.g. 5-day return, inverse-ranked) inside `relative_strength.py` or a new module, wire it into `unified_ranker.py`'s `engine_maps` as a genuine counter-weight rather than a discounted discretionary category.

---

### 📌 Finding #27: Position sizing is correctly inverse-vol weighted, but has zero cross-position correlation control
- 🎯 Location: `src/server/unified_ranker.py:920-921 (raw_sizes = bet/vol)`, `:255-264 (bet_size_from_probability, correct López de Prado-style meta-labeling)`, `:267-272 (normalize_position_sizes — flat per-name cap + flat gross cap only)`, `:239-240 (MAX_POSITION=0.10, GROSS_EXPOSURE=1.0)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
The inverse-vol sizing and Gaussian-CDF bet-sizing are genuinely well-built. But `normalize_position_sizes()` applies only a flat per-name cap and a flat gross-exposure cap — no covariance matrix, no sector-correlation adjustment, no cross-position concentration check exists anywhere in the sizing code (confirmed via a full-tree grep for correlation/covariance patterns — only single-factor Nifty-beta was found, in `risk_metrics_engine.py`, which is market-beta, not inter-position correlation).

#### 2. Strategy & Benchmark Comparison
Risk parity by definition sizes positions to equalize *marginal contribution to portfolio variance*, which requires the covariance term — sizing purely on each position's own volatility, independent of how correlated the book's holdings are, is vol-scaling, not risk parity.

#### 3. Root Cause & Impact
10 independently-sized, "uncorrelated-by-assumption" names that are in reality 80%+ correlated (e.g. 10 IT-services stocks riding the same USD/INR and Nasdaq-ADR tailwind) can each approach the 10% cap simultaneously, producing effective single-factor exposure far above what the flat 100% gross cap implies.

#### 4. Actionable Correction
Add a sector/cluster exposure cap as a first approximation (cheap, no covariance matrix needed): sum position sizes by `sector` field (already tracked at `unified_ranker.py:738-744,975` but only used for display) and cap aggregate sector weight. A fuller fix would estimate a rolling covariance matrix and size via inverse-covariance weighting instead of pure inverse-vol.

---

### 📌 Finding #28: A correctly-built, orthogonal 5-factor model exists but is a dead branch — no factor-crowding check before capital is committed
- 🎯 Location: `src/server/multi_factor_scorer.py:8-45 (quality/momentum/value/risk-adj/macro, correctly weighted and orthogonal)` — not present in `unified_ranker.py`'s `engine_maps` (`screener, ml, cs, confluence, technical, dl, breakout`, verified by grep)
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
This is the most institutionally rigorous piece of code found in the review, but it isn't blended into, neutralized against, or used to check crowding for the live buy list — the canonical `unified_recommendations` composite blends 7 engines, several of which are themselves internally un-decomposed blends of dozens of third-party signals, with no step asking "is this stock's high score actually 80% one factor wearing a diversified-looking wrapper?"

#### 2. Strategy & Benchmark Comparison
Factor-investing practice (Fama-French) explicitly decomposes and monitors factor exposure per position specifically to catch and manage crowding risk before it becomes a portfolio-level tail event.

#### 3. Root Cause & Impact
Two stocks with an identical `unified_score` can have completely different, undisclosed factor concentration (one purely momentum-driven, one purely quality-driven), and the sizing logic can't tell — no factor-crowding check exists before capital is committed.

#### 4. Actionable Correction
Schedule `multi_factor_scorer.py`, persist its 5-factor breakdown per symbol, and add a crowding check to `unified_ranker.py` (e.g. flag/discount positions where >70% of the composite score traces to a single factor).

---

### 📌 Finding #29: A correct ATR chandelier trailing stop exists in offline label-generation code but never touches a live open position
- 🎯 Location: `src/server/exit_labeler.py:30,124-131` and `src/server/outcome_resolver.py:93,105-107,125-133` (correct, ratcheting chandelier stop) vs. `src/server/atrBarriers.ts:22-35,60-79` (single point-in-time stop, written once, never revisited) and `src/server/exit_policy.py:41-50,320-327` (static regressor prediction, not re-evaluated as the trade ages) — confirmed via a full-tree grep for `UPDATE ... SET stop_loss` outside the two label-generation modules, finding none
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
The backtest/label-generation code proves a proper trailing chandelier stop (`max(initial_stop, highest - chandelier_mult*ATR)`, ratcheting up, never below initial) is worth building — it's literally used to grade what a good exit policy would have captured. But no live-signal code path ever updates a stop after entry; `atrBarriers.ts` computes it once at signal creation and it's written once to `confluence_signals`/`recommendation_log`/`unified_signals`.

#### 2. Strategy & Benchmark Comparison
ATR-based volatility trailing exits are a standard institutional risk-management technique specifically because they lock in gains as a position runs, unlike a static stop that gives back the entire favorable move on a reversal.

#### 3. Root Cause & Impact
`exit_labeler.py`'s own docstring describes the exact failure mode this solves for offline grading ("a name that ran to +8% on day 2 and faded to +1% booked +1%") — but that giveback-protection is only applied to the backtest grader, never to money actually at risk in a live position.

#### 4. Actionable Correction
Add a scheduled job that re-evaluates open positions' stop levels using the same chandelier logic already proven in `exit_labeler.py`/`outcome_resolver.py`, updating `recommendation_log`'s stop_loss as the position ages and price advances favorably.

---

### 📌 Finding #30: No sector-concentration cap, drawdown-based de-risking, or consecutive-loss circuit breaker in the live sizing path
- 🎯 Location: `src/server/unified_ranker.py:267-272 (only per-name and flat gross cap)`, `:665-685 (_passes_rl_gate — per-symbol only, not book-level)`, `:738-744,975 (sector tracked but display-only)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
The only per-symbol track-record gate excludes a symbol whose own trailing 90-day average return is negative — it says nothing about the book's aggregate sector exposure, doesn't reduce size after a string of realized portfolio-level losses, and doesn't cap gross exposure to any one sector, despite `sector` being tracked per-symbol throughout.

#### 2. Strategy & Benchmark Comparison
Standard institutional risk controls include a hard sector/single-name concentration ceiling and a drawdown-triggered de-risking rule (reduce size after N consecutive losses or a realized drawdown threshold) — neither exists here at the book level.

#### 3. Root Cause & Impact
Nothing stops the ranker from allocating, say, 60% of gross exposure to Banking+NBFC names simultaneously if they all score well the same day (realistic given sector-correlated `rs_vs_sector`/screener membership), and nothing throttles size after a realized losing streak.

#### 4. Actionable Correction
Add a sector-exposure cap in `normalize_position_sizes()` and a book-level drawdown/losing-streak check (read recent `recommendation_log` outcomes, scale down `bet` globally when trailing realized performance breaches a threshold).

---

### 📌 Finding #31: Regime-conditional weighting is hand-set, never backtested — by the code's own admission
- 🎯 Location: `src/server/unified_ranker.py:130-141 (_load_regime_tilt_override docstring: "REGIME_CAT_TILT below is hand-set, never backtested... Fitting one properly is currently blocked by a real data gap")`, `:105-121 (regime tilt values)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Low

#### 1. Problem Description
Not a bug, but a candor gap worth flagging: the regime-tilt values (e.g. BULL overweighting `technical_breakout` 1.30x, CRASH underweighting to 0.30x) look empirically motivated but are intuition, in the same position `CATEGORY_WEIGHTS`/`SOURCE_WEIGHTS` were in before `strategy_optimizer.py` started fitting them from real outcomes.

#### 2. Strategy & Benchmark Comparison
`strategy_optimizer.py` already exists and does exactly this kind of empirical weight-fitting for other weight sets in this codebase — the same machinery should eventually apply here.

#### 3. Root Cause & Impact
An override hook exists (`app_settings.optimal_regime_cat_tilt`) but is unpopulated. Low severity today because the values are plausible and the hook already exists — this is a "close the loop" item, not an active bug.

#### 4. Actionable Correction
Once enough regime-labeled outcome history accumulates, extend `strategy_optimizer.py` to fit `REGIME_CAT_TILT` empirically and populate the existing override hook.

---

### 📌 Finding #32: Un-orthogonalized multiplicative score stacking can compound the same underlying factor repeatedly
- 🎯 Location: `src/server/scoring_engine.py:30-39 (apply_ml_score_adjustment, ×1.10)`, `:883-897 (beta adjustment, ×1.10)`, `:899-903 (sq_mult, up to ×1.4)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
Three independent multiplicative bonuses are applied with no check that they aren't all rewarding the same underlying momentum/trend exposure.

#### 2. Strategy & Benchmark Comparison
Factor-based scoring frameworks typically verify orthogonality between stacked adjustments before combining them multiplicatively, precisely to avoid this compounding.

#### 3. Root Cause & Impact
A stock that is bullish-ML *and* fighting a bear tide *and* carries a high-quality active setup stacks three independent multiplicative bonuses that may all be reflecting the same momentum factor rather than three orthogonal edges — final scores can overstate conviction for names where the underlying signals are correlated, not confirmatory.

#### 4. Actionable Correction
Add a factor-attribution step (can reuse `multi_factor_scorer.py` per Finding #28) that checks whether the ML/beta/quality bonuses are firing on genuinely different underlying signals before stacking them multiplicatively; consider capping the combined multiplier rather than allowing unbounded compounding.

---

## DIMENSION 5 — System Performance, Scalability & Memory Leaks

### 📌 Finding #33: Correlated-subquery "latest row per symbol" pattern duplicated in two files, scales with historical depth not universe size
- 🎯 Location: `src/server/confluenceEngine.ts:411-414`, `src/server/routers/misc.router.ts:265-267` (`getTradeDecisionCockpitData`)
- 🏷️ Category: Performance
- 🔴 Severity: High

#### 1. Problem Description
```sql
SELECT * FROM technical_signals WHERE date = (
  SELECT MAX(date) FROM technical_signals ts2 WHERE ts2.symbol = technical_signals.symbol
)
```
This correlated subquery re-executes once per outer row scanned, with no bounding `WHERE` on which rows it correlates against — every historical row in a multi-year-backfilled table triggers its own subquery execution.

#### 2. Strategy & Benchmark Comparison
The standard, single-pass alternative is `SELECT DISTINCT ON (symbol) * FROM technical_signals ORDER BY symbol, date DESC` (Postgres), or a pre-aggregated `GROUP BY` join.

#### 3. Root Cause & Impact
O(total_rows) subquery evaluations instead of O(distinct_symbols) — scales with historical depth, not universe size, so it silently gets slower every day more history accumulates, duplicated independently in two files.

#### 4. Actionable Correction
```sql
SELECT DISTINCT ON (symbol) *
FROM technical_signals
ORDER BY symbol, date DESC;
```

---

### 📌 Finding #34: Technical-signal scan loads the entire multi-year `stock_ohlcv` history every cycle
- 🎯 Location: `src/server/technicalSignalsService.ts:1147-1150`
- 🏷️ Category: Performance
- 🔴 Severity: High

#### 1. Problem Description
`SELECT ... FROM stock_ohlcv WHERE date <= ? ORDER BY symbol, date ASC` has no lower date bound — satisfied by every row back to 2021 (2.57M rows), while `detectSignals()` only needs ~200-250 trailing days per symbol.

#### 2. Strategy & Benchmark Comparison
A bounded window query (`date <= ? AND date >= ?`) is the standard pattern and is already used correctly elsewhere in this codebase for similar lookback needs.

#### 3. Root Cause & Impact
Every ~30-min technical-scan run (already gated to market hours) pulls the full multi-year table into Node memory to use only the last ~250 rows per symbol — an avoidable memory spike and DB transfer cost that grows every day history accumulates further.

#### 4. Actionable Correction
```ts
`SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv
 WHERE date <= ? AND date >= ? ORDER BY symbol, date ASC`,
[scanDate, subtractCalendarDays(scanDate, 300)]
```

---

### 📌 Finding #35: BullMQ jobs-status endpoint issues ~340 Redis round trips, polled every 3 seconds
- 🎯 Location: `src/server/routers/monitor.router.ts:441-515 (getBullMQJobsStatus, 34 queues × 10 calls each)`, `src/components/JobsDashboardPage.tsx:93-94 (refetchInterval: 3000)`
- 🏷️ Category: Performance
- 🔴 Severity: Medium

#### 1. Problem Description
For each of 34 hardcoded BullMQ queues, the endpoint issues 6 count calls + 4 job-list calls = 10 Redis round trips, all while the Jobs Dashboard tab is open and polling every 3 seconds.

#### 2. Strategy & Benchmark Comparison
Standard practice for a dashboard polling endpoint with non-trivial backend cost is either server-side caching with a TTL matched to how fast the underlying state actually changes, or a longer client poll interval.

#### 3. Root Cause & Impact
~340 Redis round trips every 3 seconds sustained while the tab is open — real Redis load amplification for data that doesn't change meaningfully faster than every 5-10 seconds.

#### 4. Actionable Correction
Cache the aggregate result server-side for 2-3s (`cacheService.ts`'s existing in-memory fallback pattern applies directly), or raise `refetchInterval` to 5000-10000ms.

---

### 📌 Finding #36: System-status monitor issues one DB query per monitored script, polled every 30 seconds
- 🎯 Location: `src/server/routers/monitor.router.ts:244-288 (getSystemStatus)`, `src/components/SystemMonitorPage.tsx:151-154`
- 🏷️ Category: Performance
- 🔴 Severity: Low

#### 1. Problem Description
`MONITOR_SCRIPTS.map(async s => {...})` issues one `dbGet()` per script (via a per-scriptId switch), parallelized but still N separate round trips for dozens of monitored scripts, every 30 seconds.

#### 2. Strategy & Benchmark Comparison
Most of the `getLastRunAt` cases are `SELECT MAX(col) FROM table [WHERE ...]` against a small fixed set of tables — several could be combined into fewer round trips via a single query per underlying table rather than per monitored script.

#### 3. Root Cause & Impact
Lower severity than Finding #35 (30s vs. 3s cadence), but the same batching principle applies and compounds as more scripts are monitored over time.

#### 4. Actionable Correction
Group `getLastRunAt`/`getScriptStats` calls by underlying table and issue one query per table returning all relevant script timestamps at once.

---

### 📌 Finding #37: `etMarketstatsSync.ts` issues ~83,000 individual sequential DB statements per sync run
- 🎯 Location: `src/server/etMarketstatsSync.ts:105-136`
- 🏷️ Category: Performance
- 🔴 Severity: High

#### 1. Problem Description
Inside one `dbTransaction`, a nested loop calls `tx.run(upsertStockSql, ...)` per record plus `tx.run(upsertMetricSql, metricRow)` per extracted metric — per the session notes this fetcher writes ~8,453 stock rows and ~74,934 metric rows per live run, i.e. ~83,000+ sequential statement executions.

#### 2. Strategy & Benchmark Comparison
This codebase already has a `bulkUpsert`/`rowGroups` helper in `dbBulk.ts`, used correctly elsewhere (`confluenceEngine.ts`) for exactly this multi-row-VALUES-INSERT pattern — this fetcher just doesn't use it.

#### 3. Root Cause & Impact
83,000 sequential round trips (even inside one transaction) is a large avoidable latency and lock-hold-duration cost on every sync run, on the same `mc_general_metrics` table other fetchers already write efficiently.

#### 4. Actionable Correction
Batch each screener's stock rows and metric rows into multi-row `INSERT ... VALUES (...),(...),... ON CONFLICT` calls via the existing `rowGroups()`/`bulkUpsert()` helpers.

---

### 📌 Finding #38: Two Python fetchers commit/insert per-row instead of batching
- 🎯 Location: `src/server/moneycontrol_fetcher.py:786-803 (_write_general_metrics, per-row INSERT loop, 3+ call sites)`, `src/server/financial_ratios_fetcher.py:376,400,468-489 (commits per row, ~4,000 commits/run for the full universe)`
- 🏷️ Category: Performance
- 🔴 Severity: Medium

#### 1. Problem Description
`moneycontrol_fetcher.py` loops row-by-row inside its own transaction rather than passing the full row list to one batched `conn.execute(stmt, list_of_dicts)` call. `financial_ratios_fetcher.py` calls `con.commit()` immediately after every single-row UPDATE/INSERT inside a per-stock loop covering the full ~2000+ stock universe.

#### 2. Strategy & Benchmark Comparison
`relative_strength.py` in the same codebase already does this correctly with a single `executemany()` call — the proven in-house pattern just wasn't applied to these two files.

#### 3. Root Cause & Impact
Several hundred to several thousand separate transaction commits/round trips per run, each forcing a separate fsync instead of amortizing over a batch.

#### 4. Actionable Correction
Accumulate rows into a list of param dicts and issue one `conn.execute(text(sql), rows)` (SQLAlchemy batches this) in `moneycontrol_fetcher.py`; commit every 50-100 symbols (or once at the end) in `financial_ratios_fetcher.py`, matching `relative_strength.py`'s pattern.

---

### 📌 Finding #39: `pythonRunner.ts`'s slot-wait timeout (3 min) is short relative to realistic legitimate contention (jobs up to 90 min)
- 🎯 Location: `src/server/pythonRunner.ts:19,34,41-42`
- 🏷️ Category: Performance
- 🔴 Severity: Low

#### 1. Problem Description
`MAX_PYTHON_CONCURRENT = 5`, `SLOT_WAIT_TIMEOUT_MS = 3 * 60_000`, while the file's own comment states the longest configured timeout across call sites is 90 minutes. With 40+ Python-invoking jobs and only 5 slots, a legitimate burst where jobs ahead in queue each run 10-90 minutes causes queued jobs to hard-fail after 3 minutes with a "slot likely leaked" error, even when nothing leaked.

#### 2. Strategy & Benchmark Comparison
This 3-minute value was deliberately tuned short specifically to catch a real slot-leak fast (previously caused 4h+ silent freezes, per CLAUDE.md history) — the tension is intentional, not an oversight, so this is flagged as a design trade-off worth revisiting now that the underlying leak (Finding: already-fixed `releasePythonSlot` counting bug) is resolved.

#### 3. Root Cause & Impact
Ordinary 5-slot contention among long-running scripts can now be converted into spurious job failures rather than graceful queuing, now that the original leak this timeout guarded against is fixed.

#### 4. Actionable Correction
Lengthen the wait timeout and rely on the existing `_slotHealthWatchdog` (which force-resets a stuck counter after >100min) as the leak-detection backstop instead of the short per-call wait timeout — this preserves fast leak detection without penalizing healthy contention.

---

### 📌 Finding #40: Duplicate single-column index on a high-write-volume table
- 🎯 Location: `db/schema.postgres.sql:2471-2472 (idx_tsig_sym and idx_technical_signals_symbol, both ON technical_signals(symbol))`
- 🏷️ Category: Performance
- 🔴 Severity: Low

#### 1. Problem Description
Two functionally identical indexes on the same single column of `technical_signals`, a table under heavy daily write load (grid-ensurer + every intraday scan).

#### 2. Strategy & Benchmark Comparison
Standard schema hygiene keeps exactly one index per functionally-equivalent access pattern to minimize write-amplification.

#### 3. Root Cause & Impact
Every INSERT/UPDATE/upsert into this table pays the write-amplification cost of maintaining a second, functionally identical index for zero query benefit.

#### 4. Actionable Correction
```sql
DROP INDEX idx_technical_signals_symbol;
```

---

### 📌 Finding #41: `signal_outcomes` has no composite index for its most common join
- 🎯 Location: `src/server/routers/ml.router.ts:591-596 (JOIN signal_outcomes so ON so.symbol=ts.symbol AND so.signal_date=ts.date)` vs. `db/schema.postgres.sql:1834-1836 (only single-column idx_sout_date, idx_sout_sym)`
- 🏷️ Category: Performance
- 🔴 Severity: Low

#### 1. Problem Description
Postgres can bitmap-AND the two single-column indexes, but a composite index would serve this join (and likely others hitting the same pair) directly and more efficiently.

#### 2. Strategy & Benchmark Comparison
Standard indexing practice adds a composite index matching the actual multi-column join/filter predicate once it's identified as a common access pattern.

#### 3. Root Cause & Impact
Lower query efficiency than necessary on a join that's used at least once in the ML reporting path; likely used elsewhere too.

#### 4. Actionable Correction
```sql
CREATE INDEX idx_sout_symbol_date ON signal_outcomes(symbol, signal_date);
```

---

---

# ROUND 2 — Extended Coverage

## DIMENSION 3 (continued) — Strategy, Portfolio & Reinforcement-Learning Engines

### 📌 Finding #42: `strategy_optimizer.py` computes an honest out-of-sample check, then writes weights regardless of the result
- 🎯 Location: `src/server/strategy_optimizer.py:176-263 (optimise)`, `:228-230 (overfit warning)`, `:409-443 (run, unconditional save_to_history/apply_to_scoring_engine)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Critical

#### 1. Problem Description
`optimise()` does a proper chronological 80/20 split and explicitly logs a warning when `optimised_test < baseline_test` ("likely overfit... Review before applying"). But `run()` unconditionally calls `save_to_history()`/`apply_to_scoring_engine()`, which writes straight into `app_settings.optimal_category_weights`/`optimal_source_weights` — read by `scoring_engine.py` at startup — with no gate on the holdout result.

#### 2. Strategy & Benchmark Comparison
`backtest_optimizer.py` in the same directory correctly blocks its `app_settings` write when the holdout fails constraints — that is the proven, already-working pattern one file away.

#### 3. Root Cause & Impact
The scoring engine's live category/source weights can be overwritten by an overfit optimization run with no safety net — directly analogous to Finding #17's "no promotion gate" pattern, but here for the weights that drive every score in the platform, not just one model's output. Escalated to Critical (vs. #17's High) because this affects `scoring_engine.py` globally, not one downstream engine.

#### 4. Actionable Correction
```python
if optimised_test_objective >= baseline_test_objective - TOLERANCE:
    save_to_history(...); apply_to_scoring_engine(...)
else:
    logger.error("Optimizer holdout regression — NOT applying new weights")
```
Apply the same gate to `compute_screener_overrides()` (line 269-331), which has the identical unconditional-write pattern for `screener_master.weight_override`.

---

### 📌 Finding #43: `mf_sector_flow_fetcher.py` overwrites every historical row's sector-flow feature with today's value — confirmed as a real code bug, not yet manifested in live data
- 🎯 Location: `src/server/mf_sector_flow_fetcher.py:332-362 (_update_technical_signals)`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Critical

#### 1. Problem Description
`_update_technical_signals` pulls every `(symbol, date)` row from `technical_signals` joined to `nse_stocks` for sector, then does `UPDATE technical_signals SET mf_sector_flow_pct = ? WHERE symbol = ? AND date = ?` for **every** historical date with the current month's flow value — no date filter, no COALESCE-once guard at all (worse than the `date.today()`-anchored `CASE WHEN` bugs found elsewhere, which at least attempt a guard).

#### 2. Strategy & Benchmark Comparison
Any point-in-time feature write must be bounded to the row(s) actually being computed for (`WHERE date >= <period start>`), the same discipline already applied correctly in `relative_strength.py`/`ownership_relative.py`.

#### 3. Root Cause & Impact — **live-verified, corrected from initial report**
Confirmed via a direct read-only query against the production Postgres DB: `SELECT COUNT(*) FROM technical_signals WHERE mf_sector_flow_pct IS NOT NULL` returns **0** — this column has never actually been populated in the live database (the fetcher has apparently never run to completion, or the column was reset). **This means the corruption described has not yet occurred in production** — but the code path is live and would corrupt every historical row for every symbol the first time this job runs successfully. Downgraded from "actively corrupting" to "will corrupt on first real run" — still Critical because it's a ticking, unguarded landmine directly consumed by `ml_ensemble.py:808` and `exit_policy.py:233`.

#### 4. Actionable Correction
```python
# Bound the UPDATE to only the period actually being computed:
cur.execute(
  "UPDATE technical_signals SET mf_sector_flow_pct = %s WHERE symbol = %s AND date >= %s",
  (value, symbol, period_start)
)
```
Fix before this fetcher is ever run to completion against production.

---

### 📌 Finding #44: Two Beta-Bernoulli/EMA weight-learning functions accumulate evidence forever with no processed-cursor, over-weighting recent outcomes and never decaying
- 🎯 Location: `src/server/reward_engine.py:121-191 (update_weights)`, `:194-323 (update_source_weights)`; `src/server/signal_type_priors.py:32-56 (update_priors_from_outcomes)`, driven by `src/server/online_learner.py:322-323`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
Both files reprocess the full trailing 180-day window of outcomes on every daily run with no high-water-mark of what was already folded in. `reward_engine.py` blends a freshly-recomputed average into an EMA every run, so a single resolved outcome re-enters ~180 consecutive daily EMA updates before falling off a cliff at the window boundary. `signal_type_priors.py` is worse: `priors[stype]['alpha'] += 1.0` is a pure accumulator with no window-based expiry at all — the same outcome adds +1 to alpha/beta on every one of ~180 daily runs after it resolves, and that evidence never leaves the posterior even after 180 days.

#### 2. Strategy & Benchmark Comparison
Standard online Bayesian updating processes each observation exactly once (track a processed-id cursor or increment only at first resolution); a rolling-window recompute-and-reblend approach without deduplication systematically over-weights recent history and never truly decays old evidence.

#### 3. Root Cause & Impact
Weights/posteriors are massively over-weighted toward recently-resolved outcomes and show an artificial discontinuity (`reward_engine.py`) or unbounded, ever-growing confidence (`signal_type_priors.py`) that permanently overstates certainty and freezes `get_posterior_mean()` against real drift.

#### 4. Actionable Correction
Persist a `last_processed_date`/processed-outcome-id set in both modules; fold each resolved outcome into the EMA/posterior exactly once, ever.

---

### 📌 Finding #45: `ml_signal_scorer.py` has no chronological row ordering for its CV, no promotion gate, and silently clobbers the canonically-gated `win_probability` column if run manually
- 🎯 Location: `src/server/ml_signal_scorer.py:49-73 (load_training_data, no ORDER BY)`, `:156 (cross_val_score with shuffle=False on unordered rows)`, `:172-205 (score_pending writes technical_signals.win_probability directly)`, `:235-238 (unconditional save_model)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
No `ORDER BY signal_date` anywhere before `cross_val_score(model, X, y, cv=5)` — `shuffle=False`'s fold contiguity is meaningless without guaranteed chronological order, so the reported CV AUC isn't a trustworthy walk-forward estimate. Separately, `run()` trains and unconditionally saves the model, then `score_pending()` writes straight into `technical_signals.win_probability` — the same column `ml_ensemble.py`/`online_learner.py` write under an enforced promotion bar (per Finding #17's already-flagged pattern).

#### 2. Strategy & Benchmark Comparison
Confirmed dormant (not wired into any `queues.ts` cron) — but nothing stops it from being run manually per its own docstring, at which point it would silently overwrite the canonical, gated `win_probability` with an ungated, non-time-validated model.

#### 3. Root Cause & Impact
A manual run of this script — plausible during ad hoc debugging or a well-intentioned "let me try improving win_probability" session — bypasses every promotion-gate protection this codebase has built elsewhere for the exact same column.

#### 4. Actionable Correction
Add the missing `ORDER BY signal_date`, wire in the same promotion-gate pattern as `ml_ensemble.py`, and consider having `score_pending()` write to a distinctly-named column (e.g. `ml_signal_scorer_probability`) rather than the shared canonical `win_probability` unless/until it's formally promoted to a scheduled, gated pipeline.

---

### 📌 Finding #46: `rl_agent.py`'s daily Q-update uses an exact-date match — a single missed cron run permanently drops that cohort's learning
- 🎯 Location: `src/server/rl_agent.py:326-337 (daily_update)`
- 🏷️ Category: Data Integrity / Quant Gap
- 🔴 Severity: Medium

#### 1. Problem Description
`WHERE date = ? AND reward IS NULL` matches only the exact `target_date = today - horizon_days`, not `<=`. If the daily cron doesn't run on precisely that day (holiday, an outage — this codebase has documented multi-day server outages), that cohort's `reward` stays `NULL` forever unless someone manually re-runs `--backfill` for the exact window.

#### 2. Strategy & Benchmark Comparison
Every other date-window query in this codebase already uses a catch-up (`<=` bounded by a max staleness) pattern for exactly this reason.

#### 3. Root Cause & Impact
Silent, permanent loss of one day's worth of Q-learning updates per missed cron run, with no error or alert — compounds quietly over the platform's documented history of multi-day outages.

#### 4. Actionable Correction
`WHERE date <= ? AND reward IS NULL` (bounded by a reasonable max staleness, e.g. 30 days, to avoid reprocessing ancient unresolved rows unexpectedly).

---

### 📌 Finding #47: `backtester.py`'s ASM/GSM filter uses today's live surveillance flag across the entire historical backtest window
- 🎯 Location: `src/server/backtester.py:473-488 (_load_surveillance_symbols)`
- 🏷️ Category: Data Integrity (Point-in-Time)
- 🔴 Severity: High

#### 1. Problem Description
`SELECT symbol FROM nse_stocks WHERE is_asm=1 OR gsm_stage>0` reads the **current** flag and applies it to filter every historical signal for that symbol across the whole backtest window — not just the dates it was actually under surveillance.

#### 2. Strategy & Benchmark Comparison
This is the same point-in-time discipline the 2026-07-17 look-ahead audit already fixed for other ASM/GSM consumers in this codebase — a live flag applied retroactively is exactly the bug class that audit targeted.

#### 3. Root Cause & Impact
A stock's entire multi-year trade history is excluded from backtesting because it happens to be under ASM/GSM as of the day the backtest is *run* (reverse-survivorship bias), while a now-clean stock's historically-restricted period is never excluded, letting the backtest simulate trades the exchange wouldn't have allowed at the time.

#### 4. Actionable Correction
Source point-in-time ASM/GSM history (a dated table, if one exists elsewhere in the ASM/GSM fetcher pipeline; otherwise this needs to be built) rather than joining against the live flag.

---

### 📌 Finding #48: `intraday_ranker.py` sizes same-day, forced-close trades using a probability calibrated for a 10-trading-day horizon
- 🎯 Location: `src/server/intraday_ranker.py:407`, cross-referenced against `src/server/breakout_classifier.py` (calibrates P(≥6% move over next 10 trading days))
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
`bet = bet_size_from_probability(r["breakout_prob"]) * tilt` sizes same-day trades (forced closed by 15:30 IST, ATR target capped 0.8%-5%) using a probability statistically calibrated for a 6% move over 10 trading days — a materially longer horizon and larger move than what the trade can actually realize.

#### 2. Strategy & Benchmark Comparison
`unified_ranker.py`'s reuse of the same probability for multi-day positional sizing is a reasonable horizon match; the intraday reuse is not — position sizing should be calibrated to the actual edge and risk of the specific holding period being traded.

#### 3. Root Cause & Impact
Same-day position sizes import conviction from a statistical claim about a different, longer-horizon, larger-move event — the size is not calibrated to the real intraday edge/risk being taken.

#### 4. Actionable Correction
Use `live_screener_ml_ranker.py`'s same-day-calibrated win-probability model (already built and live per CLAUDE.md) for intraday sizing instead of the 10-day breakout probability.

---

### 📌 Finding #49: `signal_outcomes`'s two writers use incompatible WIN/LOSS thresholds with no way to distinguish them
- 🎯 Location: `src/server/confluence_outcome_tracker.py:99 (flat ±2% threshold, all 5 horizons, no STOP_LOSS concept)` vs. `src/server/outcome_resolver.py` (~±1% threshold + explicit STOP_LOSS/TRAILING_STOP detection)
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
Both write into the shared `signal_outcomes` table, but with different, incompatible labeling methodologies and no column distinguishing which writer produced a given row — a 1-day +2.1% move and a 30-day +2.1% move (statistical noise at that horizon) are both labeled "WIN" by one writer, while the other correctly discriminates.

#### 2. Strategy & Benchmark Comparison
A shared outcome-label table consumed uniformly by `rl_agent.py`, `reward_engine.py`, `strategy_optimizer.py`, and every ML training script needs one consistent labeling methodology, or every consumer silently trains on a mixture of two different definitions of "WIN."

#### 3. Root Cause & Impact
Every downstream consumer of `signal_outcomes` is implicitly training on inconsistently-labeled data with no way to filter by methodology.

#### 4. Actionable Correction
Add a `label_source`/`methodology` column to `signal_outcomes`, and align `confluence_outcome_tracker.py`'s threshold logic with `outcome_resolver.py`'s (or explicitly document and gate consumers to filter by source if the two are meant to coexist).

---

### 📌 Finding #50: `performance_tracker.py` doesn't dedupe Nifty benchmark rows across symbol aliases, unlike its sibling
- 🎯 Location: `src/server/performance_tracker.py:91-101 (load_nifty_returns)` vs. `src/server/backtester.py`'s `load_nifty()` (explicitly dedupes)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Low

#### 1. Problem Description
Pulls rows for all 4 `NIFTY_SYMBOLS` aliases and indexes by date with no `.drop_duplicates('date')`, unlike the already-correct sibling in `backtester.py`.

#### 2. Strategy & Benchmark Comparison
The already-fixed sibling function is the proven correct pattern.

#### 3. Root Cause & Impact
If more than one alias has an overlapping date row, `.pct_change()` computes returns across a duplicated/misaligned index, corrupting every `alpha_vs_nifty` figure persisted to `strategy_performance`.

#### 4. Actionable Correction
Add `.drop_duplicates('date')` (or a `GROUP BY`/dedup at the SQL level) matching `backtester.py`'s pattern.

---

## DIMENSION 1 & 3 (continued) — F&O, Options & Macro Fetchers

### 📌 Finding #51: Max-pain formula has call/put open interest swapped
- 🎯 Location: `src/server/mc_index_oi_fetcher.py:181-184`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
```python
total_loss += max(0.0, settlement - s) * pe_oi   # comment says "CE writers lose" but weights by PUT oi
total_loss += max(0.0, s - settlement) * ce_oi    # comment says "PE writers lose" but weights by CALL oi
```
Call-side loss (settlement > strike) should be weighted by call OI, put-side loss by put OI — the code does the opposite.

#### 2. Strategy & Benchmark Comparison
Standard max-pain calculation sums, at each candidate settlement price, the total intrinsic-value loss option writers would incur, weighted by the OI of the *side that would actually be in-the-money* — verified this codebase implements it correctly in 3 other places (`pcr_fetcher.py` twice, `nt_oi_snapshot_fetcher.py`), confirming this is an isolated transcription error, not a considered variant.

#### 3. Root Cause & Impact
Every `index_max_pain` row for Nifty/BankNifty (feeds index/F&O intelligence panels users may act on) reports a max-pain strike computed from the wrong OI side — a directly user-facing wrong number.

#### 4. Actionable Correction
```python
total_loss += max(0.0, settlement - s) * ce_oi   # call writers lose when settlement > strike
total_loss += max(0.0, s - settlement) * pe_oi   # put writers lose when settlement < strike
```

---

### 📌 Finding #52: Options-chain Greeks parsed by hardcoded column position, never validated against the API's own header — the same architectural bug class that already corrupted 2.1M rows once in this codebase
- 🎯 Location: `src/server/so_option_chain_fetcher.py:52-65,123-146`
- 🏷️ Category: Data Integrity
- 🔴 Severity: High

#### 1. Problem Description
`_COL` hardcodes 20+ field-to-index mappings into Trendlyne's `tableData` array. The file's own comment says these positions come from `tableHeaders`/`unique_name`, but the code never actually reads `body.get("tableHeaders")` to confirm the layout matches — it trusts fixed indices unconditionally.

#### 2. Strategy & Benchmark Comparison
This is architecturally identical to the already-documented `trendlyne_screener_discovery.py` "blind column 0" bug that silently corrupted ~2.1M rows across 7 tables for its entire life before anyone checked the shape of a live response against the actual code.

#### 3. Root Cause & Impact
A Trendlyne column reorder would silently swap Delta/Gamma/Theta/Vega/OI/IV across every F&O stock's option chain with no error — the exact failure mode this codebase already learned costs the most when discovered late.

#### 4. Actionable Correction
Read `tableHeaders`/`unique_name` at runtime and build the index map dynamically, or at minimum assert the header list matches the expected order before parsing and fail loudly on mismatch.

---

### 📌 Finding #53: A DB read failure silently narrows the F&O universe from ~215 symbols to a hardcoded 10, with the job still exiting 0
- 🎯 Location: `src/server/so_option_chain_fetcher.py:90-98 (_get_fno_symbols)`, `:237-241 (fallback list)`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
A transient DB error in `_get_fno_symbols()` returns `[]`, silently indistinguishable from `run()`'s fallback path to a hardcoded 10-symbol list — the job still prints `ok=N fail=0` and exits 0.

#### 2. Strategy & Benchmark Comparison
A real query failure should never be indistinguishable from "no F&O stocks configured" — standard practice logs and alerts distinctly for each.

#### 3. Root Cause & Impact
A transient DB blip silently narrows a full-universe daily fetch to 10 symbols with zero visibility that ~205 symbols were never even attempted.

#### 4. Actionable Correction
Log the exception explicitly and distinguish "DB error, using emergency fallback list" from "no eligible symbols" in the job's exit status/alerting.

---

### 📌 Finding #54: Day-over-day OI-delta feature breaks across every expiry rollover
- 🎯 Location: `src/server/oi_delta_features.py:7-14,32-44`, cross-referenced with `src/server/pcr_fetcher.py`'s docstring (confirms `total_call_oi`/`total_put_oi` are actually nearest-expiry-only, mislabeled "total")
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`compute_oi_delta` diffs day-over-day OI columns that are actually nearest-expiry-only (per `pcr_fetcher.py`'s own docstring: "NiftyTrader's default... returns only the NEAREST expiry, so near-expiry OI equals total OI").

#### 2. Strategy & Benchmark Comparison
A correct rollover-aware feature either gates off on expiry-transition days or sources a genuine all-expiries OI aggregate.

#### 3. Root Cause & Impact
On every weekly/monthly rollover, the nearest-expiry contract switches to a fresh one with near-zero OI, producing a large spurious `oi_net_change_pct` swing that reflects contract rollover, not real position buildup/unwinding — this feeds `technical_signals.oi_net_change_pct` directly into ML features.

#### 4. Actionable Correction
Gate the feature off (or flag it) on `is_expiry_day`+1 using the existing `expiry_features.py` flag, or source a true all-expiries OI aggregate.

---

### 📌 Finding #55: Inconsistent retry/failure-signaling within the same file — the GEX/dealer-gamma path bypasses the file's own already-fixed pattern
- 🎯 Location: `src/server/pcr_fetcher.py:373-381,429-436 (fetch_symbol_niftytrader, correct: retry_get + FetchTracker)` vs. `:199-207,525-534 (_mc_get/fetch_nifty_gex/run_nifty_gex, raw session.get, no tracker, no failure signal)`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
The per-symbol path correctly retries and tracks failures; the `--gex` path (writing `NIFTY_GEX`/dealer-gamma-regime to `macro_asset_prices`) uses raw `session.get()` with no retry and `run_nifty_gex()` never signals failure, just prints "GEX fetch failed" and returns normally.

#### 2. Strategy & Benchmark Comparison
The fixed pattern exists one function away in the same file — this is an incomplete rollout, not a missing capability.

#### 3. Root Cause & Impact
A NiftyTrader blip silently stops the regime-relevant GEX signal from updating with zero alerting; a `queues.ts` `.catch(...)` call site additionally swallows any thrown error.

#### 4. Actionable Correction
Route `_mc_get`/`fetch_nifty_gex` through the already-imported `retry_get`, and have `run_nifty_gex()` raise/exit non-zero on failure.

---

### 📌 Finding #56: `fno_rollover_fetcher.py` conflates transient failures with holidays in logs, and has no NSE holiday calendar for its trading-day lookback
- 🎯 Location: `src/server/fno_rollover_fetcher.py:110-124,248-290 (holiday/error conflation)`, `:99-107 (_trading_days_back, treats every Mon-Fri as a trading day)`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Low

#### 1. Problem Description
Any exception (connection reset, 5xx, DNS blip) is caught by the same generic handler that also handles the legitimate "404 = holiday, not yet published" case, both logged identically. Separately, `_trading_days_back` has no NSE holiday awareness, so `--days 30` silently returns fewer than 30 real trading days whenever a holiday falls in range.

#### 2. Strategy & Benchmark Comparison
Distinguishing a genuine holiday from a real fetch failure requires checking against an actual NSE holiday calendar (which this codebase already has elsewhere, per the BSE-holiday-aware market-status work in `intraday_pipeline_2026_07_12` memory), not inferring it from an HTTP 404.

#### 3. Root Cause & Impact
`main()` never checks `total_rows` and never exits non-zero even if every date in a backfill failed for a real (non-holiday) reason — a genuine outage looks identical to a normal holiday-skip in logs.

#### 4. Actionable Correction
Cross-check 404s against the existing holiday-calendar helper before classifying as "holiday, not an error"; track and report a real failure count separate from holiday-skips.

---

### 📌 Finding #57: A total sync failure across all 3 sub-syncs still exits 0, cascading stale expiry data into two downstream files
- 🎯 Location: `src/server/sync_nt_fno_symbols.py:59-69,184-190`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
`_fetch()` has no retry wrapper; any exception returns `None`, and each of the 3 sub-syncs (`sync_index_map`/`sync_fno_symbols`/`sync_fno_expiries`) just returns 0 on a `None` result — `sync()` prints `Indices=0 Stocks=0 Expiries=0` and exits 0 regardless.

#### 2. Strategy & Benchmark Comparison
Same silent-failure class fixed elsewhere via `FetchTracker` — should exit non-zero when all sub-syncs return 0.

#### 3. Root Cause & Impact
`nt_fno_expiry` (written only by `sync_fno_expiries`) is the sole upstream feed for both `expiry_features.py` and `so_option_chain_fetcher.py`'s `_get_nearest_expiry` — a silent outage here cascades stale/fallback expiry data into two other files with no error surfaced anywhere.

#### 4. Actionable Correction
Exit non-zero when all 3 sub-sync counts are 0; adopt `retry_get` in `_fetch()`.

---

### 📌 Finding #58: Unguarded division crashes the entire quant-momentum batch on one bad symbol
- 🎯 Location: `src/server/institutional_quant_engine.py:81-82`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`sma200_dist = (last / sma200 - 1) * 100` has no guard for `sma200 == 0`, and the per-symbol loop calling it has no try/except.

#### 2. Strategy & Benchmark Comparison
This codebase has documented, recurring OHLCV data-quality incidents that produce exactly this kind of all-zero-close row; any per-symbol loop over a large universe needs isolation so one bad row doesn't kill the whole run.

#### 3. Root Cause & Impact
A single symbol with an all-zero close window throws an uncaught `ZeroDivisionError`, aborting `quant_scores` computation for every symbol that day, not just the bad one.

#### 4. Actionable Correction
Guard `sma200 > 0` (set `None` otherwise); wrap the per-symbol body in try/except so one bad row doesn't abort the batch.

---

### 📌 Finding #59: 4 NiftyTrader-family fetchers have no retry/backoff and no aggregate failure signaling
- 🎯 Location: `src/server/nt_change_oi_fetcher.py:78-89,130-148`, `src/server/nt_oi_snapshot_fetcher.py:88-99`, `src/server/nt_pcr_ts_fetcher.py:83-98`, `src/server/nt_vix_fetcher.py:~54`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Low

#### 1. Problem Description
All four make raw `requests.get()` calls with no `retry_get`/`FetchTracker` adoption (present in the same directory), and none check aggregate success or exit non-zero on total failure.

#### 2. Strategy & Benchmark Comparison
Same rollout gap already identified systemically (Finding #3) — these 4 are additional concrete instances.

#### 3. Root Cause & Impact
Same silent-failure class — "0 rows saved" and normal exit regardless of whether it's a real outage or a quiet day.

#### 4. Actionable Correction
Adopt `retry_get`/`FetchTracker` uniformly across the NT-family fetchers.

---

## DIMENSION 1 & 3 (continued) — NLP, Earnings & Insider Fetchers

### 📌 Finding #60: Earnings-surprise features are anchored to fiscal period-end date, not the actual result-announcement date — a confirmed look-ahead leak
- 🎯 Location: `src/server/earnings_surprise_fetcher.py:101-109,132,172 (_period_to_date stores fiscal period-end)`, `src/server/earnings_beat_features.py:46 (WHERE quarter_date <= :as_of)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Critical

#### 1. Problem Description
Neither MC endpoint used here (`earning-forecast`, `hits-misses`) exposes an actual announcement date — confirmed by reading both payload shapes. `_period_to_date` converts MC's period label into the fiscal-period-end date and stores it as `quarter_date`. `earnings_beat_features.py` then treats anything with `quarter_date <= as_of` as "known" when computing `eps_beat_last_q`, `eps_beat_streak_4q`, `eps_surprise_last_yr`, `eps_estimate_dispersion` into `technical_signals`.

#### 2. Strategy & Benchmark Comparison
SEBI allows Indian companies up to 60 days after fiscal year-end to report Q4/annual results — the market cannot know a beat/miss until the actual announcement, which can be 30-60+ days after the period-end date used here.

#### 3. Root Cause & Impact
Systematic look-ahead into every consumer of these `technical_signals` columns (`ml_ensemble.py`, `scoring_engine.py`, etc.) for any signal-date between period-end and true announcement — exactly the leakage class the audit was commissioned to find, here confirmed with a concrete mechanism.

#### 4. Actionable Correction
Capture the real announcement date from MC's earnings calendar/BSE announcement feed and anchor on that; until available, apply a conservative lag (45-60 days) to `quarter_date` before treating it as "known," mirroring `et_stats_client.py`'s existing `PUBLICATION_LAG_DAYS` pattern used elsewhere in this codebase.

---

### 📌 Finding #61: `working_capital_fetcher.py` omits the mandatory `fallback` argument its own shared helper requires
- 🎯 Location: `src/server/working_capital_fetcher.py:205` vs. `financial_ratios_fetcher.py:385` (correctly passes `fallback=today`), `et_stats_client.py:48-67` (docstring mandates every caller pass a last-completed-trading-session fallback)
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
`floor = as_of_floor(features.get("year_ending"))` omits the `fallback` argument that `et_stats_client.py`'s own docstring says every caller must pass — this is the same fetcher class that already caused the 2026-07-25 `date.today()`-anchor corruption in 6 sibling files.

#### 2. Strategy & Benchmark Comparison
`financial_ratios_fetcher.py`'s call site in the same shared-helper family is the correct, already-fixed reference pattern.

#### 3. Root Cause & Impact
Today's practical risk is low (a separate filter already screens unparseable `yearEnding` before reaching this code), but there's no structural guarantee against a future response-shape change hitting the fallback path — when it does, the `ELSE NULL` branch will null all 5 working-capital columns for every `technical_signals` row of that symbol on any non-trading-day run.

#### 4. Actionable Correction
`floor = as_of_floor(features.get("year_ending"), fallback=<last completed trading session>)`.

---

### 📌 Finding #62: `insider_features.py` uses an unverified date field from a scraped widget, bypassing the platform's own hardened official insider-data pipeline
- 🎯 Location: `src/server/insider_features.py:30-43` (uses `insider_trades.date`, populated by `moneycontrol_fetcher.py`'s `_parse_insider` HTML scrape) vs. `insider_transactions_fetcher.py` (official NSE PIT filings, already hardened for this exact date-class bug)
- 🏷️ Category: Data Integrity (unverified, flagged not confirmed)
- 🔴 Severity: Medium

#### 1. Problem Description
`insider_buy_pct_90d`'s 90-day window is keyed on `insider_trades.date`, sourced from MC's `mcinsider` widget HTML (`br_date` field) — nothing in the scraper documents whether this represents the actual trade date or a reporting/disclosure date.

#### 2. Strategy & Benchmark Comparison
This codebase already has a more rigorous, official pipeline (`insider_transactions_fetcher.py`, NSE PIT filings) that was previously hardened for exactly this class of bug; `insider_features.py` reads from the less-scrutinized scraped table instead.

#### 3. Root Cause & Impact
NSE/BSE insider-disclosure rules allow a multi-day filing window after the actual trade — if `br_date` is the trade date (unverified), counting by it leaks pre-disclosure information into `insider_buy_pct_90d`.

#### 4. Actionable Correction
Verify via a live widget fetch which date `br_date` represents; if trade date, either add a disclosure-lag buffer or switch `insider_features.py` to read the already-official `insider_transactions` table instead.

---

### 📌 Finding #63: Retry/backoff gap confirmed across 6 more NLP/earnings/corporate-action fetchers
- 🎯 Location: `src/server/block_deal_fetcher.py:109-140`, `delivery_trend_fetcher.py:178-190`, `delivery_volume_fetcher.py:88-98`, `mc_corporate_calendar_fetcher.py:79-89`, `analyst_estimates_snapshot.py:130-139`, `tickertape_client.py:63-75`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
None of these 6 import `fetch_utils.py`'s `retry_get`/`FetchTracker`; a single-attempt HTTP call wrapped in a bare `except Exception` returns `[]`/`None`/`{}` on any transient failure. `block_deal_fetcher.py` and `mc_corporate_calendar_fetcher.py` additionally can't distinguish "0 records today" from "fetch failed" in their exit status.

#### 2. Strategy & Benchmark Comparison
Same rollout gap as Finding #3 — `earnings_surprise_fetcher.py` (audited in the same cluster) is a positive counter-example with adequate retry+backoff of its own.

#### 3. Root Cause & Impact
Any transient network blip produces "0 records, job exits 0," indistinguishable from a genuine no-data day.

#### 4. Actionable Correction
Adopt `retry_get`/`FetchTracker` uniformly across the 6 files.

---

## DIMENSION 1 & 5 (continued) — Remaining OHLCV / Technical / Sector Fetchers

### 📌 Finding #64: Three more fetchers copy the `date.today()`-anchored NULL-everything write guard that was supposedly fixed platform-wide
- 🎯 Location: `src/server/mc_pricefeed_fetcher.py:423-442`, `src/server/mc_chart_patterns_fetcher.py:233-239`, `src/server/nt_dashboard_fetcher.py:217-223` — the latter two literally cite `mc_pricefeed_fetcher.py`'s pattern in their own docstrings as what they copied
- 🏷️ Category: Data Integrity
- 🔴 Severity: Critical

#### 1. Problem Description
All three anchor their `date >= ? THEN COALESCE(...) ELSE NULL` write guard on `today = date.today().isoformat()` — the identical bug class fixed in 6 sibling fetchers on 2026-07-25, but never propagated here, and in fact actively copied *after* the fix existed (per the docstring citations). CLAUDE.md documents a "closed-day-early-batch dispatcher" that deliberately runs jobs on closed days — exactly the condition that triggers this guard's failure mode.

#### 2. Strategy & Benchmark Comparison
The already-fixed 6 sibling fetchers anchor to the last completed trading session (or `MAX(date)` per symbol); that is the proven correct pattern that should have propagated here.

#### 3. Root Cause & Impact — **partially live-verified**
If `technical_signals` has zero rows with `date >= today` for a symbol when the job runs, the `ELSE NULL` fires for every existing historical row, wiping years of `mc_cagr_3y/5y/10y`, `mc_ind_pe`, `mc_consensus_pe/pb`, `mc_del_pct_*`, `mc_cp_bull/bear_count`, `nt_max_pain_dist_pct`, etc. Live query confirms these columns are populated at very low rates platform-wide today (`mc_cagr_3y`: 3.3% non-null, `mc_ind_pe`: 4.2%, `nt_max_pain_dist_pct`: 0.4% of all `technical_signals` rows) — **consistent with, but not conclusive proof of,** this bug actively nulling history; low population could also stem from the fetcher simply not having covered most symbol/date combinations yet. This distinction matters and was not fully resolved — see Risks.

#### 4. Actionable Correction
Anchor all three to the last completed trading session (or `MAX(date)` per symbol) via the shared `as_of.py` helper, matching the 6 already-fixed sibling fetchers; then re-run the live null-rate query above after the fix to see whether population rates rise (supporting the corruption theory) or stay flat (supporting the "just sparse coverage" explanation).

---

### 📌 Finding #65: A latest-snapshot-only table is being used to backfill historical `technical_signals` rows, leaking today's data into the past
- 🎯 Location: `src/server/extra_features_parser.py:99-127 (run)`, cross-referenced with `src/server/extra_endpoints_fetcher.py:62-71` (confirms `extra_endpoint_responses` is DELETE+INSERT'd, holding only the latest snapshot, never history)
- 🏷️ Category: Data Integrity (Point-in-Time)
- 🔴 Severity: High

#### 1. Problem Description
`extra_endpoint_responses` has `PRIMARY KEY (symbol, endpoint_name)` and only ever holds the latest live snapshot. `run()`'s fallback ("no rows for target_date → use most recent existing date instead") and its documented `--date <past date>` backfill mode both write this current-only snapshot onto a historical `technical_signals` row.

#### 2. Strategy & Benchmark Comparison
A snapshot-only table with no history cannot correctly backfill a point-in-time feature for a past date — the whole premise of a backfill is that it reconstructs what was true then, which this table structurally cannot supply.

#### 3. Root Cause & Impact
Look-ahead leak in `ext_fii_holding_pct`, `ext_t80_tech_score`, `ext_mojo_quality_rank`, etc. — all consumed by `ml_ensemble.py:940-948`.

#### 4. Actionable Correction
Don't backfill from a snapshot table with no history; only write onto the row for the date the snapshot was actually fetched, and skip (don't fabricate) historical backfill for these specific columns until a historized source exists.

---

### 📌 Finding #66: `mc_chart_patterns_fetcher.py`'s `ensure_schema()` is stale and would create the wrong table shape on a fresh database
- 🎯 Location: `src/server/mc_chart_patterns_fetcher.py:61-94 (ensure_schema)` vs. `:178-198 (upsert_patterns)` vs. the actual live schema (`db/schema.postgres.sql:1094-1118`, `db.ts:702`)
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
`ensure_schema()` declares `sl_price`/`sl_pct` and `PRIMARY KEY (pattern_id)` with no `mcsymbol` column, but `upsert_patterns()` INSERTs `mcsymbol`, `stoploss_price`, `stoploss_pct` with `ON CONFLICT(mcsymbol, pattern_id)`. Verified against the real schema: the live table matches the INSERT (has `mcsymbol`, `stoploss_price`, `stoploss_pct`, PK `id`), not `ensure_schema()`.

#### 2. Strategy & Benchmark Comparison
`CREATE TABLE IF NOT EXISTS` should describe the actual live shape so a fresh DB (new dev SQLite, CI, disaster-recovery restore) creates a working table, consistent with how schema definitions are meant to function as documentation-as-code.

#### 3. Root Cause & Impact
Harmless today only because the live table already exists correctly and `IF NOT EXISTS` no-ops — but on any fresh DB, the first upsert would crash with "column mcsymbol does not exist."

#### 4. Actionable Correction
Make `ensure_schema()` match `db/schema.postgres.sql` exactly, or remove it in favor of the migration-managed schema (this codebase now has `node-pg-migrate` per the 2026-07-24 Phase 1 rebuild work).

---

### 📌 Finding #67: `hv_features.py`'s historical volatility backfill has no upper date bound — future data leaks into a past backfilled row
- 🎯 Location: `src/server/hv_features.py:112-129 (run)`
- 🏷️ Category: Data Integrity (Point-in-Time)
- 🔴 Severity: High

#### 1. Problem Description
The OHLCV read (`WHERE date >= ?`) has a lower bound but no upper bound. Only the write side filters which symbols get updated for a target backfill date — the feature computation itself uses all OHLCV through today regardless of the target date.

#### 2. Strategy & Benchmark Comparison
Any point-in-time backfill must bound its input data to `<= target_date`, exactly as this codebase does correctly elsewhere (e.g. the `as_of.py` helper's design intent).

#### 3. Root Cause & Impact
Backfilling HV for a past date computes `hv_10d/20d/30d/60d`/`iv_hv_ratio` using OHLCV through today, including dates after the target date — future realized-volatility leaks into a historical `technical_signals` row whenever `--date` is used for backfill.

#### 4. Actionable Correction
Bound the OHLCV read with `date <= <target_date>` as well as the existing lower bound.

---

### 📌 Finding #68: A Postgres-only SQL cast embedded directly in a query would crash outright on the SQLite dev-fallback path
- 🎯 Location: `src/server/backfill_technical_features.py:161 ((so.signal_date::date - interval '3 days')::text)`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
Hardcoded Postgres cast syntax (`::date`, `::text`) is not valid SQLite and isn't rewritten by `db_compat.py`'s `translate()`, which only converts SQLite-style syntax to Postgres, not the reverse — this script would crash outright against the SQLite dev-fallback path.

#### 2. Strategy & Benchmark Comparison
The rest of the codebase writes portable `date(col,'modifier')` syntax specifically so the translator can convert it per-dialect — this file bypasses that convention.

#### 3. Root Cause & Impact
Breaks the documented SQLite dev-fallback path for anyone running this script without `USE_POSTGRES=true`.

#### 4. Actionable Correction
Use the shared `as_of.py`/SQLite-portable date arithmetic pattern instead of raw Postgres casts.

---

### 📌 Finding #69: `sql_translate.py`'s `date()` regex can silently produce a wrong (not failing) result for a nested-function argument
- 🎯 Location: `src/server/sql_translate.py:118-119 (map_sqlite_functions)`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Low

#### 1. Problem Description
The regex `\bdate\(\s*([^'\")][^)]*?)\s*\)` is non-greedy and stops at the first `)` inside the argument — for `date(func(x) + 1)` it produces `(func(x)::date + 1)` instead of `(func(x) + 1)::date`, a silently different, wrong value rather than a syntax error.

#### 2. Strategy & Benchmark Comparison
The file's own `_cast_round_numeric` function already implements proper paren-depth tracking for a similar transform — that's the correct pattern this regex should follow.

#### 3. Root Cause & Impact
Currently latent (a repo-wide grep found no live call site with this exact nested-function shape today), but it's a live landmine for any future `date(...)` call with that shape — and per the audit's framing, a wrong-result-with-no-error is a worse failure mode than a crash.

#### 4. Actionable Correction
Make the paren-scan depth-aware (track nesting depth like `_cast_round_numeric` already does) instead of stopping at the first `)`.

---

### 📌 Finding #70: `dl_engine.py`'s LSTM training path has no promotion gate — the 4th confirmed instance of this pattern
- 🎯 Location: `src/server/dl_engine.py:560-565 (train_lstm, --mode train)`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
`cfg["lstm_version"] = args.version; _save_config(cfg)` unconditionally promotes the just-trained model to the version `run_inference()` loads next — no comparison against the previously-active model's walk-forward metrics, no backup of the prior config.

#### 2. Strategy & Benchmark Comparison
`ml_ensemble.py`'s promotion pattern (a required CV-AUC improvement bar plus a timestamped backup of the previous model) is the already-proven correct pattern in this same codebase.

#### 3. Root Cause & Impact
A regression in the new BiLSTM (bad batch, NaN fold, unlucky init) goes to production automatically — this is the 4th confirmed instance of the "no promotion gate" pattern across this audit (alongside `confluence_ml_engine.py`, `cs_ranker.py`, `online_learner.py`), suggesting it's a systemic gap in this codebase's MLOps discipline, not an isolated oversight.

#### 4. Actionable Correction
Gate on `walk_forward_validate`'s metrics beating the currently-active version before writing the config, mirroring `ml_ensemble.py`'s bar + timestamped backup.

---

### 📌 Finding #71: Several fetchers still use per-row insert loops rather than batch/`executemany`
- 🎯 Location: `src/server/factor_breakdown_snapshot.py:48-58`, `src/server/mc_chart_patterns_fetcher.py:176-197`, `src/server/backfill_technical_features.py:244-259`, `src/server/screener_ohlcv_backfill.py:77-94`
- 🏷️ Category: Performance
- 🔴 Severity: Low

#### 1. Problem Description
Same performance anti-pattern as Findings #37/#38 — per-row inserts instead of a single batched multi-row statement.

#### 2. Strategy & Benchmark Comparison
`relative_strength.py`'s single `executemany()` call remains the clean, already-proven reference pattern in this codebase.

#### 3. Root Cause & Impact
Unnecessary per-row round-trip cost, compounding as universe size grows.

#### 4. Actionable Correction
Batch each into a single `executemany()`/multi-row INSERT call.

---

### 📌 Finding #72: `screener_ohlcv_backfill.py` silently swallows per-row insert failures with no logging
- 🎯 Location: `src/server/screener_ohlcv_backfill.py:93-94`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Low

#### 1. Problem Description
A bare `except Exception: pass` inside the per-row insert loop silently swallows any row-level failure (bad type coercion, constraint violation) with zero logging.

#### 2. Strategy & Benchmark Comparison
Same silent-failure discipline gap as elsewhere in this audit — should log at minimum.

#### 3. Root Cause & Impact
Individual bad rows vanish from the backfill with no trace, indistinguishable from rows that were never expected to exist.

#### 4. Actionable Correction
Log the exception and the row's key fields before continuing the loop.

---

## Frontend Findings (previously uncovered)

### 📌 Finding #73: Portfolio-impact Greeks tiles show random numbers, contradicting the correct chart directly above them
- 🎯 Location: `src/App.tsx:1652-1664` (component `OptionChain`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
The chart at line 1634-1649 correctly plots real `callDelta`/`callTheta`/`callVega` from chain data. The summary tiles immediately below do `{g === 'Gamma' ? '0.0024' : Math.random().toFixed(2)}` — Delta/Theta/Vega are pure random numbers regenerated every render.

#### 2. Strategy & Benchmark Comparison
A production options-analytics UI must derive every displayed Greek from the actual chain data, exactly as the chart component two lines above already correctly demonstrates is possible.

#### 3. Root Cause & Impact
A user reading "Greeks Analysis (Portfolio Impact)" sees invented risk numbers that change on every re-render, directly beside correct ones in the same card — a direct, user-facing fabrication of financial risk data.

#### 4. Actionable Correction
Compute portfolio-level aggregates (e.g. OI-weighted sum) from `chain` the same way the chart does; delete the `Math.random()` fallback entirely.

---

### 📌 Finding #74: MF-holdings table and FII/DII chart are entirely hardcoded/fabricated, identical for every stock
- 🎯 Location: `src/App.tsx:2781-2822` (component `MFAnalysis`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
`MFAnalysis` takes a `symbol` prop but never uses it in any query. "Top Mutual Fund Holders" hardcodes identical values for all 5 rows regardless of stock. "FII/DII Trends" is `Array.from({length:6}, ...fii: 15+Math.random()*5...)` — fully synthetic, regenerated every render.

#### 2. Strategy & Benchmark Comparison
A real `getFiiDiiFlow` procedure already exists and is correctly used elsewhere in this same codebase (`TradeDecisionCockpit.tsx:40`) — the fix is a wiring change, not new backend work.

#### 3. Root Cause & Impact
Every stock's MF/FII-DII panel shows identical, fake numbers presented as real and stock-specific — a direct fabrication visible to any user viewing more than one stock's page.

#### 4. Actionable Correction
Wire `symbol` into `getMFInvestments`/`getFiiDiiFlow` (both already exist per the router) instead of static/random placeholders.

---

### 📌 Finding #75: Fabricated candlestick data drives "real-looking" pattern/support-resistance analysis in both v1 and v2
- 🎯 Location: `src/App.tsx:3060-3116` (component `StockDetails`), `src/v2/views/stock-analysis/V2StockDetails.tsx:30-54`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
Both generate 40-100 candles via `Math.random()` instead of real OHLC. In v1, `detectCandlestickPatterns`/support-resistance levels are `useMemo`'d off this fake data — the "candlestick pattern detected" and "support/resistance" UI is a fabricated conclusion presented as real technical analysis, not just a cosmetic fake-chart issue.

#### 2. Strategy & Benchmark Comparison
v4's `StockIntelligencePage` (per CLAUDE.md) already does this correctly using the real `getOHLCData` procedure — the fix pattern already exists in this codebase, just not in v1/v2. Confirmed v3's `V3Dashboard.tsx` does not independently regenerate fake candles.

#### 3. Root Cause & Impact
This is broader than the previously-known "still uses Math.random for the chart" gap — derived technical-analysis output (patterns, S/R levels) shown to the user is meaningless in both v1 and v2, since the app-shell (v1, still the default first-load experience) computes it from synthetic data.

#### 4. Actionable Correction
Replace with the real `getOHLCData` procedure already used correctly by v4's `StockIntelligencePage`.

---

### 📌 Finding #76: In-place `.sort()` mutates cached tRPC query data
- 🎯 Location: `src/components/OptionChainView.tsx:201,227`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`opDatas.sort(...)` is called twice with different comparators directly on `parsedData?.optionChain`, which is derived directly from the tRPC query result, not a copy — `Array.prototype.sort()` mutates in place, rewriting the React Query cache object. The main table below correctly copies first (`[...opDatas].sort(...)`), proving the correct pattern is known elsewhere in the same file.

#### 2. Strategy & Benchmark Comparison
React Query's internal diffing assumes cached data isn't mutated by consumers — mutating in place violates that contract.

#### 3. Root Cause & Impact
The cache object is left mutated between polls; the same non-memoized sort runs on every unrelated re-render (e.g. toggling "Show Greeks"), wasting 2 extra O(n log n) sorts of the full option chain each time during the 30s poll window.

#### 4. Actionable Correction
`[...opDatas].sort(...)` (copy first) wrapped in `useMemo` keyed on `opDatas`, matching the pattern already used correctly a few lines below in the same file.

---

### 📌 Finding #77: Unmemoized array operations in the render body of frequently-updating components
- 🎯 Location: `src/App.tsx:1065-1082` (component `Dashboard`), `src/components/LiveMarketScreener.tsx:93` (10s poll), `src/components/ScreenerRankingPanel.tsx:33`
- 🏷️ Category: Performance
- 🔴 Severity: Medium

#### 1. Problem Description
`processedStocks = displayStocks.filter(...).sort(...)`, `sortedStocks = [...stocks].sort(...)`, and `JSON.stringify(JSON.parse(r.domains_json))` all run directly in component render bodies with no `useMemo`, recomputed on every render regardless of trigger.

#### 2. Strategy & Benchmark Comparison
Standard React performance practice memoizes any non-trivial array transform keyed on its actual dependencies, especially in components driven by a polling interval.

#### 3. Root Cause & Impact
`LiveMarketScreener.tsx` re-sorts its full list every 10-second poll tick and on every unrelated re-render (e.g. toggling a filter); `Dashboard`'s screener view does the same on every render.

#### 4. Actionable Correction
Wrap each in `useMemo` keyed on its actual inputs (e.g. `[displayStocks, searchQuery, sortField]`, `[stocks]`).

---

### 📌 Finding #78: Corrections to Round 1's frontend assumptions — several claimed gaps do not exist
- 🎯 Location: `src/services/marketService.ts`, `src/hooks/useAlerts.ts`, `src/v2/hooks/useWebSocket.ts`, `src/components/JobsDashboardPage.tsx`, `src/components/ModelRocPanel.tsx`
- 🏷️ Category: Correction (no action needed)
- 🔴 Severity: N/A

#### 1. Problem Description
This round's frontend agent found that several plausible-sounding concerns do **not** hold up: `marketService.ts` polls every 5 **minutes**, not 5 seconds as CLAUDE.md's summary language suggested — no leak, cleanup is handled entirely by React Query. `useAlerts.ts`'s `EventSource` is correctly closed on unmount. `useWebSocket.ts` (v2) is exemplary — ref-based destroyed-flag, backoff timer cleared on unmount, socket closed on cleanup. `JobsDashboardPage.tsx`'s 3s poll is gated on `document.visibilitychange` and all internal timeouts have matching cleanups. `ModelRocPanel.tsx`'s ROC interpolation already correctly guards its zero-width-bracket division.

#### 2. Strategy & Benchmark Comparison
N/A — documenting the negative result matters per this audit's own completeness discipline: an audit that only reports findings and never confirms what's clean invites false alarm on re-review.

#### 3. Root Cause & Impact
None — this is a documented "checked, ruled out" entry, included so a future audit doesn't re-spend effort re-verifying these same 5 areas from scratch.

#### 4. Actionable Correction
None required. If CLAUDE.md's "5s price polling" language is itself stale (worth a quick check next time that file is touched), update it to reflect the real 5-minute cadence.

---

## Live Database Verification (new this round)

Four Round 1 findings were checked against the real production Postgres database (`bharat_intel`, read-only queries only, no writes). Results:

- **Finding #33 (correlated subquery) — CONFIRMED with real numbers.** Timed both query forms against live `technical_signals` (47,204 rows): the correlated-subquery form took 0.164s; the `DISTINCT ON` alternative took 0.018s — a real ~9x speedup at today's row count, which will worsen as history accumulates, exactly as originally argued.
- **Finding #34 (unbounded OHLCV scan) — CONFIRMED with real numbers.** The unbounded query (`WHERE date <= scanDate`) returns 2,606,042 rows from `stock_ohlcv`; a 300-day-bounded equivalent returns 472,416 rows — the unbounded scan pulls **5.5x more data than needed** (only 18.1% of what it fetches is actually used).
- **Finding #40 (duplicate index on `technical_signals(symbol)`) — CORRECTED.** The live database has only **one** index (`idx_tsig_sym`) — `idx_technical_signals_symbol` exists in `db/schema.postgres.sql`'s source text but was never actually applied to production. This is consistent with the already-documented fact (per CLAUDE.md/memory) that `schema.postgres.sql` is not auto-applied and can drift from live reality. **Revised finding:** no live write-amplification cost exists today; the risk is that the schema *file* would create the duplicate on any fresh database (new dev DB, CI, disaster recovery) — same underlying risk class as Finding #66, lower urgency than originally stated.
- **Finding #41 (missing composite index on `signal_outcomes`) — RETRACTED.** `EXPLAIN (ANALYZE, BUFFERS)` on the exact join query from `ml.router.ts` shows Postgres already uses an **Index Only Scan on `signal_outcomes_pkey`** (the primary key is the composite `(symbol, signal_date, horizon_days)`, whose leading two columns already serve this join perfectly — `Index Cond: (symbol = ts.symbol) AND (signal_date = ts.date) AND (horizon_days = 15)`, 6.4ms total execution time for the query). No missing index exists; this finding was wrong and is withdrawn.

**Self-attack on this round's own findings:** the two corrections above are exactly the kind of static-inference error this audit's own discipline warns against — inferring a missing index from schema-file text or table structure without checking what Postgres's actual query planner does with it. Applying the same scrutiny to the remaining new findings in this round: most (leakage in look-ahead-anchor bugs, the max-pain OI swap, the fabricated frontend data) were confirmed by direct code logic reading, which is a stronger form of evidence than an index inference — but two (Finding #64's live-corruption claim, Finding #62's insider-date-field ambiguity) are explicitly flagged as unconfirmed/partially-confirmed in their own "Root Cause & Impact" sections rather than overstated.

---

---

# ROUND 3 — Full Coverage Closeout

Covers everything Round 2 flagged as still open: the remaining ~23 Python files (identified via an exact diff of the file tree against everything read in Rounds 1-2), a complete line-by-line read of `src/App.tsx` (4,319 lines — Round 2 had only read ~450), and all 66 remaining `src/components/*.tsx` files. Also includes a repo-wide grep sweep for the two recurring systemic patterns (date-anchor NULL-ing, no-promotion-gate) that Round 2 recommended running before continuing file-by-file — that sweep is what found Findings #82 and #87 below. Two of this round's findings (#82, #87) were additionally **live-verified against the production Postgres database** with direct evidence, not just static code reading.

## DIMENSION 3 (continued) — ML/Live-Screener Pipeline

### 📌 Finding #79: `live_screener_optimizer.py`'s train/holdout split is row-based, not date-based — leaks same-day cross-section across the boundary
- 🎯 Location: `src/server/live_screener_optimizer.py:58-61`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
`resolved.sort_values('appeared_at')` then a positional `iloc[:split_idx]`/`iloc[split_idx:]` cut — since one `appeared_at` day contains many symbols, the boundary day's rows split across train and holdout.

#### 2. Strategy & Benchmark Comparison
`live_screener_ml_ranker.py` in the same directory already does this correctly (date-set-based split, masking by `isin(test_dates)`) — the fix pattern exists one file away.

#### 3. Root Cause & Impact
The decision tree partially trains on a day's cross-section and is graded on other symbols from that *same* day in holdout — those rows share the day's market-wide regime, so the reported win-rate/avg-return per filter combination is optimistically biased.

#### 4. Actionable Correction
Mirror `live_screener_ml_ranker.py`: compute unique `appeared_at` dates, take the trailing ~20% as `test_dates`, mask by `matrix["appeared_at"].isin(test_dates)` instead of a row-index slice.

---

### 📌 Finding #80: `movement_predictor.py` has no promotion/regression gate — the 6th confirmed instance of this pattern
- 🎯 Location: `src/server/movement_predictor.py:465-480`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: High

#### 1. Problem Description
`train()` unconditionally overwrites `ml_models/movement.pkl` whenever not `report_only` — it never loads the existing pickle's stored `test_auc`/`oof_auc` to compare against the freshly computed ones, even though the existing artifact already stores both.

#### 2. Strategy & Benchmark Comparison
`live_screener_ml_ranker.py`'s `_load_active_metrics()`/`PROMOTION_MARGIN` pattern sits in a sibling file this module doesn't reuse.

#### 3. Root Cause & Impact
`score()` blindly loads whatever is at `MODEL_PATH`; a retrain that regresses silently replaces a better production model with a worse one — the 6th confirmed instance of this pattern across this audit (after `confluence_ml_engine.py`, `cs_ranker.py`, `online_learner.py`, `ml_signal_scorer.py`, `dl_engine.py`'s LSTM path).

#### 4. Actionable Correction
Load `MODEL_PATH` if it exists before the write, compare its stored `test_auc` to the new one, and only overwrite if it's better by a margin.

---

### 📌 Finding #81: `dl_trainer.py`'s promotion gate is an absolute floor, not a comparison to the active model — contradicts its own docstring
- 🎯 Location: `src/server/dl_trainer.py:134-153`
- 🏷️ Category: Quant & Model Gap
- 🔴 Severity: Medium

#### 1. Problem Description
The file's header explicitly claims promotion happens "only if it beats current production model," but the actual gate checks only fixed absolute thresholds (`acc>=0.50`, `auc>0.52`) — it never reads the currently-active version's own recorded metrics for a relative comparison.

#### 2. Strategy & Benchmark Comparison
A true champion/challenger gate compares the challenger against the champion's actual current metrics, not just a fixed floor — the docstring describes the correct design; the code implements a weaker one.

#### 3. Root Cause & Impact
Successive retrains can each individually clear the low floor while trending downward from a much stronger previous model (e.g. AUC 0.70 → 0.60 → 0.53 across cron cycles), silently degrading the deployed model release-over-release with nothing flagging the regression. Secondary, lower-confidence note: the `model_registry` INSERT never sets `is_active=0` on the prior BiLSTM row, so multiple `is_active=1` rows for the same model name can accumulate — not independently verified how consumers handle this.

#### 4. Actionable Correction
Fetch the currently-active BiLSTM `model_registry` row's `cv_roc_auc` before gating, and require the new model to beat it by a margin, in addition to the absolute floor.

---

## DIMENSION 1 (continued) — Confirmed Systemic Bug Recurrences (found via targeted repo-wide grep)

### 📌 Finding #82: `asm_gsm_fetcher.py` has the same date-anchor NULL-ing bug as `fundamentals_snapshot.py` — CONFIRMED actively corrupting production data, larger blast radius than every prior instance
- 🎯 Location: `src/server/asm_gsm_fetcher.py:147-203 (backfill_technical_signals, both Postgres and SQLite branches)`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Critical

#### 1. Problem Description
`today = date.today().isoformat()` anchors `CASE WHEN technical_signals.date >= ? THEN ns.is_asm ELSE NULL END` — and unlike the 4 previously-confirmed instances, there is **no `WHERE date >= floor` restricting which rows the UPDATE touches at all**: the join predicate is symbol-only, so the CASE/ELSE-NULL runs against every row in the entire table, not just one symbol's history.

#### 2. Strategy & Benchmark Comparison
The already-fixed sibling fetchers anchor to the last completed trading session and scope the UPDATE to the affected date range — this file does neither.

#### 3. Root Cause & Impact — **live-verified, confirmed actively occurring today, not merely latent**
Traced the trigger via `queues.ts`: `asm_gsm_fetcher.py` runs inside `ml-daily-ops`'s `closed-day-early-batch` dispatcher at 07:30 IST on every trading holiday — on a holiday there's no new OHLCV bar, so `date >= today` matches zero rows platform-wide and the `ELSE` branch fires for every symbol's every historical row. **Confirmed live**: `SELECT COUNT(*), COUNT(asm_flag) FROM technical_signals` returns 47,234 total rows vs. only 2,486 non-null `asm_flag` rows (5.3%). A direct per-symbol check (`UNIVCABLES`) shows the unambiguous signature of this exact bug — `asm_flag = 1` for 2026-07-29 (today) and `NULL` for every single prior date back through history (2026-07-28, -27, -24, -23, -22, -21, -20, -17, -16, all NULL) — meaning this job nulls out the entire surveillance-flag history and rewrites only the current day, every time it runs. This is not a hypothetical trigger condition; it is the observed state of the production database right now.

#### 4. Actionable Correction
Anchor on the last completed trading session (`MAX(date) FROM stock_ohlcv`, matching the grid-ensurer's own anchor) instead of `date.today()`, and add an explicit `WHERE technical_signals.date >= floor` to the UPDATE so it only ever touches the current day's row set. This is now the highest-priority fix in the entire audit given the confirmed, currently-active, full-table blast radius.

---

### 📌 Finding #83: `drift_detector.py`'s ML-confidence-haircut safety mechanism has been permanently broken since it was written — CONFIRMED via direct signature check
- 🎯 Location: `src/server/drift_detector.py:130-148 (get_drift_multiplier)`, `src/server/db_compat.py:236-238 (query_one(sql, params=()))`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Critical

#### 1. Problem Description
`get_drift_multiplier()` calls `_query_one(_conn, "SELECT drift_score FROM dl_model_performance ORDER BY eval_date DESC LIMIT 1", ())` — 3 positional arguments. Confirmed by reading `db_compat.py` directly: `query_one(sql, params=())` accepts exactly 2 parameters and opens its own connection internally; there is no `conn` parameter. Every single call raises `TypeError`.

#### 2. Strategy & Benchmark Comparison
Any drift-detection safety mechanism must actually execute to be a safety mechanism; a call that always raises and is silently caught is equivalent to having no drift detection at all, just with the appearance of one in the code.

#### 3. Root Cause & Impact
The surrounding `except Exception` swallows the `TypeError` and returns the default `1.0` (no haircut), logging only a print line — indistinguishable in logs from a genuine "checked, no drift found" result. `scoring_engine.py` calls this hourly to haircut win-probability confidence when the DL model's feature distribution or accuracy has drifted; this entire mechanism has been silently inert since the call was written, with zero monitoring signal distinguishing "no drift" from "the check itself is broken."

#### 4. Actionable Correction
```python
row = _query_one(
    "SELECT drift_score FROM dl_model_performance ORDER BY eval_date DESC LIMIT 1",
    (),
)
```
Drop the erroneous `_conn` argument; drop the now-pointless `conn` parameter from `get_drift_multiplier()`'s own signature since `query_one` always opens its own connection regardless.

---

### 📌 Finding #84: `preopen_fetcher.py` writes pre-market features to a `technical_signals` row that doesn't exist yet — a permanently dead feature
- 🎯 Location: `src/server/preopen_fetcher.py:248-266`, cross-referenced with `queues.ts` cron timing (07:40 UTC/9:10 AM IST) vs. `backfill_technical_features.py --full-today` (19:30 IST, same day)
- 🏷️ Category: Data Integrity
- 🔴 Severity: High

#### 1. Problem Description
`fetch_nse_preopen()` writes `iep_gap_pct`/`preopen_imbalance` via `UPDATE technical_signals ... WHERE symbol=? AND date=?` using today's date — but per the job schedule, the `technical_signals` row for that calendar date isn't created until the evening grid-ensurer step runs, roughly 10 hours later.

#### 2. Strategy & Benchmark Comparison
A write intended to land on a not-yet-existing row needs either an UPSERT, a staging table with a later carry-forward step, or a reordered schedule — a plain UPDATE against a row that provably doesn't exist yet is a silent no-op every time.

#### 3. Root Cause & Impact
This UPDATE affects 0 rows every single day, silently (no rowcount check or log). `ml_ensemble.py` builds ML features directly from `ts.iep_gap_pct`/`ts.preopen_imbalance`, both `num(col, 0.0)`-defaulted — these two engineered pre-market features have always been dead weight (always 0/neutral) in training despite the elaborate fetch/compute logic that produces them.

#### 4. Actionable Correction
Either move this write to run after the evening grid-ensurer (loses the "captured at pre-market time" intent, though the *value* itself is still pre-market data, just persisted later), or have `backfill_technical_features.py` carry the value forward from `preopen_stock_snapshot` (which does have a correctly-dated row) onto the day's `technical_signals` row once it exists.

---

### 📌 Finding #85: `intraday_features.py` can mislabel yesterday's row with today's data if an upstream step fails mid-chain
- 🎯 Location: `src/server/intraday_features.py:124-130`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Medium

#### 1. Problem Description
The UPDATE anchors on `date = (SELECT MAX(ts2.date) ...)` per symbol rather than an explicit date match. This runs post-close inside `ml-daily-ops`, downstream of the grid-ensurer, so it's normally safe — but the grid-ensurer's own failure is `.catch()`-swallowed elsewhere in the chain, letting execution continue.

#### 2. Strategy & Benchmark Comparison
`backfill()` in the same file correctly matches an exact historical date — that's the safer pattern, just not applied to the live-write path.

#### 3. Root Cause & Impact
If the grid-ensurer step earlier in the same run fails, `MAX(date)` for a symbol resolves to yesterday's row, and today's freshly-computed intraday microstructure features (`opening_range_break`, `vwap_deviation_pct`, `first_hour_vol_share`) get silently written onto yesterday's historical row, mislabeling it.

#### 4. Actionable Correction
Verify `MAX(date)` equals the intended session date before writing, or pass the confirmed date explicitly rather than trusting `MAX()`.

---

### 📌 Finding #86: `mc_earnings_fetcher.py` builds a Postgres VALUES clause via raw f-string interpolation instead of bound parameters
- 🎯 Location: `src/server/mc_earnings_fetcher.py:752-764 (fetch_actual_estimate_beats)`
- 🏷️ Category: Data Integrity
- 🔴 Severity: Low

#### 1. Problem Description
`f"('{sym}', {lbl}, ...)"` builds SQL text directly instead of using bound parameters for the `UPDATE ... FROM (VALUES {...})` pattern.

#### 2. Strategy & Benchmark Comparison
Parameterized queries (via `executemany`, a temp-table join, or `unnest($1::text[], ...)`) are the standard defense regardless of current input trust level.

#### 3. Root Cause & Impact
Currently low-risk since `sym` only ever comes from internally-synced `nse_stocks.symbol` values, not raw external input — but it bypasses parameterization entirely and would become exploitable if that assumption ever changes (e.g. a future feature accepting a user-supplied symbol).

#### 4. Actionable Correction
Rebuild via `executemany`/a temp-table join or a parameterized `unnest()` pattern instead of string interpolation.

---

### 📌 Finding #87: `extra_endpoints_fetcher.py` disables TLS certificate verification for every request
- 🎯 Location: `src/server/extra_endpoints_fetcher.py:54-60 (fetch_url)`
- 🏷️ Category: Data Integrity (Security)
- 🔴 Severity: Medium

#### 1. Problem Description
`ssl.CERT_NONE` + `check_hostname = False` disables TLS certificate verification for every one of the ~20k requests this job makes.

#### 2. Strategy & Benchmark Comparison
Standard practice validates certificates by default; bypassing verification should be scoped to a specific host with a documented reason, not applied blanket.

#### 3. Root Cause & Impact
A MITM-tampered response would be silently ingested as if genuine — a real security/data-integrity gap, not just a style issue. Additionally, the per-request exception handling in the same file (lines 149-164) swallows every failure into a print line with no aggregate failure-rate logged, so the job always exits 0 regardless of what fraction of ~20k requests actually succeeded.

#### 4. Actionable Correction
Use the default SSL context (or pin/validate certs) unless a specific target genuinely requires bypassing; add a summary log line (`X/{total} failed`) before exit.

---

## Frontend Findings — App.tsx (full 4,319-line read completed this round)

### 📌 Finding #88: Fake "52-Week High/Low" computed from intraday day-range plus an arbitrary offset, ignoring the real field on the same object
- 🎯 Location: `src/App.tsx:3285-3291` (component `StockDetails`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
`stock.high + 100`/`stock.low - 50` are displayed as "52W High"/"52W Low," but `stock.high`/`stock.low` are the intraday day-high/day-low fields — the real `stock.high52w`/`stock.low52w` fields already exist on the same object and are simply not used.

#### 2. Strategy & Benchmark Comparison
Any 52-week range display must read the actual 52-week field, not derive one from an unrelated intraday value with a made-up constant offset.

#### 3. Root Cause & Impact
Every stock's displayed 52-week range is wrong by a fixed, symbol-independent offset — exactly the kind of number a user checks before trading.

#### 4. Actionable Correction
Use `stock.high52w`/`stock.low52w` directly instead of `stock.high + 100`/`stock.low - 50`.

---

### 📌 Finding #89: Hardcoded "Technical Scorecard" sidebar directly contradicts the correctly-computed Technical tab on the same page
- 🎯 Location: `src/App.tsx:3594-3637` (component `StockDetails`) vs. `:2317-2610` (component `TechnicalAnalysis`, same page)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
RSI is hardcoded `"Neutral (58.4)"`, MACD hardcoded `"Bullish Crossover"`, Bollinger hardcoded `"Upper Band Touch"`, and "Pivot Points" fabricate R2/R1/PP/S1/S2 as `stock.high+10`/`stock.high`/`stock.price`/`stock.low`/`stock.low-10` (an arbitrary ±10 offset, not a real pivot formula) — none of these read the `getTechnicalDetails`/`getTechnicalScan` data already fetched and correctly rendered by the sibling `TechnicalAnalysis` component's real pivot levels (`tech.data.pivotLevels`).

#### 2. Strategy & Benchmark Comparison
The correct data and correct pivot-point formula already exist and render correctly two tabs over on the exact same page — this is a wiring gap, not a missing capability.

#### 3. Root Cause & Impact
A user flipping between the "Overview" tab (fake scorecard) and "Technical" tab (real pivots/indicators) sees two different, contradictory sets of numbers for the same stock at the same time.

#### 4. Actionable Correction
Delete the sidebar "Technical Scorecard" card, or wire it to the same `getTechnicalScan`/`getTechnicalDetails` data `TechnicalAnalysis` already fetches.

---

### 📌 Finding #90: Hardcoded "Institutional Flow (FII/DII)" card, identical for every stock and every session
- 🎯 Location: `src/App.tsx:3566-3577` (component `StockDetails`, F&O tab)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
Static `+₹4,250 Cr`/`-₹1,120 Cr` values and a permanently-static "Update: 15 mins ago" timestamp — real `getFiiDiiFlow`/`getInstitutionalFlows` procedures already exist per the router and are unused here.

#### 2. Strategy & Benchmark Comparison
This is the same wiring gap already found in `MFAnalysis` (Round 2 Finding #74) — the fix is a call to an existing procedure, not new backend work.

#### 3. Root Cause & Impact
Every stock's F&O tab shows the identical fake FII/DII numbers presented as live and current.

#### 4. Actionable Correction
Call `trpc.getFiiDiiFlow`/`getInstitutionalFlows` instead of the hardcoded values.

---

### 📌 Finding #91: Fabricated "68.4% probability" AI-report statistic and a canned, non-computed "Gemini has analyzed this strategy" backtest insight
- 🎯 Location: `src/App.tsx:3389-3397` (component `StockDetails`, AI report), `:2128-2140` (component `Backtest`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`68.4%` and `"22 trading sessions"` are literal strings, not fields off the real `report` object (only `report.outlook` is actually interpolated). Separately, the backtest view shows a static "Gemini has analyzed this strategy and recommends tightening the stop-loss..." sentence unconditionally whenever real results exist, next to genuinely computed backtest metrics — Gemini was never actually called for this text.

#### 2. Strategy & Benchmark Comparison
Any AI-attributed statistic or recommendation shown to a user must originate from an actual model call; a static string dressed as a per-report or per-run output misrepresents its provenance.

#### 3. Root Cause & Impact
Every AI report — bullish or bearish, any symbol — claims the identical "68.4%" confidence figure; every backtest run, regardless of its actual profit factor or drawdown, is told the same canned Gemini recommendation.

#### 4. Actionable Correction
Remove both fabricated strings, or wire them to real backend fields/an actual `getAIAnalysis` call.

---

### 📌 Finding #92: Additional hardcoded fabrication in `MFAnalysis`, same root cause as the already-reported MF-holdings/FII-DII fabrication
- 🎯 Location: `src/App.tsx:2825-2836` (component `MFAnalysis`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
"SIP Return (3Y Ann.)" hardcodes `18.4%` for every stock, with narrative text computed only from the current year minus 5 — no query against `symbol`.

#### 2. Strategy & Benchmark Comparison
Same root cause as Round 2 Finding #74 — the `symbol` prop is never used anywhere in this component.

#### 3. Root Cause & Impact
Same fabrication pattern, additional instance within the same already-flagged component.

#### 4. Actionable Correction
Fix alongside Finding #74 — wiring `symbol` into real backend calls resolves this and the MF-holdings table/FII-DII chart together.

---

### 📌 Finding #93: ~720 lines of unreachable dead code contain the same fabricated-data problem, at risk of being silently re-wired later
- 🎯 Location: `src/App.tsx:410-967` (`const Dashboard`, unreferenced — actual routes use the separately-imported `DashboardPage`), `:1671-1830` (`const MarketMap`, unreferenced — actual routes render `MarketHeatmapWidget`/`SectorPerformance`/`SectorHeatmap`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Low

#### 1. Problem Description
Both components are confirmed unreachable by any current route (verified via grep, no reference anywhere else in the file or exports), yet contain hardcoded fake data: a static "Nifty 50 Rank 22,453.20," a hardcoded 84%-win-rate/1,240-signal "Signal Performance" card, an internally-inconsistent "Portfolio Snapshot" card (its own gain figures don't reconcile), a fake 65/20/15 "Distribution Analysis" chart, hardcoded advance/decline counts despite a real `getAdvanceDecline` procedure existing, and a hardcoded Greed/Fear gauge fixed at 72%.

#### 2. Strategy & Benchmark Comparison
Dead code containing fabricated data is a latent risk distinct from live fabrication — it can be silently un-deleted or re-wired into a route later, shipping fake data without anyone re-auditing it as "new."

#### 3. Root Cause & Impact
~720 lines of maintenance burden and risk with zero current user-facing effect (since unreachable) — a cleanup item, not an active bug.

#### 4. Actionable Correction
Delete both dead components, or wire them up properly if they're meant to be used somewhere.

---

## Frontend Findings — Remaining Components (66 files, full read)

### 📌 Finding #94: `SmartMoneyMonitor.tsx` is a fully fabricated panel — no backend call exists at all, not a fallback
- 🎯 Location: `src/components/SmartMoneyMonitor.tsx:17-27`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
`flowData` is a hardcoded array of 9 stocks with invented promoter/FII/DII percentage-change and net-flow numbers. Unlike every other panel in the app, there is no `trpc.*` query anywhere in this component — this isn't a degraded fallback for a failed fetch, it's the only data path that exists.

#### 2. Strategy & Benchmark Comparison
Every comparable panel elsewhere in this app reads from a real backend procedure (the codebase already has insider-transaction and MF-flow tables per prior session work) — this component simply never was wired to one.

#### 3. Root Cause & Impact
The "Smart Money MF/FII Flow Monitor" presents completely made-up institutional ownership-change numbers, with interactive search/filter/bar-charts, as if it were live Trendlyne/MC data — a user could make a real trade decision believing specific stocks are under genuine institutional accumulation when the numbers were never computed from anything real.

#### 4. Actionable Correction
Wire this to a real backend procedure, or remove the component/tab until it's backed by real data.

---

### 📌 Finding #95: `SeasonalityCalendar.tsx` silently substitutes hardcoded fake seasonality stats and a fabricated default win-rate for real backend data
- 🎯 Location: `src/components/SeasonalityCalendar.tsx:33-44,106`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`fallbackData` hardcodes seasonality stats for 8 well-known stocks, substituted in whenever the real backend query returns empty, with no visual distinction from genuine data. Separately, `winRate` defaults to a fabricated `80` whenever `total_years` is 0 on a genuine backend row.

#### 2. Strategy & Benchmark Comparison
An empty/unavailable state should be shown as such, not silently backfilled with invented numbers indistinguishable from real ones.

#### 3. Root Cause & Impact
A user sees "8/10 years positive, +6.4% avg" for a stock that was never actually computed from real historical data.

#### 4. Actionable Correction
Remove the hardcoded fallback; show an explicit "seasonality data unavailable" empty state instead.

---

### 📌 Finding #96: `Watchlist.tsx` sparkline is driven by `Math.random()`
- 🎯 Location: `src/components/Watchlist.tsx:113`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`Array.from({length: 8}, () => ({ v: Math.random() }))` feeds a bar-chart sparkline rendered directly beside the real LTP/price in every watchlist card.

#### 2. Strategy & Benchmark Comparison
Same fabrication pattern already found in `App.tsx`'s Greeks tiles and `MFAnalysis` — a random mini-chart next to a real price implies real intraday trend data that doesn't exist.

#### 3. Root Cause & Impact
Gives the illusion of a real short-term price trend on every watchlist entry.

#### 4. Actionable Correction
Fetch/derive a real short-window price series, or remove the sparkline entirely.

---

### 📌 Finding #97: `TradeDecisionCockpit.tsx`'s "Factor Breakdown" is 4/5 client-invented formulas presented with equal visual weight as the one real ML score
- 🎯 Location: `src/components/TradeDecisionCockpit.tsx:533-538`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
Of 5 "Factor Breakdown" bars, only "ML Win Prob" is a real backend value; the other four are ad hoc linear transforms invented in the component (`techSignalCount * 25`, `100 - quantRank` defaulting to 0% when missing, `50 + smartMoneyCr * 5`, `50 + newsSentiment * 50`).

#### 2. Strategy & Benchmark Comparison
A trade-decision UI presenting multiple "factor scores" should either compute all of them from validated backend logic, or clearly label ad hoc client-side transforms as raw/derived metrics, not equal-weight "scores."

#### 3. Root Cause & Impact
In the Trade Decision Cockpit specifically — the surface most directly informing a trade decision — 4 of 5 displayed percentages are frontend guesses with no calibration, implying a validated 5-factor model backs the decision when it doesn't.

#### 4. Actionable Correction
Either display these as transparently-labeled raw metrics (not 0-100 "scores"), or move the scaling logic to the backend where it can be validated and tested like the rest of the scoring pipeline.

---

### 📌 Finding #98: Missing technical data renders a false "Death Cross" bearish signal instead of an empty state
- 🎯 Location: `src/components/TradeDecisionCockpit.tsx:563-574`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`selectedCand.sma50 > selectedCand.sma200 ? 'Golden Cross' : 'Death Cross'` has no null-guard; `undefined > undefined` is `false` in JS, so a stock with no SMA data at all is labeled "Death Cross" in red, while the adjacent numeric value correctly falls back to "—".

#### 2. Strategy & Benchmark Comparison
The `val` field right next to this label already handles the missing-data case correctly — the same guard just needs to extend to the derived label.

#### 3. Root Cause & Impact
A trader sees "—" for the actual SMA values but a labeled, colored bearish signal underneath — a fabricated technical read where none exists.

#### 4. Actionable Correction
Guard the derived label/color with the same `!= null` check already used for `val`.

---

### 📌 Finding #99: `SlideOutDrawer.tsx` renders a missing quant score as a fake neutral 50/Hold, indistinguishable from a real one
- 🎯 Location: `src/components/SlideOutDrawer.tsx:55`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`quantScore?.rank_composite ?? 50` and `composite_class ?? 'Hold'` render a full percentile gauge and badge identically to a genuinely-computed neutral score whenever no quant score row exists for the symbol.

#### 2. Strategy & Benchmark Comparison
An "unscored" state should render as visibly distinct from a genuine neutral score, not defaulted into the middle of the real scale.

#### 3. Root Cause & Impact
Misleads on any stock the quant engine hasn't scored yet — indistinguishable from "we computed this and it's neutral."

#### 4. Actionable Correction
Render an explicit "not yet scored" state instead of a numeric default.

---

### 📌 Finding #100: `IndexDetailPage.tsx` resolves index constituents against the wrong provider ID, unlike its own sibling file
- 🎯 Location: `src/components/IndexDetailPage.tsx:312` vs. `src/components/MCIndexDetailPanel.tsx` (correct `mcsymbol` fallback)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
Matches MoneyControl's opaque `id` field only against the NSE `.symbol` field, with no `mcsymbol` fallback. Live-curled MC's real `marketmap` endpoint and confirmed `id` values (`AT18`, `ADANI54145`, `AP26`, etc.) are not NSE tickers.

#### 2. Strategy & Benchmark Comparison
This platform's documented Ticker Resolution Strategy requires resolving provider-opaque IDs via `stocklist.ts`'s mapping table, never matching them directly against the NSE symbol — `MCIndexDetailPanel.tsx` already does this correctly with an `mcsymbol` fallback in the same codebase.

#### 3. Root Cause & Impact
Most constituent rows in this view navigate/display the wrong symbol.

#### 4. Actionable Correction
Add the same `mcsymbol` fallback resolution already implemented correctly in `MCIndexDetailPanel.tsx`.

---

### 📌 Finding #101: `IndexFnoOverview.tsx` labels a filtered subset's PCR/OI as if comprehensive
- 🎯 Location: `src/components/IndexFnoOverview.tsx:220`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
"PCR"/"Total Call OI"/"Total Put OI" are computed only from the `oi-gainers-call/put` scanners (a filtered top-N subset of the option chain), not the full chain, but labeled and interpreted as if comprehensive.

#### 2. Strategy & Benchmark Comparison
A PCR/OI figure derived from a filtered top-N subset should be labeled as such (e.g. "PCR (top movers)"), not presented as the standard whole-chain PCR figure traders expect.

#### 3. Root Cause & Impact
Misleads on the actual put/call balance for the index.

#### 4. Actionable Correction
Either source the full option chain for this calculation, or relabel the metric to make the subset-based nature explicit.

---

### 📌 Finding #102: `DashboardPage.tsx` shows a permanently hardcoded "Win Rate (84d)" KPI, and unmemoized advancers/decliners recomputation
- 🎯 Location: `src/components/DashboardPage.tsx:512 (hardcoded "84%")`, `:442 (unmemoized filter/sort on a live-polled prop)`
- 🏷️ Category: Wrong Logic / Performance
- 🔴 Severity: Medium

#### 1. Problem Description
The "Win Rate (84d)" tile is a literal `"84%"` string with no query behind it. Separately, `advancers`/`decliners`/`topGainers`/`topLosers` are recomputed via `.filter()`/`.sort()` in the render body (no `useMemo`) on a `stocks` prop fed by live polling.

#### 2. Strategy & Benchmark Comparison
A real win-rate procedure (`getSignalWinRates`/`getAccuracyMetrics`) already exists per the router; the array recomputation should follow the same memoization discipline flagged elsewhere in this audit for poll-driven components.

#### 3. Root Cause & Impact
Users see a permanently static, unchanging win-rate number presented as a live metric; the array recomputation re-runs on every poll tick unnecessarily.

#### 4. Actionable Correction
Wire the KPI tile to a real backend win-rate procedure; wrap the array derivation in `useMemo` keyed on `stocks`.

---

### 📌 Finding #103: `MCStockInfoPanel.tsx` — fake "Aggregate" score, and a likely unit-confusion bug on net profit margin
- 🎯 Location: `src/components/MCStockInfoPanel.tsx:662 (Aggregate = momentum * 10)`, `:1535 (row.npm * 100, lower confidence)`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
The "Aggregate" score bar is literally `momentum * 10`, not a composite of the 5 factors displayed beside it. Separately (flagged plausible, not fully confirmed), `row.npm * 100` assumes a decimal-fraction input; if the source (NiftyTrader) already returns a percentage, this inflates the margin 100x.

#### 2. Strategy & Benchmark Comparison
This exact percentage/decimal unit-confusion bug class has already been found and fixed once elsewhere in this codebase — worth checking the actual NiftyTrader response shape before trusting either interpretation.

#### 3. Root Cause & Impact
"Aggregate" misrepresents itself as a composite when it's a single-factor pass-through; the NPM figure, if the unit assumption is wrong, would display a wildly incorrect margin.

#### 4. Actionable Correction
Compute a genuine weighted composite for "Aggregate" from the displayed 5 factors; verify NiftyTrader's actual `npm` unit (percentage vs. fraction) before deciding whether `* 100` is needed.

---

### 📌 Finding #104: Two defensive-coding gaps that crash a component or render garbage on missing/empty data
- 🎯 Location: `src/components/TopRatedStocks.tsx:96,104-105 (unguarded optional field access)`, `src/components/SignalReportCard.tsx:130 (Math.max on empty array)`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Low

#### 1. Problem Description
`TopRatedStocks.tsx` calls `stock.classification.includes(...)`, `stock.score.toFixed(1)`, `stock.confidence.toFixed(0)` with no null check despite all three being typed optional in the same file — one stock row missing any of these fields throws and blanks the entire ranking list, not just that row. `SignalReportCard.tsx`'s `Math.max(...recentBacktestResults.map(...))` evaluates to `-Infinity` on an empty array, rendered as "-Infinity.00%".

#### 2. Strategy & Benchmark Comparison
Standard defensive rendering guards optional-typed fields at the point of use and short-circuits reduce-style operations on empty collections.

#### 3. Root Cause & Impact
A single malformed backend row can blank an entire ranking list; an empty backtest history renders visible garbage output.

#### 4. Actionable Correction
`stock.classification?.includes(...) ?? false`, `stock.score?.toFixed(1) ?? '—'`, `stock.confidence?.toFixed(0) ?? '—'`; guard the `Math.max` call with a length check before formatting.

---

### 📌 Finding #105: `MarketIndices.tsx`'s day-range bar is purely decorative, not derived from real high/low data
- 🎯 Location: `src/components/MarketIndices.tsx:116-120`
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Low

#### 1. Problem Description
The animated bar width is `${55 + idx * 14}%` — a function of the card's array position (Nifty/Sensex/BankNifty), not any real intraday high/low.

#### 2. Strategy & Benchmark Comparison
A labeled "Day Low"/"Day High" range indicator should reflect where the index actually sits in its real daily range.

#### 3. Root Cause & Impact
Presented directly under real "Day Low"/"Day High" labels as if reflecting actual position in the day's range — it never does.

#### 4. Actionable Correction
Wire real day-high/day-low from `getMarketOverview` if available, or remove the labeled range bar.

---

## Live Database Verification (Round 3 additions)

Two Round 3 findings were checked against the real production Postgres database, beyond the four checked in Round 2:

- **Finding #82 (`asm_gsm_fetcher.py`) — CONFIRMED WITH DIRECT EVIDENCE, upgraded from "suspected" to "actively occurring."** `technical_signals` has 47,234 total rows but only 2,486 non-null `asm_flag` values (5.3%). A per-symbol trace (`UNIVCABLES`) shows `asm_flag=1` for 2026-07-29 and `NULL` for every prior date in the sample (2026-07-28 back through 2026-07-16) — the exact signature of "every run nulls all history, only today's write survives." This is the single most severe confirmed-live finding in the entire audit.
- **Finding #83 (`drift_detector.py`) — CONFIRMED via direct signature inspection.** Read `db_compat.py:236-238` directly: `query_one(sql, params=())` takes exactly 2 arguments; `drift_detector.py:133-137` calls it with 3 (`_conn, sql, params`). This is a deterministic `TypeError` on every invocation, not merely plausible — the finding required no live data query, only reading both function signatures side by side.

---

# ROUND 4 — v3/v4 Frontend + Performance Live-Verification Closeout

Closes the two gaps Round 3 explicitly flagged as out of scope: the `v3`/`v4` frontend directories beyond the one file (`V2StockDetails.tsx`, via Finding #75) already checked in Round 2, and a live `EXPLAIN ANALYZE`/`pg_indexes` pass over the seven Dimension-5 performance findings (#35-#41) that had previously been static-inference only. All 7 remaining `v3`/`v4` files were read in full: `src/v3/views/dashboard/V3Dashboard.tsx` (2,049 lines), `src/v4/views/MarketCommandCenter.tsx`, `src/v4/views/StockIntelligencePage.tsx`, and `src/v4/components/{EarningsPulseWidget,FnOIndexInsight,PreMarketBriefing,SentimentPulseWidget}.tsx`. The production Postgres database (`bharat_intel` on `127.0.0.1:5433`, credentials read from the repo's own `.env`) was reachable this round — all of #36, #37, #40, #41 were live-verified with real `EXPLAIN (ANALYZE, BUFFERS)`/`pg_indexes`/row-count queries (read-only, no writes); #35, #38, #39 don't involve SQL and were re-confirmed by direct code/config inspection instead, per the task's own instruction for those three.

## DIMENSION 6 (new) — v3/v4 Frontend Coverage

### 📌 Finding #106: `getTechnicalPredictions` reads a legacy table missing 5 of the 7 fields `StockIntelligencePage.tsx`'s Technicals tab asks for — `win_probability`, `adx`, and all three SMAs never render
- 🎯 Location: `src/server/routers/technicals.router.ts:26-32` (`getTechnicalPredictions`, `SELECT * FROM technical_analysis_signals`), `src/v4/views/StockIntelligencePage.tsx:145-149` (`indicatorFields`)
- 🏷️ Category: Wrong Logic
- 🔴 Severity: High

#### 1. Problem Description
`getTechnicalPredictions` queries `technical_analysis_signals` — a legacy, mostly-superseded table (`src/server/db.ts:390-401`, `db/schema.postgres.sql:2185-2196`) whose only columns are `symbol, trend, rsi, macd, bollinger, patterns, entry_price, target_price, stop_loss, last_updated`; `macd` is `TEXT`, not numeric. `StockIntelligencePage.tsx`'s `TechnicalsTab` declares `indicatorFields = [['rsi','RSI'],['macd','MACD'],['adx','ADX'],['sma20','SMA 20'],['sma50','SMA 50'],['sma200','SMA 200'],['win_probability','Win Probability']]` and renders a tile only `if predictions[key] != null`. `adx`, `sma20`, `sma50`, `sma200`, and `win_probability` do not exist as columns on `technical_analysis_signals` at all, so those five keys are `undefined` on every single row, forever — those 5 of 7 "Technical Signal Snapshot" tiles never render for any stock, on any day.

#### 2. Strategy & Benchmark Comparison
The fields the frontend actually wants (`rsi`, `sma50`, `sma200`, `adx`, `win_probability` — confirmed present, `db/schema.postgres.sql:2226-2264`) all live on the actively-maintained `technical_signals` table (symbol+date PK, populated by the whole technical-scan/ML pipeline this codebase's own `CLAUDE.md` documents as canonical), one table over from the one actually queried. `sma20` does not exist on either table — only `sma50`/`sma200` were ever computed — so that one key is unrecoverable as named regardless of which table is fixed.

#### 3. Root Cause & Impact
This is the one place in the app built specifically to explain a stock's ML-driven score (`StockIntelligencePage`'s own file comment: "REAL OHLCV chart... not synthetic/random data") — and its "Technical Signal Snapshot" card silently shows only RSI and a raw MACD string, never the win-probability figure that `scoring_engine.py`'s hard 0.40 gate and this whole codebase's documented ML feedback loop treat as the central output. No error, no empty state on the missing fields individually — the card just quietly renders 2 tiles where 7 were designed, indistinguishable from "this stock has no ADX signal today" rather than "this field can never be populated by this query."

#### 4. Actionable Correction
Point `getTechnicalPredictions` at `technical_signals` (`SELECT * FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1` — the current query also lacks an `ORDER BY`/`LIMIT`, relying on `technical_analysis_signals`' `symbol`-only PK to guarantee one row, which happens to work only because that legacy table can hold exactly one row per symbol). Drop the `sma20` key from `indicatorFields` (no such column exists) or compute it separately if a 20-day SMA is actually wanted.

---

### 📌 Finding #107: `V3Dashboard.tsx`'s "Warren AI" report fakes a live LLM inference with a typewriter animation over a client-side string template, and falls back to two hardcoded, stock-agnostic SWOT sentences when real data is missing
- 🎯 Location: `src/v3/views/dashboard/V3Dashboard.tsx:637-735` (`generateWarrenReport`, `triggerWarrenAI`), `:697-698` (hardcoded fallback strings), `:1989-2046` (modal UI: "BBG WARREN-AI COGNITIVE DESK | CODENAME: LLAMA-3-LOCAL")
- 🏷️ Category: Wrong Logic
- 🔴 Severity: Medium

#### 1. Problem Description
`triggerWarrenAI` never calls any AI backend (no `getAIAnalysis`, no `aiService`/`geminiService`) — `generateWarrenReport` synchronously builds a fixed-format text block from already-fetched real values (score, factors, SWOT, DVM, checklist, PCR, max pain), then `triggerWarrenAI` reveals that pre-built string 3 characters at a time via a 15ms `setInterval` (`:726-734`) while the modal shows an animated pulsing dot and the label "COGNITIVE ANALYSIS STREAM" (`:2024-2030`) — simulating a model "thinking" when the entire output was computed instantly and deterministically before the animation even starts. Within that template, when `trendSWOT.strengths?.[0]` or `.weaknesses?.[0]` is absent, the report substitutes literal fallback text — `'Capital structure remains highly stable.'` / `'Higher valuations present slight momentum friction.'` (`:697-698`) — under the labels "Strength Highlight" / "Risk Mitigation," identical for every stock with no real SWOT data.

#### 2. Strategy & Benchmark Comparison
This differs from the already-catalogued Finding #91 pattern (literal fabricated numbers like "68.4%" dressed as AI output) in that most of the numeric content here genuinely is the real fetched data — the fabrication is narrower but still real: the branding/animation manufactures the *appearance* of a live model call that never happens, and the two SWOT fallback sentences present generic boilerplate as if it were company-specific analysis when the underlying SWOT data is simply missing.

#### 3. Root Cause & Impact
A user reading "BBG WARREN-AI... CODENAME: LLAMA-3-LOCAL" streaming text has no way to know this is a local string template, not a model inference — and for any stock lacking Trendlyne SWOT coverage, the two most narratively load-bearing lines of the "report" ("Strength Highlight," "Risk Mitigation") are the same canned sentence regardless of symbol, exactly the "identical output for every stock" signature this audit has flagged repeatedly elsewhere (Findings #74, #90, #92).

#### 4. Actionable Correction
Either wire `triggerWarrenAI` to a real `getAIAnalysis`/LLM call and drop the fake typing delay, or relabel the feature honestly (e.g. "Report Summary," no "AI"/"cognitive"/model-codename branding, no simulated latency) since the underlying real-data template is legitimately useful on its own. Replace the two hardcoded SWOT fallback strings with an explicit "no SWOT data available" state, matching this audit's own missing-data-should-render-empty principle applied correctly elsewhere in the same file (e.g. `pivotLevels`'s `'—'` fallback, `:560-568`).

---

### 📌 Finding #108: Unmemoized advancers/decliners recomputation in `V3Dashboard.tsx` — the same pattern already catalogued in Findings #77/#102, now a third confirmed file
- 🎯 Location: `src/v3/views/dashboard/V3Dashboard.tsx:614-615`
- 🏷️ Category: Performance
- 🔴 Severity: Low

#### 1. Problem Description
`const advancers = stocks.filter(s => s.changePct > 0).length; const decliners = stocks.filter(s => s.changePct < 0).length;` runs directly in the component body on every render, with no `useMemo`, over the same `stocks` array `BreadthGauge` (`:80-84`) independently re-filters internally — two full un-memoized passes over the live-updating stock list per render, one of them duplicating work `BreadthGauge` already does.

#### 2. Strategy & Benchmark Comparison
Same fix pattern this audit already recommended for `DashboardPage.tsx` (Finding #102) and `Dashboard`/`LiveMarketScreener.tsx`/`ScreenerRankingPanel.tsx` (Finding #77) — wrap in `useMemo` keyed on `stocks`.

#### 3. Root Cause & Impact
Minor in isolation (`V3Dashboard`'s `stocks` prop doesn't itself poll as tightly as `LiveMarketScreener`'s 10s interval), but this is now the third independently-discovered file with the identical unmemoized-filter shape, reinforcing the Round 3 self-attack note that this deserves a lint rule rather than continued file-by-file discovery.

#### 4. Actionable Correction
`const { advancers, decliners } = useMemo(() => ({ advancers: stocks.filter(s => s.changePct > 0).length, decliners: stocks.filter(s => s.changePct < 0).length }), [stocks]);`

---

### 📌 Finding #109: Corrections/confirmations for the remaining v3/v4 files — no fabrication found, CLAUDE.md's v4 OHLC claim confirmed true
- 🎯 Location: `src/v4/views/MarketCommandCenter.tsx`, `src/v4/components/{EarningsPulseWidget,FnOIndexInsight,PreMarketBriefing,SentimentPulseWidget}.tsx`, `src/v4/views/StockIntelligencePage.tsx` (all tabs except the Technicals-tab field bug in Finding #106), `src/v3/views/dashboard/V3Dashboard.tsx`'s candlestick chart
- 🏷️ Category: Correction (no action needed)
- 🔴 Severity: N/A

#### 1. Problem Description
None of `MarketCommandCenter.tsx`, `EarningsPulseWidget.tsx`, `FnOIndexInsight.tsx`, `PreMarketBriefing.tsx`, or `SentimentPulseWidget.tsx` contain `Math.random()`, hardcoded numeric literals, or identical-for-every-stock output — each is a thin composition layer over real tRPC procedures (`getEarnings`, `getMacroSnapshot`, `getMarketSentiment`, `getNewsItems`, `getRegimeSummary`, `getIntradayBreadth`) with correctly-guarded empty states ("No results declared yet today," "Macro snapshot not yet available for today"). `FnOIndexInsight.tsx` passes `symbol="NIFTY"`/`"BANKNIFTY"` into `IndexFnoOverview` — checked against `toFnoSymbol()` (`src/components/IndexFnoOverview.tsx:11-18`), both strings already match its canonical output, so this is not an instance of Finding #100's wrong-provider-ID pattern. `PreMarketBriefing.tsx`'s `buildBriefing()` is fully rule-based off already-fetched tile values, with its own header comment stating the design intent ("never invents a number that isn't in `tiles`") — verified true by reading the function. `StockIntelligencePage.tsx` is clean apart from Finding #106: every other tab (`FundamentalsTab`, `OwnershipTab`, `FnoTab`, `EarningsTab`, `NewsTab`) correctly renders "No X data captured yet" rather than a fabricated value when its query returns null, and its `getShareholding` field names (`promoter_pct`/`fii_pct`/`mf_pct`/`pledge_pct`) match the router's real return shape (`src/server/routers/fundamentals.router.ts:65`). Separately: CLAUDE.md's claim that `StockIntelligencePage` is "the first UI surface" to use a real OHLC-backed chart instead of `Math.random()` candles is confirmed **true** for the chart itself (`TechnicalsTab`, `:135-143`, real `getOHLCData` wrapped in `useMemo`) — but `V3Dashboard.tsx` (`:546-558`) independently also fetches and renders real OHLC via the same `getOHLCData` procedure for its own candlestick chart (comment: "from real OHLC history (Moneycontrol via getOHLCData)"), and also already embeds `WhyThisPick` (`:1483`) — so CLAUDE.md's "first" framing is imprecise (both v3 and v4 do this correctly today); not a defect, just a documentation nuance worth a note next time CLAUDE.md's v3/v4 section is touched.

#### 2. Strategy & Benchmark Comparison
N/A — documenting the negative result per this audit's own completeness discipline (see Finding #78's rationale, applied identically here), so a future audit doesn't re-spend effort re-checking these 6 files or re-deriving the v4-OHLC claim from scratch.

#### 3. Root Cause & Impact
None. `MarketCommandCenter.tsx`'s own header comment ("this page's job is composition and prioritization, not new math") accurately describes what was found — it composes `IndexFnoOverview`'s existing `analyseOI()`, `SectorHeatmap`, `TopMoversIntelligence`, etc. without re-deriving any of their math, avoiding the exact "two views silently disagreeing" risk this audit has flagged elsewhere (e.g. Finding #100).

#### 4. Actionable Correction
None required for the 6 clean files. For CLAUDE.md: soften "the first UI surface" to note `V3Dashboard.tsx` independently reached the same real-OHLC/`WhyThisPick` state.

---

## Live Database Verification (Round 4 additions)

The production Postgres database was reachable this round (`bharat_intel`, `127.0.0.1:5433`, credentials from the repo's own `.env`, read-only queries only — `SELECT`/`EXPLAIN ANALYZE`/`pg_indexes` catalog lookups, no writes). Results for the seven remaining Dimension-5 findings:

- **Finding #35 (BullMQ jobs-status ~340 Redis round trips) — CONFIRMED via code inspection (no DB involved).** Counted `queueList` in `getBullMQJobsStatus` (`src/server/routers/monitor.router.ts:442-476`) directly: exactly **34** entries, each issuing 6 `Promise.all`'d count/repeatable calls plus 4 `getJobs()` calls = 10 Redis round trips → 34×10 = **340**, matching the finding exactly. `JobsDashboardPage.tsx:94`'s `refetchInterval: isVisible ? 3000 : false` also confirmed unchanged — already gated on tab visibility, consistent with the finding's own framing ("while the tab is open").
- **Finding #36 (system-status: one query per monitored script) — CONFIRMED and quantified.** `MONITOR_SCRIPTS` has exactly **25** entries (`src/server/monitorScripts.ts`); `getSystemStatus` (`monitor.router.ts:244-288`) issues `getLastRunAt()` + `getScriptStats()` per script (≥50 total queries) plus one upfront `app_settings` scan, all via `Promise.all`. Timed 5 representative `getLastRunAt` query shapes individually against the live DB (`MAX(computed_at) FROM technical_signals` 24ms, `MAX(computed_at) FROM signal_outcomes WHERE horizon_days=5` 54ms, `MAX(computed_at) FROM technical_signals WHERE win_probability IS NOT NULL` 23ms, `MAX(date) FROM stock_ohlcv` 45ms, `app_settings` LIKE-scan 6ms) — none individually slow, but 25 of these run sequentially in a plain loop took **233ms** total; parallelized via `Promise.all` (as the real code does) this compresses substantially, so the finding's "Low" severity is confirmed appropriate — this is a connection-count/round-trip-count concern, not a per-query latency one.
- **Finding #37 (`etMarketstatsSync.ts` ~83,000 sequential statements/run) — CONFIRMED, and the live per-run cost is now larger than originally estimated.** `et_marketstats_screener_stocks` is a snapshot/upsert table (PK `(screener_key, symbol)`, `db/schema.postgres.sql:461-472`) currently holding **8,581** rows — since it's upserted in place, this row count *is* the per-run stock-upsert cost. `mc_general_metrics` (`source_api='et_marketstats'`) accumulates historical rows (not upserted), and grouping by `fetched_at::date` for the 5 most recent sync runs shows **75,512 to 118,398** metric rows written per run. Combined per-run sequential-statement estimate today: **~84,000–127,000**, at or above the audit's original ~83,000 figure — the finding is not just confirmed but slightly understated versus current data volume.
- **Finding #38 (two Python fetchers commit per-row) — CONFIRMED via code inspection (no DB timing needed, per the finding's own nature).** `moneycontrol_fetcher.py:786-802` (`_write_general_metrics`) still loops `for r in rows: conn.execute(...)` inside one `engine.begin()` block — one `execute()` per row, no `executemany`/batched `VALUES`. `financial_ratios_fetcher.py` still calls `con.commit()` at the end of both `upsert_tl_financial_quality` (line 376) and `update_technical_signals` (line 400) — both called once per stock from the per-stock loop at `:468-489` — confirmed 2 commits/stock, ~4,000+ commits for the current stock universe, unchanged from the original finding.
- **Finding #39 (`pythonRunner.ts` 3-min slot-wait timeout vs. 90-min jobs) — CONFIRMED unchanged via code inspection.** `MAX_PYTHON_CONCURRENT = 5` (`:19`), `SLOT_WAIT_TIMEOUT_MS = 3 * 60_000` (`:34`), `_slotHealthWatchdog` still runs every 5 minutes checking for a >100-min stuck counter (`:45-71`) — all values exactly as originally reported; the design trade-off framing stands.
- **Finding #40 (duplicate index on `technical_signals(symbol)`) — RECONFIRMED, no change from the Round 2 correction.** `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'technical_signals'` returns 8 indexes, exactly **one** of which touches `symbol` alone (`idx_tsig_sym`); `idx_technical_signals_symbol` still does not exist live. The Round 2 correction (schema-file-only risk, not a live write-amplification cost) still holds today.
- **Finding #41 (`signal_outcomes` composite index) — Round 2's retraction needs a partial revision at today's data volume.** `signal_outcomes` still has the composite primary key `(symbol, signal_date, horizon_days)` and no additional composite index; `EXPLAIN (ANALYZE, BUFFERS)` run against the *exact* live query in `ml.router.ts:591-596` (`getModelRocDiagnostics`) shows Postgres does use `signal_outcomes_pkey` (`Index Scan ... Index Cond: (symbol = ts.symbol) AND (signal_date = ts.date)`) via a `Nested Loop` + `Memoize` over all 47,204 `technical_signals` rows — but it is **not** an Index-Only Scan (Round 2's description) at today's volume, and the measured **Execution Time was 1,436ms** (`Buffers: shared hit=317,266 read=7,133 dirtied=158` on the inner scan), a long way from Round 2's reported 6.4ms. `signal_outcomes` has grown to 237,816 rows since Round 2 (vs. 47,204 in `technical_signals`), which plausibly explains the gap — a query that was effectively free at a smaller table size now does real, measurable work. No DDL was applied to test a candidate fix (out of scope for a read-only pass), so whether a covering 2-column index would materially help remains unverified rather than proven — but the underlying premise of Finding #41 (this join has a real, non-trivial live cost) is now better supported by evidence than Round 2's retraction was.

---

## Priority Action Plan (Dimension 7 — consolidated, final after Round 4)

| # | Finding | Severity | Effort | Suggested order |
|---|---|---|---|---|
| 82 | `asm_gsm_fetcher.py` full-table surveillance-flag wipe — **live-confirmed actively occurring today** | Critical | Low | **Immediate — highest-confidence, highest-blast-radius fix in the audit** |
| 83 | `drift_detector.py`'s ML-confidence drift haircut permanently broken — **confirmed via signature mismatch** | Critical | Trivial | **Immediate — one-line fix, restores an entire safety mechanism** |
| 4 | `fundamentals_snapshot.py` active data corruption | Critical | Low | **Immediate** — same fix pattern already exists |
| 16 | `confluence_ml_engine.py` shuffled-KFold leakage | Critical | Medium | **Immediate** — inflated metric feeds `model_registry` |
| 17 | No promotion gate on 3/5 training pipelines | Critical | Medium | **Immediate** — a bad retrain can silently ship |
| 42 | `strategy_optimizer.py` writes global scoring weights with no OOS gate | Critical | Low | **Immediate** — affects every score platform-wide |
| 43 | `mf_sector_flow_fetcher.py` unconditional historical overwrite | Critical | Low | **Immediate — fix before this fetcher ever runs to completion** |
| 60 | Earnings-surprise features leak (period-end vs. announcement date) | Critical | Medium | **Immediate** — confirmed systematic look-ahead |
| 64 | 3 more fetchers copy the date.today()-NULL-everything bug, post-fix | Critical | Low | **Immediate** — same fix pattern, 3 more files |
| 106 | `getTechnicalPredictions` reads the wrong table — 5/7 v4 Technical Snapshot tiles (incl. `win_probability`) never render | High | Low | This sprint — one-line table swap in `technicals.router.ts` |
| 94 | `SmartMoneyMonitor.tsx` — entire panel fabricated, no backend call exists | High | Medium | This sprint — most severe frontend fabrication found |
| 89, 90 | `StockDetails` hardcoded Technical Scorecard + FII/DII card contradict real data on same page | High | Medium | This sprint |
| 88 | Fake 52-week high/low (wrong field used) | High | Trivial | This sprint |
| 100 | `IndexDetailPage.tsx` resolves constituents against wrong provider ID | High | Low | This sprint — fix already exists in sibling file |
| 80 | `movement_predictor.py` no promotion gate (6th confirmed instance) | High | Medium | This sprint — fold into the systemic promotion-gate initiative below |
| 84 | `preopen_fetcher.py` — dead feature, UPDATE always targets non-existent row | High | Low-Medium | This sprint |
| 51 | Max-pain formula has call/put OI swapped | High | Trivial | This sprint — directly wrong user-facing number |
| 52 | Option-chain Greeks parsed by unvalidated hardcoded column position | High | Medium | This sprint — same bug class that cost 2.1M rows once |
| 73, 74, 75 | Fabricated/random data in Greeks tiles, MF/FII-DII panel, v1/v2 candlestick charts | High | Medium | This sprint — direct user-facing fabrication |
| 97 | `TradeDecisionCockpit.tsx` — 4/5 "Factor Breakdown" scores are client-invented | High | Medium | This sprint — the surface most directly informing a trade decision |
| 6 | Split/dividend adjustment seam | High | Medium | This sprint |
| 10 | MACD scanner one-sided bullish-only | High | Trivial | This sprint |
| 25 | Unused correct momentum factor / naive one live | High | Medium | This sprint |
| 27 | No cross-position correlation control | High | Medium-High | This sprint (start with sector cap) |
| 29 | Trailing stop never applied to live positions | High | Medium | This sprint |
| 30 | No sector cap / drawdown de-risk | High | Medium | This sprint |
| 33, 34 | Correlated subquery + unbounded OHLCV scan — **live-confirmed, 9x and 5.5x** | High | Low | This sprint — cheap, high-value, now measured |
| 37 | 83k-statement sync run | High | Low | This sprint — helper already exists |
| 45, 70 | `ml_signal_scorer.py`/`dl_engine.py` no promotion gate | High | Medium | This sprint — systemic MLOps gap, fix as one initiative |
| 47 | Backtester uses live ASM/GSM flag retroactively | High | Medium | This sprint |
| 65, 67 | Snapshot-only table / no-upper-bound backfill leak future data into past rows | High | Low-Medium | This sprint |
| 3, 59, 63 | Retry/backoff rollout gap (now ~20 files confirmed across all rounds) | High | Low-Medium | Next sprint — do as one bulk rollout, not file-by-file |
| 18, 19, 20 | ML CV/tuning leakage details | High | Medium | Next sprint |
| Remaining Medium/Low | ~64 findings (incl. new #107 `V3Dashboard.tsx` fake "Warren AI" live-inference illusion, #108 unmemoized advancers/decliners) | Medium/Low | Low-Medium | Backlog, batch into a cleanup pass |

**Self-attack check (per this codebase's own `fable-brain.md` discipline):** the strongest objection to this audit is that several "gaps" (no cross-position correlation, no factor-crowding check, hand-set regime tilts) are architecturally hard, not bugs — they may be deliberate scope cuts given the documented Phase 3-6 roadmap in `CLAUDE.md`. That's a fair read for Findings #27, #28, #30, #31, which are marked accordingly as gap-analysis (Dimension 4), not correctness bugs. Two cross-cutting systemic patterns identified in Round 2 were specifically hunted for in Round 3 via a repo-wide grep sweep (not just opportunistic discovery while reading unrelated files), which is exactly what found Findings #82 and #83 before either file was opened: **the "no promotion gate on a model/weight-writing pipeline" pattern now has 6 confirmed instances** (`confluence_ml_engine.py`, `cs_ranker.py`, `online_learner.py`, `ml_signal_scorer.py`, `dl_engine.py`'s LSTM path, `movement_predictor.py`) and **the "date.today()-anchored NULL-everything write guard" pattern now has 5 confirmed instances found after the original 2026-07-25 fix was believed to have closed it** (`fundamentals_snapshot.py`, `mc_pricefeed_fetcher.py`, `mc_chart_patterns_fetcher.py`, `nt_dashboard_fetcher.py`, `asm_gsm_fetcher.py` — the last one now live-confirmed as the worst instance, a full-table wipe rather than a single-symbol one). A third pattern emerged this round that wasn't visible until frontend coverage was complete: **direct fabrication of financial data in the UI** now has double-digit confirmed instances (`SmartMoneyMonitor.tsx`, `SeasonalityCalendar.tsx`, `Watchlist.tsx`, multiple `App.tsx` components, `TradeDecisionCockpit.tsx`, `SlideOutDrawer.tsx`, `MarketIndices.tsx`) — this is now a systemic frontend-trust issue, not a handful of isolated placeholders, and probably warrants a dedicated policy (e.g. a lint rule or code-review checklist item banning `Math.random()`/hardcoded literals in any component that renders inside a "real data" card) rather than continuing to fix them one at a time as they're discovered.

**Round 4 self-attack:** the fourth systemic pattern this round adds — a client-side template dressed up as a live AI inference (`V3Dashboard.tsx`'s "Warren AI," Finding #107) — is a narrower claim than the other three; unlike the promotion-gate and date-anchor patterns (found via grep, mechanically identical across files) or the frontend-fabrication pattern (literal wrong numbers), this one is a single confirmed instance, not (yet) a repeated pattern across files — it's flagged as its own finding rather than folded into Finding #91's existing bucket specifically because the mechanism differs (fake latency/branding around otherwise-real data, vs. literal fabricated numbers), and a future pass should grep for `setInterval`+typewriter-reveal patterns near any "AI"/"cognitive"/model-name branding to check whether this is actually a fourth systemic pattern or a one-off. Finding #41's Round 4 revision is also worth scrutinizing rather than trusting outright: the 1,436ms measured this round is a single cold(ish) run against a live, concurrently-written production table (`Buffers: ... read=7,133 dirtied=158` indicates real disk I/O and hint-bit writes, not a fully warm cache), so the number is real but not necessarily the steady-state cost under normal query load — it should be read as "materially non-trivial today," not as a precise, reproducible benchmark.

**Coverage after Round 4 is effectively complete** for the codebase's production surface: every Python file in `src/server/` (excluding test/exploratory scripts and the test suite itself), `src/App.tsx` in full, all `src/components/*.tsx` files, and all `src/v3/`/`src/v4/` files have now been read at least once. All seven Dimension-5 performance findings (#33-#41) have now been live-verified against production Postgres, either via `EXPLAIN ANALYZE`/`pg_indexes` (#33, #34, #36, #40, #41) or direct code/config inspection for the two that aren't SQL-shaped (#35, #38, #39, plus #37's row-count check). What remains genuinely unaudited: the Python test suite itself (deliberately out of scope — used only to confirm/refute findings, never as code under test), and — as with any point-in-time audit of a live, still-changing codebase — anything committed after this round's read passes. Given how much the grep-first approach has paid off across Rounds 3 and 4 (2 Critical findings in Round 3 found before any file was opened; Round 4's schema cross-reference for Finding #106 found a wrong-table bug that a single-file read of either the frontend or the router alone would have missed), any future audit pass on this codebase should keep leading with systemic sweeps — grep for known patterns, and cross-reference frontend field names against the actual schema of the table each backend procedure queries — before opening files individually.

---

## Fix Status (2026-07-30 remediation pass)

All 9 Critical findings from the "Immediate" bucket of the Priority Action Plan above are now **FIXED and live-verified** against the production Postgres DB:

| # | Finding | Fix | Live verification |
|---|---|---|---|
| 82 | `asm_gsm_fetcher.py` full-table wipe | Anchored to `MAX(date) FROM stock_ohlcv`; added explicit `WHERE date >= floor` so the UPDATE can only ever touch the current session | Confirmed 2026-07-29/30 rows now 100% populated (2189/2189, 30/30); older rows no longer touched at all |
| 83 | `drift_detector.py` broken drift haircut | Dropped the erroneous extra `_conn` arg and the now-pointless `conn` param | Confirmed the function now executes and returns a real value (0.85, correctly flagging live critical drift that had been silently swallowed) |
| 4 | `fundamentals_snapshot.py` date-anchor NULL bug | Added `_last_trading_session_floor()`, anchored the `pledge_chg_90d` guard to it instead of `date.today()` | Verified against live DB (floor correctly resolves to `2026-07-29`) |
| 42 | `strategy_optimizer.py` no OOS gate | `run()` now skips save/apply entirely when held-out test score regresses vs. baseline; `compute_screener_overrides()` now skips the whole override batch on negative aggregate holdout correlation | Live-verified: positive correlation (0.809) correctly passes 886 overrides through |
| 43 | `mf_sector_flow_fetcher.py` unconditional overwrite | Bounded the feeding SELECT to `date >= floor` | Live-verified: only the current session's 13 rows written, zero historical rows touched |
| 60 | Earnings-surprise look-ahead leak | Added `PERIOD_LAG_DAYS` (quarterly=60, annual=90) publication-lag filter before a row counts as "knowable" | Live-verified against real DB (364 symbols pass the lagged filter) |
| 64 | 3 fetchers with the date.today()-NULL bug | `mc_pricefeed_fetcher.py`, `mc_chart_patterns_fetcher.py`, `nt_dashboard_fetcher.py` — renamed guard param to `ts_floor`, anchored to `MAX(date) FROM stock_ohlcv` in each `main()` | Live-verified per-file: real values only ever land on the floor-date row, no history touched |
| 16 | `confluence_ml_engine.py` shuffled-KFold leakage | Query now returns `signal_date`; `build_training_data` sorts chronologically; `train()` switched from `StratifiedKFold(shuffle=True)` to `TimeSeriesSplit(gap=embargo)` (embargo formula mirrors `ml_ensemble.py`'s `_fit_stack`) | Live-verified: the leaked metric was **0.847 AUC**; the corrected purged walk-forward metric is **0.733 AUC** — an ~11pt inflation now closed |
| 17 | No promotion gate on 3/5 training pipelines | Added champion/challenger gates to `confluence_ml_engine.py` (piggybacked on the #16 fix), `cs_ranker.py` (`CS_PROMOTION_MARGIN=0.01`), and `online_learner.py` (registry-honesty gate, since `partial_fit` has no clean rollback) | Live-verified: `cs_ranker`'s baseline reads correctly (rho=0.079); `online_learner` confirmed **54 stale `is_active=1` rows** already accumulated in production from the pre-fix code, exactly the predicted defect |

64 new/updated regression tests added across 10 test files (`test_asm_gsm_fetcher.py`, `test_drift_detector.py`, `test_fundamentals_snapshot.py`, `test_mf_sector_flow_fetcher.py`, `test_finding64_ts_floor_fetchers.py`, `test_earnings_beat_features.py`, `test_confluence_ml_engine.py`, `test_strategy_optimizer.py`, `test_cs_ranker_promotion_gate.py`, `test_online_learner_promotion_gate.py`); full suite (659 tests, `src/server/tests/` + `src/server/__tests__/`) passes with zero regressions.

## Fix Status Update (2026-07-30, second pass)

Closed the Finding #17 gap noted above (all 6 confirmed no-promotion-gate instances now fixed) and worked through a large slice of the High-severity "This sprint" bucket. All fixes below are live-verified against production and covered by new regression tests (full suite: 715 passed, 0 failed after this pass).

| # | Finding | Fix | Live verification |
|---|---|---|---|
| 17 (remaining 3) | `ml_signal_scorer.py`, `dl_engine.py` LSTM path, `movement_predictor.py` — no promotion gate | Added champion/challenger gates to all 3 (`CANONICAL_WRITE_TOLERANCE`, `LSTM_PROMOTION_MARGIN`+timestamped config backup, `MOVEMENT_PROMOTION_MARGIN`). `ml_signal_scorer.py` also had a live query bug fixed in passing (`ts.scan_date` doesn't exist, real column is `ts.date` — the script had never successfully run against Postgres) | `ml_signal_scorer.py`: live-verified end-to-end (233,426 rows, CV AUC 0.600, correctly gated against the canonical ensemble's 0.586 baseline). `movement_predictor.py`: live-verified reading the real active model's stored test_auc (0.774) |
| 106 | v4 `getTechnicalPredictions` reads the wrong table | Pointed at `technical_signals` with `ORDER BY date DESC LIMIT 1`; dropped the unrenderable `sma20` key from `StockIntelligencePage.tsx` | Type-checked clean |
| 88 | Fake 52-week high/low (`stock.high + 100`) | Now reads the real `stock.high52w`/`low52w` fields | Type-checked clean |
| 100 | `IndexDetailPage.tsx` wrong provider ID | Reused `MCIndexDetailPanel.tsx`'s already-correct `resolveConstituentSymbol()` (exported it) instead of duplicating the buggy match | Type-checked clean |
| 51 | Max-pain call/put OI swapped | Swapped back; matches the correct pattern already used in `pcr_fetcher.py`/`nt_oi_snapshot_fetcher.py` | 3 tests constructed to empirically discriminate correct-vs-buggy output (not just plausible-looking numbers) |
| 10 | MACD scanner structurally bullish-only | Added the missing `else if (macd === 'Bearish')` branch | Type-checked clean |
| 33 | Correlated subquery in `confluenceEngine.ts` + `misc.router.ts` | Rewrote both as `ROW_NUMBER() OVER (PARTITION BY symbol ...)` (portable across SQLite/Postgres, unlike `DISTINCT ON`) | Live-verified identical result sets against production (2262/2262 symbols matched exactly); found and fixed a latent non-determinism bug in the same query while verifying (no tiebreaker on ties → different query plans returned different arbitrary 200-row subsets) |
| 34 | Unbounded `stock_ohlcv` scan in `technicalSignalsService.ts` | Added a 300-day lower bound alongside the existing upper bound | Live-verified: 2,606,042 → 472,416 rows (81.9% reduction, matching the audit's own 18.1%-utilization measurement almost exactly) |
| 37 | `etMarketstatsSync.ts` ~83k-127k sequential statements | Batched via the existing `rowGroups()`/`bulkUpsert()` helpers (same pattern already used correctly in `confluenceEngine.ts`) | Live-verified end-to-end against real Postgres incl. the `ON CONFLICT DO UPDATE` path |
| 52 | Option-chain Greeks parsed by hardcoded column position | `_build_col_map()` now resolves every field from the response's own `tableHeaders[i]['unique_name']` at parse time; raises a clear `RuntimeError` naming the missing field on any mismatch instead of silently mis-reading | Live-verified against a real RELIANCE option chain (106 real strikes, correct Greeks); test suite includes a synthetic column-swap that proves the dynamic map actually follows a reorder |
| 47 | `backtester.py` used today's live ASM/GSM flag across the whole backtest window | Removed `_load_surveillance_symbols()` entirely; `load_signals()` now carries each signal's own `technical_signals.asm_flag`/`gsm_stage` (true point-in-time, from the exact session the signal fired) | Live-verified: `load_signals()` returns 152 real rows, 11 with a real (non-null) asm/gsm value, rest correctly NULL (unknown, not excluded) for pre-fix historical dates |
| 65 | `extra_features_parser.py` backfilling from a snapshot-only table | Added a fetched-date guard: only writes onto the `technical_signals` row matching `extra_endpoint_responses.updated_at`'s actual date, skips (doesn't fabricate) otherwise | Live-verified: correctly skipped 26/26 symbols today because the cached snapshot predates today (fetcher hadn't run yet) — proves the guard is live and conservative |
| 67 | `hv_features.py` no upper OHLCV date bound | Added `date <= target_date` (or today) alongside the existing lower bound | Live-verified a real `--date`-bounded backfill run against RELIANCE |
| 6 | Split-adjustment basis seam between `mc_ohlcv_backfill.py` (split-only) and `backfill_ohlcv.py` (split+dividend) | **Partial fix, deliberately scoped down from a full price-math rewrite** (assessed as too high-risk to attempt without dedicated validation time): added an `adjustment_basis` column, tagged at all 3 row-producing code paths across both files (`split_only`, `split_dividend`, and a previously-undocumented third basis `unadjusted` found in `backfill_ohlcv.py`'s gap-fill path, which hits Yahoo's raw chart API with no adjustment at all). This is Finding #6's safer option (b) — it does not rewrite the actual price-adjustment computation. **Follow-up still needed**: wire `relative_strength.py`/`ml_ensemble.py`/`breakout_classifier.py` to detect/correct a straddling return window using the new column | Live-verified: real ITC.NS dividend adjustment magnitude measured directly via yfinance (~2.65% shift over a 90-day window, confirming the seam is real and material, not theoretical); schema migration + full upsert path (incl. `ON CONFLICT`) verified end-to-end against production Postgres |
| 25 | Naive (non-skip-month) 63-day momentum in `relative_strength.py` | Added `_windowed_return()`: the 63-day window now computes return from (t-63) to (t-21), excluding the most recent ~month, per Jegadeesh-Titman — applied only to the 63-day window (21-day is intentionally left as short-horizon momentum, too short to sensibly skip a month from). Chose this over wiring the already-correct-but-unscheduled `multi_factor_scorer.py` into `unified_ranker.py`, which would require rebalancing every regime's engine weights (a bigger, higher-risk change to the canonical ranker, similar in scope to the dedicated `REGIME_WEIGHTS` rebalance session) | Live-verified end-to-end against real production OHLCV (19,271 rows, 12,948 features computed); test suite includes a synthetic run-up-then-reversal case proving skip-month momentum stays positive when naive momentum would be dragged down by the recent reversal |

## Fix Status Update (2026-07-30, third pass — frontend fabrication cluster + #29)

| # | Finding | Fix | Live verification |
|---|---|---|---|
| 94 | `SmartMoneyMonitor.tsx` fully fabricated, no backend call at all | New `getSmartMoneyFlow` procedure (`fundamentals.router.ts`) ranks the whole universe by real quarterly promoter/FII/MF ownership-change data already in `technical_signals` (mf_chg_qoq as the DII proxy — the closest real column this table has); component rewired to consume it with proper loading/error/empty states and an "as of" date disclosure (data is quarterly, not daily) | **Full end-to-end browser verification**: navigated the real running app to Smart Money → MF/FII Flows tab, confirmed the network request returns 200 OK, confirmed both Accumulation/Distribution toggles fire correct fresh requests, confirmed rendered rows show real company names/net-flow %/as-of dates matching direct DB queries exactly (e.g. AAATECH +35.20%, matches DB) |
| 89 | Hardcoded "Technical Scorecard" (fake RSI/MACD/Bollinger/pivots) contradicting the real Technical tab on the same page | Wired `StockDetails` to the same `getTechnicalDetails` query the sibling `TechnicalAnalysis` component already uses correctly; RSI/MACD/Bollinger now read real `indication`/`value` fields, pivots read the real `pivotLevels.Classic` object instead of `stock.high±10` | Type-checked clean; field names live-confirmed against a real MoneyControl API response (RELIANCE) fetched directly — `displayName`/`indication`/`pivotLevels[].key` shapes match exactly. Full click-through browser verification not completed (search-box autocomplete wasn't reachable via the accessibility tree in this environment) |
| 90 | Hardcoded "Institutional Flow (FII/DII)" card, identical every stock/session | Wired to `trpc.getFiiDiiFlow`, relabeled "Market-Wide" since this is genuinely market-level (not per-stock) data — the closest real data this platform has, matching what the audit itself pointed at | Type-checked clean; `getFiiDiiFlow`'s return shape confirmed by reading the router source directly |
| 97 | `TradeDecisionCockpit.tsx` "Factor Breakdown" — 4/5 bars are client-invented, shown with equal visual weight as the 1 real ML score | Chose the audit's lower-risk option: relabeled the 4 derived bars "(derived)", added a tooltip distinguishing "Validated ML model output" from "Client-side heuristic, not a calibrated model score", dimmed their bar opacity — did not move the scaling logic to the backend (a larger initiative) | Code-reviewed against the finding; no backend change needed to verify |
| 29 | Correct ATR chandelier trailing stop existed only in offline backtest grading, never touched a live position | Built a new `trailingStopUpdater.ts` (`max(current_stop, highest_high_since_entry − 3×ATR)`, reusing `wilderATR()` from `atrBarriers.ts` for consistency with entry-time barriers), wired as a new in-process step in `ml-daily-ops`. **Discovered a blocking prerequisite bug while verifying**: `recommendation_log` — the table this finding's own suggested fix targets — had **100% NULL `entry_price`/`stop_loss`** on all 10,969 currently-ACTIVE rows, because `scoring_engine.py`'s `_log_recommendations()` (the dominant writer by volume: 21,324 of ~23,500 total rows) never included those fields in its INSERT at all. Fixed that too: added a batched price+ATR lookup (`technical_signals.cmp` + `confluence_signals.atr`) and `compute_atr_barriers()` (the same Python function `atrBarriers.ts` mirrors) to populate real entry_price/stop_loss/target_1 going forward. Neither fix has value without the other — the trailing-stop updater needs real positions to act on, and the entry-price fix needs a consumer that actually revisits the stop over time. | **Full live verification chain**: (1) confirmed the 100%-NULL bug directly via SQL; (2) ran the fixed `_log_recommendations()` against a real symbol (RELIANCE), confirmed real entry_price=1275.90/stop_loss=1250.38/target_1=1314.18 written and read back correctly, cleaned up; (3) inserted a synthetic ACTIVE position (entry 2026-06-01, stop 1100.0) and ran the real `trailingStopUpdater.ts` against it — confirmed the stop correctly ratcheted UP to 1282.61 (never down), cleaned up |

**Not yet fixed as of this (third) pass**: #73/#74/#75, portfolio gaps #27/#28/#30/#31, retry/backoff rollout #3/#59/#63, ML CV leakage #18/#19/#20 — **all closed in the fourth pass below**, except #31 which is deliberately deferred. Also newly flagged, not yet fixed: `scoring_engine.py`'s `_log_recommendations()` fix only computes barriers for symbols with a `technical_signals` row on the latest date — candidates missing that row still get NULL entry_price (a much smaller residual gap than the 100%-NULL state before this pass, not measured precisely; still open).

## Fix Status Update (2026-07-30, fourth pass — closes the entire remaining Priority Action Plan)

| # | Finding | Fix | Live verification |
|---|---|---|---|
| 41 | `signal_outcomes` has no composite index for its most common join | `CREATE INDEX idx_sout_symbol_date ON signal_outcomes(symbol, signal_date)` via a new `node-pg-migrate` migration | `EXPLAIN ANALYZE` on the exact live query confirms Postgres now picks `Index Scan using idx_sout_symbol_date` instead of the prior Nested Loop + Memoize fallback over the two single-column indexes. Absolute wall-clock timing on this specific run was confounded by heavy concurrent job load on the box (a `Seq Scan` on the much smaller `technical_signals` table alone took 76s) — the plan-level fix (the actual finding) is confirmed regardless of that noise |
| 18 | Hyperparameter tuning evaluated on folds overlapping the later "held-out" test window | Extracted `_compute_holdout_split()` (the exact date-based boundary `train_ensemble()` already used) into a shared helper; `run()`'s `--tune` path now slices `X`/`y`/`weights` to the pre-holdout region before calling `tune_hyperparameters()`, instead of tuning on the full dataset | Live dry-run (`ml_ensemble.py --train --dry-run`, no `--tune` — the refactored `train_ensemble()` path) completed cleanly, HELD-OUT TEST AUC=0.582, Stacking purged-OOF AUC=0.684, no regression vs. pre-fix behavior. 3 new unit tests assert the shared helper's boundary math directly |
| 19 | `REGIME_MAP` collapses HIGH_VOL/CRASH into SIDEWAYS's 0.0 encoding | Expanded to `{'BULL':1.0,'SIDEWAYS':0.0,'HIGH_VOL':-0.5,'BEAR':-1.0,'CRASH':-2.0}` — all 5 regimes now get distinct values, ordered by risk-off-ness matching `_REGIME_THRESHOLDS`' own severity ordering | Live dry-run confirmed no crash with the new encoding; the regime-balance inverse-frequency weighting (which buckets by the encoded value) now also correctly separates HIGH_VOL/CRASH into their own buckets as a beneficial side effect. **Note: a full retrain is required for the model to actually learn from the new distinct encoding — the code fix alone doesn't retroactively improve a model trained under the old 3-value map** |
| 20 | `cs_ranker.py` train/test split has zero embargo despite 5-day-forward labels | Extracted `_compute_date_split()` with a `HORIZON_DAYS_LABEL=5` trading-day embargo between the last training date and first test date | Live-run `cs_ranker.py --train` against real data: 10,351 rows/42 dates, held-out Spearman rho=0.1075 (still clears its own 0.10 promotion threshold post-embargo), registered as model_id=178 ACTIVE |
| 21 | `online_learner.py`'s own 80/20 val split also has zero embargo (not originally numbered in this pass's scope, but the audit's own text flags it as becoming load-bearing once Finding #17 is fixed — which it already was) | Extracted `_embargoed_train_end()`, a row-count estimate (median horizon × samples/day) of how many training rows near the val-split boundary to drop | Live dry-run (`online_learner.py --dry-run`) against 237,300 real outcomes completed with no crash |
| 27, 30 | Position sizing has zero cross-position correlation control / no sector-concentration cap | `normalize_position_sizes()` gained an optional `sectors` map + `MAX_SECTOR_EXPOSURE=0.30` (cheap first-order approximation of risk parity's covariance term, per the audit's own suggested cheap fix) — if a sector's aggregate weight exceeds the cap, every position in that sector scales down proportionally | Live-verified via temporary inline debug instrumentation in the real `run()` call (a before/after DB snapshot comparison was confounded by a concurrent scheduled job overwriting the table mid-verification — see memory gotcha): the `Unknown` sector bucket (186/199 sized positions, the largest bucket that day) landed at exactly 0.2996, correctly under the 0.30 cap |
| 28 | Orthogonal 5-factor model (`multi_factor_scorer.py`) exists but is a dead branch — never scheduled, no factor-crowding check | Scheduled in `queues.ts`'s `ml-daily-ops` chain (was live-confirmed 0/2420 `quant_scores.mf_*` rows populated before this fix); added `factor_crowding_multiplier()` in `unified_ranker.py`, discounting (×0.90) names where >70% of the weighted deviation-from-neutral across the 5 factors traces to a single factor | Live-ran `multi_factor_scorer.py` directly: 2420/2420 stocks updated. Live-ran `unified_ranker.py` afterward: completed cleanly (3931 stocks scored), factor-crowding check active (0 names crowded on this particular BEAR-regime day — a plausible, non-error outcome, not verified as a false negative) |
| 31 | Regime-conditional weight tilts are hand-set, never backtested | **Deliberately not coded** — the audit's own actionable correction requires accumulated regime-labeled outcome history that doesn't exist yet; forcing a fit now risks the same overfit-then-write bug Finding #42 already fixed in the same file (`strategy_optimizer.py`) | N/A — documented as a "close the loop later" item, consistent with the audit's own framing |
| 3, 59, 63 | Retry/backoff rolled out to only 3 of ~47 fetchers | Adopted `fetch_utils.py`'s `retry_get` across all 15 remaining flagged fetchers | Live-verified 3 fetchers end-to-end against real third-party endpoints (NiftyTrader, MoneyControl) — retry integration works, no regression in pre-existing graceful-degradation behavior. Full detail incl. the 2 status-code special cases (404-as-holiday, 401/403-as-auth) and 2 stale-test-mock fixes in `retry_backoff_rollout_2026_07_30.md` memory |
| 73 | OptionChain Greeks tiles fabricated (`Math.random()`) | Real OI-weighted portfolio aggregate across the full chain, using `callGamma`/`putGamma` fields the backend already sends but the frontend never read | Type-checked clean; network-level confirmed real chain data flows into the same component |
| 74 | MFAnalysis fully fabricated, `symbol` prop never used | The per-fund-holder live endpoint (`mf_holding`) confirmed dead via direct curl (404) — no per-fund data source exists anywhere in this codebase. Rewired to `getShareholding` (real aggregate MF/FII/DII/promoter % + QoQ, live-verified via curl) and `getFiiDiiFlow` (real market-wide series, labeled "Market-Wide" per the Finding #90 honesty precedent). Also dropped the adjacent hardcoded "SIP Return Explorer" (not in this finding's original 2-item scope, same fabrication pattern, flagged rather than silently left) | `getShareholding`/`getFiiDiiFlow` response shapes independently curl/DB-verified before wiring; network-level confirmed the component fires real queries with real symbol params in a live browser session |
| 75 | v1 (`App.tsx` `StockDetails`) + v2 (`V2StockDetails.tsx`) generate fake candles that real pattern-detection runs on top of | Both replaced with the real `getOHLCData` procedure (same one v4's `StockIntelligencePage` already used correctly). v1 also needed VWAP/Bollinger, computed with the same formulas the old code used but now over real OHLCV | TypeScript clean; network-level confirmed in a live browser session that `getOHLCData({symbol:"RELIANCE", dur:"6M"})` fires with real params and returns 200 OK from the exact component that was fixed. **Verification note**: stops short of a pixel-verified screenshot — the SlideOutDrawer's rendered DOM wasn't reliably captured by this environment's accessibility-tree tooling (same limitation as Findings #89/#90) |

**Everything from the original Priority Action Plan is now fixed**, except Finding #31 (deliberately deferred, documented above). Full suite: 741 Python tests pass (0 failures), `tsc --noEmit` clean across the whole project.

## Fifth pass (2026-07-30) — full-platform re-audit: ground-truth inventory, endpoint/date-anchor sweep, bias re-check, strategy spec

A fresh top-to-bottom pass covering the entire write-side (~180 `.py` files under `src/server/`, ~140 of which write to the DB — well past the ~30-40 estimate this doc started from) and read-side (26 tRPC router files, 139 Postgres tables — also past the ~126 estimate), specifically hunting for **new** instances of this repo's two most recurring bug classes (`date.today()`-anchored NULL guards, and unconditional model overwrites) plus anything the four prior passes hadn't reached. Four parallel read-only research agents built the ground-truth inventory (fetcher→table→column→consumer, job registry cross-check, CV/promotion-gate audit); two Critical/High findings were fixed and live-verified inline, matching this session's established practice.

### Phase 0 — Ground-truth inventory (condensed; full detail was gathered live, not re-derived from memory)

- **~140 Python files write to the DB** (not ~30-40) — a fetcher/engine/table/column/consumer map was built for all of them. Full CV-split and promotion-gate status for every model-training file is in the table below.
- **139 Postgres tables** (not ~126). Two are confirmed **dead** — `chart_patterns` and `institutional_rankings` — no `.py` or `.ts` file anywhere writes to either (grep-verified: the only string-literal hits are an unrelated cache-key `'chart_patterns'` in `mcApiService.ts` and a comment referencing the *differently-named* `mc_chart_patterns_fetcher.py`). Both also have **no PRIMARY KEY or UNIQUE constraint at all**, which would make any future writer's upsert unsafe (full delete+insert only) — worth fixing at the same time either table is ever revived, not before.
- 18 more tables have only a surrogate `id` PK and no natural-key UNIQUE (`model_registry`, `recommendation_log`, `rl_episodes`, `todos`, etc.) — fine for intentionally append-only logs, flagged only because a future `ON CONFLICT` upsert against any of them is impossible without a migration.
- `unified_recommendations.engine_coverage_count` (added in the 2026-07-24 in-place-rebuild pass, populated by `unified_ranker.py`) is confirmed **write-only** — zero tRPC procedures select it, and `scoringService.ts`'s `mapRecToScoredStock()` explicitly whitelists the columns it forwards to the frontend, silently dropping it. Not a bug (nothing depended on it), but a completed feature that never shipped its second half — cheap to surface in `getCommandCenter`/`getBuyRecommendations` whenever product wants an "engine agreement" confidence indicator in the UI.
- `getTechnicalPredictions` (the Round-4-fixed table-name bug, Finding #106) was re-verified this pass and confirmed **not regressed** — still correctly reads `technical_signals`.
- Job scheduling cross-check: **zero cron-drift** between `queues.ts` and `jobRegistry.ts` (every registered id's cron matches exactly). One real gap found: **`job-digest` itself (`45 18 * * *`, daily) has no entry in either `JOB_REGISTRY` or `MONITOR_SCRIPTS`, and its worker never calls `recordHeartbeat`** — the one job whose entire purpose is monitoring everything else is itself completely unmonitored. Low blast-radius (it's a notification job, not a data pipeline) but flagged for whoever next touches `jobWatchdog.ts`.
- Two scheduling smells, not bugs: `company-profiles-sync` runs `0 4 * * *` — **every day including weekends**, at 09:30 IST (during market hours), unlike every sibling daily sync which is Mon-Fri and off-hours; and `preopen-snapshot` runs at 09:10 IST, only 5 minutes before the 09:15 market open — the tightest buffer of any premarket job in the schedule.

### Phase 1/2 — New findings this pass (severity per the existing Critical/High/Medium taxonomy)

| # | Severity | Finding | File:line | Status |
|---|---|---|---|---|
| 110 | **Critical** | `index_membership_fetcher.py`'s `backfill_technical_signals()` anchored its `date >= ? ELSE NULL` guard to bare `datetime.now()` with no `MAX(date)`-from-`stock_ohlcv` fallback — the **10th confirmed recurrence** of this repo's worst bug class. This job runs weekly via `nse-sync` on **Sunday 07:30 IST**, a non-trading day with no `technical_signals` row for "today" — so the anchor matched zero rows and every historical `is_nifty50`/`is_nifty100`/`is_nifty200`/`is_midcap150`/`is_smallcap250`/`nifty_tier` column was silently NULLed on every single run since this guard was added (2026-07-19) | `index_membership_fetcher.py:151` (pre-fix) | **FIXED** — anchored to `MAX(date) FROM stock_ohlcv`, falling back to `datetime.now()` only if `stock_ohlcv` is empty. Live-verified against production: non-null `nifty_tier` count went from 9,078 (stale residue from past mismatched runs) to 2,490 (exactly today's row count) — the correct, by-design state per this fetcher's own "no historical snapshot to backfill, NULL older rows explicitly" comment. 4 regression tests added (`test_index_membership_fetcher.py`), including one asserting the `MAX(date)` query precedes the UPDATE and one for the empty-table fallback path |
| 111 | **High** | `breakout_classifier.py` had **no promotion gate at all** — unlike all 7 sibling ML files in this codebase (all closed by name earlier in this doc), `train()` unconditionally overwrote `ml_models/breakout.pkl` on every non-`report_only` run regardless of whether the new fit's held-out test AUC beat the currently-deployed model. This is the single model in the platform with genuine validated live edge (purged-OOF AUC ~0.61, top-decile lift ~1.47×, per the `breakout_position_sizing` memory) — the worst possible model to lose silently to an unlucky retrain | `breakout_classifier.py:305-363` (pre-fix) | **FIXED** — added `_load_baseline_test_auc()`/`_breakout_promotion_decision()` (`BREAKOUT_PROMOTION_MARGIN=0.005`, matching every sibling), rejected candidates saved to `breakout.pkl.candidate` instead of overwriting the live model. Live-verified against the real production model file: current baseline test_auc=0.6656; a hypothetically worse candidate (0.6556) is correctly refused. 6 new regression tests (`test_breakout_classifier_promotion_gate.py`), mirroring `test_movement_predictor_promotion_gate.py`'s exact structure |
| 112 | Medium | `working_capital_fetcher.py`'s `update_technical_signals()` called `as_of_floor(features.get("year_ending"))` with **no `fallback=` argument** — on the rare path where `year_ending` is missing/unparseable, `as_of_floor()`'s own docstring explicitly warns this silently degrades to a bare `date.today()` (matching zero rows on this job's Sunday-only cron, making the whole UPDATE a silent no-op). Sibling `financial_ratios_fetcher.py` already threads a trading-session-anchored `today` through as `fallback=`; this file didn't | `working_capital_fetcher.py:205` (pre-fix) | **FIXED** — threaded `today` (computed once in `main()` via `MAX(date) FROM stock_ohlcv`, matching `financial_ratios_fetcher.py`'s exact pattern) through `process_stock()` → `update_technical_signals(..., today=today)`. 2 new regression tests |
| 113 | Medium | `live_screener_ml_ranker.py`'s `TimeSeriesSplit(n_splits=n_splits)` has no explicit `gap=` embargo, unlike every other CV site in the codebase (`ml_ensemble.py`, `cs_ranker.py`, `confluence_ml_engine.py`, `ml_signal_scorer.py` all pass `gap=embargo`) | `live_screener_ml_ranker.py:140` | **Assessed, not fixed this pass** — this model's label is same-day intraday resolution (a live-screener filter match's outcome by that day's close), not a multi-day-forward return; the sibling files' embargo exists specifically because their forward-return labels span several days past the split boundary and would otherwise leak into an adjacent fold. A same-day label has no such window to leak across a day-level split, so the missing `gap=` is a convention inconsistency, not a demonstrated leak — flagged for whoever next touches this file to either add `gap=1` for defensive consistency or leave a comment explaining why it's intentionally absent, rather than silently omitted |
| 114 | Informational | Dead tables `chart_patterns` (41 cols) and `institutional_rankings` (28 cols) — no writer anywhere, both also missing PK/UNIQUE | `db/schema.postgres.sql` | Not fixed — no runtime impact since nothing writes to them. Flag for a future schema-cleanup pass (drop, or wire a writer if the feature they were meant for still matters) |
| 115 | Informational | `job-digest` (`45 18 * * *`) has no `JOB_REGISTRY`/`MONITOR_SCRIPTS` entry and never calls `recordHeartbeat` — the monitoring job is itself unmonitored | `queues.ts:3227` | Not fixed — low blast-radius (notification-only job), flagged for `jobWatchdog.ts`'s next maintainer |
| 116 | Informational | `company-profiles-sync` runs 7 days/week at 09:30 IST (market hours + weekends) unlike every sibling daily sync (Mon-Fri, off-hours); `preopen-snapshot` runs at 09:10 IST, a 5-minute buffer before market open | `queues.ts` cron table | Not fixed — no observed failure, flagged as a scheduling smell worth revisiting given this repo's documented history of job-contention incidents |

**Everything else audited this pass came back clean, confirming prior fixes held**: all 5 previously-fixed CV/split mechanisms (`ml_ensemble.py` tuning-vs-eval boundary, `cs_ranker.py` embargo, `online_learner.py` embargo, `confluence_ml_engine.py` TimeSeriesSplit, `breakout_classifier.py` date-based purge) re-verified correct by direct code read, not assumed from memory. All 7 previously-gated ML files' promotion gates re-confirmed present and correctly wired. `REGIME_WEIGHTS` re-confirmed summing to exactly 1.0 across all 5 regimes. `multi_factor_scorer.py` re-confirmed scheduled (`queues.ts:670`) and its crowding multiplier re-confirmed reachable inside `unified_ranker.py.run()`'s live scoring loop, not dead code. `normalize_position_sizes()`'s sector-exposure cap re-confirmed present and correctly implemented.

### Live-datasource test coverage — the single largest open gap in this codebase

Of the **~140 Python files that write to the database**, only **9 have a `@pytest.mark.live_datasource` test**: the 3 extra-endpoint files (`extra_endpoints_fetcher.py`/`extra_features_parser.py`/`endpoint_registry.py`), `nse_ipo_calendar_fetcher.py`, `trendlyne_fno_activity_fetcher.py`, `trendlyne_adv_tech_fetcher.py`, `trendlyne_price_analysis_fetcher.py`, `trendlyne_screener_discovery.py`, and the shared `et_stats_client.py` helper. That means the mandatory rule this codebase adopted specifically because of the 2026-07-23 URL-as-symbol corruption incident — the one control that would have caught it — currently covers **~6% of the fetchers it's supposed to protect**. None of `moneycontrol_fetcher.py` (11 tables, the single broadest scraper in the platform), `mc_pricefeed_fetcher.py`, `mc_earnings_fetcher.py`, any `nt_*` NiftyTrader fetcher, `pcr_fetcher.py`, `fii_dii_fetcher.py`, `insider_transactions_fetcher.py`, `credit_rating_fetcher.py`, or `mc_broker_reco_fetcher.py` have one — despite several of these being previously-confirmed sites of real bugs (bad response shapes, column-position drift). This is flagged rather than fixed in this pass — writing ~130 live-network tests properly (one real ticker, the fetcher's own parser, a throwaway-DB round trip per the established pattern) is a multi-session undertaking on its own, not a drive-by. Recommended next step: prioritize the 9 fetchers feeding `unified_recommendations`-adjacent tables first (`moneycontrol_fetcher.py`, `mc_pricefeed_fetcher.py`, `fii_dii_fetcher.py`, `pcr_fetcher.py`), since those are both high-traffic and previously the site of this repo's worst incident.

### Phase 3 — Real-time prediction strategy: verdict

**No new model is warranted.** `unified_ranker.py`'s existing regime-weighted blend (screener + ml + cs + confluence + technical + dl + breakout, all 5 regimes correctly summing to 1.0, sector-exposure-capped, factor-crowding-discounted) already implements exactly the multi-source fusion this phase was asked to design — technical (`technical_signals`/`relative_strength.py`), fundamental (`fundamentals_history` point-in-time), ownership (`ownership_relative.py`/`mf_sector_flow_fetcher.py`), options (`iv_features.py`/`fno_rollover`), news (FinBERT via `confluence_ml_engine.py`'s inputs), and 5-screener confluence all already feed it as component scores, per the Scoring Authority section's own constraint against a parallel "final score." The gap was never architecture — it was the bias/gating bugs fixed across all five passes in this doc (the two new ones this pass included). The one legitimately open design question is `factor_edge.py`'s finding that Trendlyne's `m_score` shows **no forward edge** (rank IC ≈ -0.02 on a 2-week sample) — `factor_edge_history` should have enough accumulated dates by now to decide whether to down-weight or drop `m_score` from `scoring_engine.py`'s screener inputs; this is a data question to revisit with `factor_edge.py`'s own accumulated output, not something to guess at from this pass.

**Refresh-latency reality check, by source** (best case, given each source's own natural cadence, not job-scheduling): fundamentals/ownership are inherently daily-at-best (annual/quarterly filings, EOD MF disclosures) — no job-frequency change makes them "real-time." News/FinBERT can be near-real-time (RSS 15-min tier already exists) but scoring only picks it up at the next `confluence-compute` cycle (30-min) or `ml-daily-ops` (once daily) — the sentiment *input* is fast, the *consumption* is the bottleneck. Options/IV are intraday-capable (`iv_features.py` runs off `stock_options_oi`, itself refreshed by `pcr_fetcher.py`) but currently only computed in the daily ops chain — genuinely reachable at 15-min cadence if that mattered enough to schedule. Technical (OHLCV-derived) is already at its practical ceiling (`*/15` and `*/30` cron groups) given this is an EOD-bar-based system, not tick-level. Bottom line: the job cadence is not the bottleneck anywhere except options/IV; the fundamentals/ownership ceiling is the data source itself.

### Phase 4 — Backtesting framework: verdict

`backtester.py` already benchmarks against Nifty and (post-Finding-#47 fix) now carries each signal's true point-in-time ASM/GSM flag rather than today's — the reverse-survivorship bias this doc already fixed. Given this pass's confirmation that every training file's CV now uses proper date-ordered splits with embargo gaps (Findings #16/#18/#19/#20/#21, all previously closed, re-verified clean this pass), a backtest run today is no longer inheriting upstream leakage the way it would have before this doc's fixes. The one still-open structural question is Finding #31 (regime-tilt weights never backtested) — deliberately deferred pending accumulated regime-labeled outcome history, not attempted here for the same overfit-then-write risk already flagged. No new backtesting-framework change is recommended this pass; the framework is sound, its former inputs were the problem, and those are now fixed.

### Phase 5 — Multi-agent architecture: recommendation

**Keep quant engines authoritative; do not let agents decide trading signals.** This codebase already has the right shape — deterministic Python engines feed one blending ranker (`unified_ranker.py`), and the only LLM involvement (Ollama primary/Gemini fallback) is explicitly narrowed to narrative/explanation (`generateStockAnalysis`), gated behind quant checks before it's even called (the 2026-07-19 perf(ai) change), with its numeric outputs overridden entirely by `atrBarriers.ts` — a fix that exists specifically because LLM-hallucinated entry/target/stop levels were once a real production bug. A specialized-agent architecture (market-regime agent, per-stock agent, F&O agent, etc.) would reintroduce exactly the non-determinism and audit-cost this platform has spent five full audit passes removing from the numeric pipeline, for a problem (routing which data source informs a score) that a weighted blend already solves deterministically and cheaply. `mcpServer.ts` existing-but-unwired is not a signal to build a supervisor agent around it — it's more useful left as an ops/debugging surface than promoted into the trading-decision path. The one place LLM judgment has a genuine, narrow edge over deterministic code is **unstructured-text interpretation where no parser exists** — e.g., earnings-call/corporate-announcement free text where the signal is in language, not a number — and if that's ever built, its output must land as one more bounded component score `unified_ranker.py` ingests (e.g., a `-1..+1` sentiment-surprise score), never a free-floating verdict or a fourth score table.

### Phase 6 — Free/open-source tooling: verdict

| Candidate | Verdict |
|---|---|
| Replace Gemini fallback with another free-tier LLM | **No clear win.** Ollama is already local/free and primary; Gemini exists purely as a fallback for when Ollama is unreachable, and swapping it for a different free-tier API doesn't change the cost profile (both are already effectively free at this platform's LLM call volume, since calls are quant-gated per the 2026-07-19 change) — not worth the integration churn |
| NSE/BSE bhavcopy direct download to replace `mc_ohlcv_backfill.py` scraping for *daily incremental* OHLCV | **Worth a follow-up, not this pass.** NSE publishes daily bhavcopy CSVs directly (already the source `index_membership_fetcher.py` itself uses for index constituents) — for the daily incremental top-up (not the 26-year deep-history backfill, which needs MC's split-adjusted history bhavcopy doesn't provide), a direct exchange source would remove a scraping dependency and its associated fragility (the mcsymbol/raw-symbol keying bug, rate limits) for the highest-frequency OHLCV write path. Scoped out of this pass because it's a genuinely new fetcher requiring its own live_datasource test and careful reconciliation against the existing split-adjusted history — not a bias/correctness fix |
| Replace scikit-learn/LightGBM/CatBoost ML stack | **Not evaluated — out of scope per the task's own constraint.** Already free, already appropriate |
| Scraped MC/Trendlyne/ETnow/NiftyTrader endpoints generally | Already unpaid (scraped, not licensed APIs) — no paid-tier alternative would improve on "free," the actual risk with these is endpoint drift (addressed by the live_datasource test gap above), not cost |

### Documentation updates from this pass
CLAUDE.md's "Recent session notes" and the memory system were updated to reflect this pass — see the entries dated 2026-07-30 (fifth pass) there.
