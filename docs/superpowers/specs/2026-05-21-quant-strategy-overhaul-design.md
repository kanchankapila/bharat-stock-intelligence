# Quantitative Strategy Overhaul — Design Spec
**Date:** 2026-05-21  
**Approach:** C — Unified Overhaul (fix pipeline bugs + add 3 new strategies + integrate ML consensus)  
**Horizons:** Short-term (1–5d), Swing (5–15d), Medium-term (30–90d)  
**Benchmark ticker:** ADANIPORTS

---

## 1. Data Audit — Critical Bugs

### Bug 1 — `weight_override` silently discarded
**File:** `src/server/scoring_engine.py:392–408`  
**Problem:** `strategy_optimizer.py` writes per-screener `weight_override` to `screener_master` after every optimization run. `scoring_engine.py` computes `contrib = base_score × cat_weight × src_weight × sentiment_mult × recency × dedup` but never reads `weight_override`. Every optimization cycle is silently discarded — the most granular ML signal has zero effect on live scoring.  
**Fix:** Load `weight_override` map from `screener_master` at `__init__` time; apply as an additional multiplier in the screener scoring loop:
```python
override = weight_overrides.get(scan_id, 1.0)
contrib = base_score * cat_weight * src_weight * sentiment_mult * recency * dedup * override
```

### Bug 2 — Per-screener override only covers Trendlyne
**File:** `src/server/strategy_optimizer.py:229`  
**Problem:** `compute_screener_overrides()` JOINs only `trendlyne_screener_stocks`. MoneyControl and ETnow screeners never receive per-screener quality tuning, making the optimizer blind to 2 of 3 data sources.  
**Fix:** Union all three source tables in the override query:
```sql
SELECT sm.scan_id, sm.name, sm.source, ...
FROM screener_master sm
JOIN (
    SELECT screener_id AS scan_id, symbol FROM trendlyne_screener_stocks
    UNION ALL
    SELECT scan_id, symbol FROM moneycontrol_screener_stocks
    UNION ALL
    SELECT screener_id AS scan_id, symbol FROM etnow_screener_stocks
) all_stocks ON all_stocks.scan_id = sm.scan_id
JOIN signal_outcomes so ON so.symbol = all_stocks.symbol
```

### Bug 3 — ML `win_probability` bifurcated from composite scoring
**Files:** `src/server/ml_ensemble.py`, `src/server/scoring_engine.py`, `src/server/rl_agent.py`  
**Problem:** `ml_ensemble.py` writes `win_probability` into `technical_analysis_signals`. `rl_agent.py` gates on `win_probability >= 0.40`. `scoring_engine.py` never reads it. Two independent scoring systems run in parallel with zero consensus check — the most valuable ML output is invisible to the primary ranking engine.  
**Fix:** After computing `final_score`, apply a consensus bonus:
```python
# Load latest win_probability per symbol from technical_analysis_signals
with self.engine.connect() as conn:
    wp_rows = conn.execute(text("""
        SELECT symbol, MAX(win_probability) AS wp
        FROM technical_analysis_signals
        WHERE created_at >= datetime('now', '-1 day')
        GROUP BY symbol
    """)).fetchall()
win_prob_map = {r[0]: r[1] for r in wp_rows}

# In final_score aggregation loop:
wp = win_prob_map.get(symbol, None)
if wp is not None and normalized_score >= 60 and wp >= 0.55:
    final_score *= 1.10  # +10% consensus bonus
```

### Bug 4 — Shutdown leak: 2 workers never closed
**File:** `src/server/queues.ts:629–650`  
**Problem:** `shutdownQueues()` `Promise.allSettled` array closes 10 handles but `etnowScreenerSyncWorker` and `trendlyneIntradayWorker` are absent. On SIGTERM these workers hang, preventing clean process exit and potentially corrupting in-flight jobs.  
**Fix:** Add both workers to the shutdown array:
```typescript
etnowScreenerSyncWorker?.close(),
trendlyneIntradayWorker?.close(),
etnowScreenerSyncQueue?.close(),
trendlyneIntradayQueue?.close(),
```

### Bug 5 — Group/universe screeners misclassified as bearish
**File:** `src/server/scoring_engine.py:17–31`  
**Problem:** The following ETnow screeners are hardcoded with `is_positive: 0` (bearish):
- `et-520` — The Tata Empire
- `et-518` — Adani Universe  
- `et-514` — PSU Gems
- `et-515` — Monopoly Biz

These are **thematic group/portfolio screeners**, not sell signals. Stocks like ADANIPORTS, TATASTEEL, and PSU names are being **penalized** every time they appear in their own conglomerate universe. This directly suppresses their composite scores.  
**Fix:** Change all four to `is_positive: 1`. Being in a "monopoly" or "blue-chip conglomerate" universe is a positive quality signal.

---

## 2. Hidden Correlations

### Correlation 1 — Trendlyne momentum/technical cross-category bleed
NLP inference assigns RSI/MACD-based screeners non-deterministically to either `momentum` or `technical` categories across runs. A stock in 4 RSI-based Trendlyne screeners can accumulate credit in both the `momentum` AND `technical` factor buckets simultaneously while `SOURCE_CAT_CAP = 2.5` only guards within a single `source|category|sentiment` bucket. The dedup mechanism is blind to this cross-bucket signal repetition.  
**Fix:** Add `signal_type_tag` column to `screener_master` (values: RSI/MACD/VOLUME/PRICE_ACTION/FUNDAMENTAL/VALUATION/SECTOR). Dedup at `source|signal_type_tag|sentiment` level instead of `source|category|sentiment`.

### Correlation 2 — News dominates without intra-week decay
All news within the 7-day query window receives recency weight ≈ 1.0 — the 30-day half-life barely moves within a single week. News (weight 1.2) already outranks fundamentals (1.0); without intra-week decay, a 6-day-old speculative rumor and a 30-minute-old earnings release carry identical weight and can single-handedly flip a stock classification.  
**Fix:** Apply a 2-day half-life decay within the news window:
```python
# In news scoring loop, replace existing recency calculation:
age_hours = (datetime.now() - published_at).total_seconds() / 3600
recency_news = math.exp(-math.log(2) * age_hours / 48)  # 2-day half-life
```

---

## 3. Three Advanced Trading Strategies

### Strategy 1 — Multi-Source Convergence Filter *(Swing: 5–15 days)*

**Thesis:** Cross-source agreement across all 3 independent data providers dramatically reduces false-positive rate vs single-source momentum signals.

**New function:** `crossSourceFilter()` in `src/server/scoringService.ts`

**Entry logic (all conditions required):**
- ≥1 bullish Trendlyne screener (NLP `inferred_sentiment = 'bullish'`)
- ≥1 positive MoneyControl screener (`is_positive = 1`)
- ≥1 positive ETnow screener (corrected `is_positive`)
- Composite normalized score ≥ 65
- Zero bearish screener appearances across all three sources

**Exit logic:**
- Target: +9% from entry (1.5× R:R)
- Stop-loss: −6% hard
- Time stop: day 15 regardless of P&L
- Invalidation: stock drops out of ≥2 sources within 3 days

**Position sizing:** Max 5% per position, max 4 concurrent = 20% max deployed.

**tRPC endpoint:** `getConvergenceSignals` — returns ranked list of cross-source confirmed stocks.

---

### Strategy 2 — Regime-Conditional Sector Rotation Momentum *(Medium-term: 30–90 days)*

**Thesis:** Sector rotation drives the majority of Indian large/mid-cap alpha. Entering top-rotating sectors only in BULL regime eliminates the worst drawdowns (sector momentum in BEAR regime produces −15 to −25% outcomes historically).

**New function:** `regimeSectorFilter()` composing existing `getRLPolicy` + `fetchTrendlyneSectorRotation`

**Entry logic (all conditions required):**
- Nifty regime = BULL from `rl_q_table` (via `getRLPolicy` endpoint)
- Stock sector is in top 3 by 30-day relative performance vs Nifty (from `fetchTrendlyneSectorRotation`)
- Stock in that sector's top performers for ≥2 consecutive weekly scans
- Composite score ≥ 60 AND ML `win_probability` ≥ 0.50 (ML consensus required)

**Exit logic:**
- Regime shifts to SIDEWAYS or BEAR → full exit within 2 trading days
- Sector drops out of top 3 for 2 consecutive weekly scans → exit
- Composite score drops below 45 → exit
- Hard stop-loss: −8% from entry
- Scale out: exit 50% at +15%, let remainder run with trailing stop

**Position sizing:** 8% per position, max 3 sectors, max 2 per sector = 48% max deployed.

**tRPC endpoint:** `getRegimeSectorSignals` — returns sector rotation state + qualifying stocks.

---

### Strategy 3 — Quality Oversold Mean Reversion *(Short-term: 1–5 days)*

**Thesis:** High-quality zero-debt businesses have a structural price floor. Institutional buyers absorb drawdowns on quality names, producing reliable 3–5 day mean reversions.

**New function:** `qualityOversoldScanner()` querying `etnow_screener_stocks` + `technical_analysis_signals`

**Entry logic (all conditions required):**
- In ETnow "Zero Debt Quality" (et-79) OR "Cash Cows" (et-73)
- RSI ≤ 35 (from `technical_analysis_signals`) OR in ETnow "RSI Oversold" (et-362)
- Zero bearish screener appearances (no negative fundamental flag)
- Composite score 40–65 acceptable (intentionally buying oversold quality)

**Exit logic:**
- Target: RSI recovers to 50 OR +5% from entry — whichever first
- Stop-loss: −4% (tight — quality stocks don't break support cleanly)
- Time stop: day 5 regardless
- Breakdown override: if RSI moves 35 → 28 (acceleration down), exit immediately

**Position sizing:** 3% per position, max 5 concurrent = 15% max deployed. Scale in over 2 days (50% day 1, 50% day 2).

**tRPC endpoint:** `getQualityOversoldSignals` — returns qualifying stocks with RSI levels and entry zones.

---

## 4. ADANIPORTS Deep-Dive Analysis

### Fundamental Edge
- India's largest port operator: ~25% of total national cargo
- Revenue CAGR ~18% over 5 years; driven by India export growth + China+1 shift
- 30-year government concession licenses — structural barrier to entry
- Net debt/EBITDA 3–4× (infrastructure-normal, not distressed); DSCR ≥ 1.8×
- 99% capacity utilization at Mundra — pricing power structural not cyclical
- Logistics park adjacency creates multi-year switching cost lock-in

### Scoring System Impact (Bug 5)
ADANIPORTS is currently **systematically underscored**. The ETnow "Adani Universe" screener (et-520) is hardcoded `is_positive: 0`, meaning every appearance in that screener counts as a **negative contribution** to ADANIPORTS' composite score. Post Bug-5 fix, the score will increase and classification may shift from Hold/Sell → Buy.

### Technical Setup
- Entry trigger: Price reclaiming 21-EMA on daily + volume ≥ 1.3× 20-day average
- Momentum confirmation: RSI crossing above 50 from below
- Key resistance: ₹1,380–₹1,420 (52-week pivot) — weekly close above = institutional confirmation
- Support floor / stop anchor: ₹1,200–₹1,220 (200-DMA cluster)

### Catalysts by Horizon
| Horizon | Catalyst |
|---|---|
| 1–5 days | FII net buyer in Infrastructure turning positive; monthly port volume data beat |
| 5–15 days | India export policy (PLI extensions, China tariff escalation); Nifty Infra ETF flows |
| 30–90 days | FY26 Q1/Q2 EBITDA margin expansion from logistics parks; Adani Group re-rating |

### Final Recommendation
**Rating: CONDITIONAL BUY**  
**Confidence: 62/100** (reduced from ~75 due to active bugs distorting signal quality)

**Entry conditions (all required):**
1. Bug 5 fixed AND corrected composite score ≥ 60
2. Daily close above ₹1,380 with volume ≥ 1.3× 20-day average
3. FII net buyer in infrastructure for ≥2 consecutive sessions
4. Nifty regime ≠ BEAR (from `getRLPolicy`)

**Invalidation conditions:**
- Weekly close below ₹1,200 → thesis broken, stop triggered
- Post-fix composite score remains below 50 → screener consensus absent
- FII net seller in sector for ≥5 consecutive sessions
- New regulatory headline on port concession renewal risk

---

## 5. Implementation Scope

### Phase 1 — Bug Fixes (scoring_engine.py + queues.ts + strategy_optimizer.py)
1. Apply `weight_override` in scoring engine loop
2. Union all three source tables in optimizer override query
3. Load ML `win_probability` and apply consensus bonus in scoring engine
4. Add missing workers to `shutdownQueues()`
5. Correct `is_positive` on 4 group/universe ETnow screeners

### Phase 2 — News Recency Fix (scoring_engine.py)
6. Apply 2-day half-life intra-week decay for news items

### Phase 3 — New Strategy Functions (scoringService.ts + router.ts)
7. `crossSourceFilter()` + `getConvergenceSignals` tRPC endpoint
8. `regimeSectorFilter()` + `getRegimeSectorSignals` tRPC endpoint
9. `qualityOversoldScanner()` + `getQualityOversoldSignals` tRPC endpoint

### Phase 4 — Signal Type Dedup (scoring_engine.py + screener_master schema)
10. Add `signal_type_tag` column to `screener_master`
11. NLP inference update to populate `signal_type_tag`
12. Switch dedup key from `source|category|sentiment` to `source|signal_type_tag|sentiment`

### Out of Scope
- Frontend UI changes for new strategy tabs
- ATR-based position sizing output (future enhancement)
- Intraday price target computation

---

## 6. Risk & Constraints
- All Python changes run in-process via FastAPI (`http://127.0.0.1:8000`) — no new services needed
- `signal_type_tag` schema change requires a migration; existing `screener_master` rows need backfill via NLP re-inference
- Phase 4 `signal_type_tag` dedup changes scoring behaviour significantly — should run in parallel with old scoring for 1 week before cutover
- Strategy 2 (`regimeSectorFilter`) requires the RL agent to have populated `rl_q_table` — if table is empty the function must fall back to "BULL" as default regime
