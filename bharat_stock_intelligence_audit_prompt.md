# 🔍 Bharat Stock Intelligence — Complete Codebase Audit & Prediction Accuracy Review

> **System:** You are acting as a senior quantitative analyst and systems architect with 15+ years of experience in Indian equity markets (NSE/BSE), algorithmic trading systems, and production ML pipelines. You have deep expertise in factor investing, statistical arbitrage, market microstructure, and the specific nuances of Indian equity markets (circuit limits, T+1 settlement, ASM/GSM frameworks, FII/DII flow dynamics, options OI-based positioning).
>
> **Your mission:** Conduct a forensic, end-to-end audit of the Bharat Stock Intelligence codebase — a real-time Indian equity intelligence platform — and produce an actionable remediation plan to close the gap between what this system recommends and what actually moves in the real market.

---

## Part 0 — CRITICAL CONTEXT (Read Before Anything Else)

This codebase has an extensive self-documenting measurement and audit trail. **Before you investigate anything, read these files first** — they contain months of accumulated evidence, failed experiments, known bugs, and hard-won lessons:

| File | What it contains |
|---|---|
| `.claude/rules/measurement.md` (~87KB) | Every factor/engine/model measured, their verdicts, the panel spec, the reusable traps found |
| `.claude/rules/scoring-authority.md` | The canonical scoring architecture (3 producers, 4 signal tables, no more) |
| `.claude/rules/ml-model-bugs.md` | Model promotion gates, measurement harnesses, known model failure modes |
| `.claude/rules/recurring-bugs.md` + `bugs-*.md` | Every bug class that has recurred — these WILL bite any new code |
| `docs/audit-findings.md` | The single tracker — ~1200 lines of open/closed findings with evidence |
| `CONTEXT.md` | System map, data flow, sources of truth |
| `CLAUDE.md` | Operating manual — definition of done, services, architecture constraints |
| `gaps_and_opportunities.md` | Current gaps analysis (verify against live — some items are now resolved) |

**The single most important fact:** This platform's ranker (`unified_score`) reads a small positive rank IC (+0.051 at 5d) that is still LOW-DATA and has **never passed a cost-aware backtest**. Most published factors are null or inverted on this data. Every factor that WAS cost-tested came back negative or not significant, except one capacity-constrained capitulation pattern.

---

## Part 1 — DATA PIPELINE AUDIT (The Foundation)

### 1.1 Data Source Quality & Coverage

The platform pulls from ~15 vendors via 82 `*_fetcher.py` files into PostgreSQL/TimescaleDB. Audit each data domain:

**For each data source category, answer:**
- Is the data actually fresh? Query `MAX(fetched_at)` and `MAX(date)` per table — don't trust the code, trust the database.
- What is the per-symbol density? Run: `SELECT min(n), percentile_cont(0.5) WITHIN GROUP (ORDER BY n), max(n) FROM (SELECT symbol, count(DISTINCT date) n FROM <table> GROUP BY 1)`
- Is there survivorship bias? Do delisted/suspended stocks disappear from the universe?
- Are there timezone issues? (The codebase has documented cases of IST/UTC confusion — see AF-20260926-06)
- Are `fetched_at` timestamps actually advancing on upsert, or frozen at first-write? (This was a real bug across multiple fetchers — see AF-20260924-02)

**Specific tables to probe deeply:**

| Table | Known issue to verify |
|---|---|
| `stock_ohlcv` | `is_suspect` flag — was 474 bars, now 8,789. Check for over-quarantining legitimate trading days |
| `feature_store` | Was rebuilt 2026-09-10 after scaled-column defect. `news_sentiment_score` has a dual-definition problem (discrete labels vs continuous scores — AF-20260926-08) |
| `technical_signals` | 93 dates of history. Are all columns populated or do some decay to NULL over time? |
| `insider_transactions` | Write-only table — fetcher still runs, nothing reads it, data frozen at 2026-05-02 |
| `confluence_signals` | 28+ dates. The strongest-reading engine — verify data completeness |
| `stock_futures_oi_history` | `basis` 1d reads +0.139 IC — verify this is real signal, not a data artifact |

### 1.2 Feature Engineering Pipeline

`feature_engineering.py` (96KB) is the feature factory. Audit:

1. **Look-ahead leaks:** Does ANY feature use same-day close data that wouldn't be available at signal generation time? The codebase has caught this before (`dl_engine` was reading raw prices — AF-20260913-01).
2. **News sentiment dual definition:** `feature_store.news_sentiment_score` (discrete ±1/0 labels, 51.9% exactly 0.0) vs `technical_signals.news_sentiment_score` (continuous [-1, +1]). Pearson r = 0.4188 between them. The DL path reads discrete, the ML/scoring/UI reads continuous. This is a live train/serve skew.
3. **Feature coverage:** What % of the universe has each feature populated on any given date? Features with <50% coverage silently bias the model toward large-cap stocks that have data.
4. **Stale features:** Are any features computed from data sources that have stopped updating?

### 1.3 OHLCV Data Integrity

`ohlcv_adjust.py` and `ohlcv_quality.py` handle corporate actions and quality flagging.

- **Corporate action adjustments:** Are splits, bonuses, rights issues properly adjusted? Check adjustment factors table for anomalies (a corrupt `1965-03-06` date was found — AF-20260831-03).
- **Cross-validate:** Compare this platform's OHLCV against NSE bhavcopy for a random sample of 50 stocks over the last 30 days. Any divergence >0.5% needs investigation.
- **Volume normalization:** Is volume adjusted for stock splits? An unadjusted volume after a 10:1 split would make delivery % calculations meaningless.

---

## Part 2 — SCORING & RANKING ENGINE AUDIT (The Core Problem)

### 2.1 The Unified Ranker Architecture

The canonical ranking flows through:
```
vendors → *_fetcher.py → Postgres
  → feature_engineering.py → feature_store
  → scoring_engine.py (stock_scores) + quant engines (quant_scores) + ml_ensemble + dl_engine + confluence + technical
  → unified_ranker.py → unified_recommendations  ← THE canonical ranking
```

**`unified_ranker.py` (182KB) is the system's brain. Audit it ruthlessly:**

1. **Regime detection:** How is the current market regime (BULL/BEAR/HIGH_VOL/CRASH/SIDEWAYS) determined? Is `regime_detector.py` accurate? If it misclassifies a regime, ALL downstream weights are wrong.

2. **Engine weights (`REGIME_WEIGHTS`):** Currently 4 of 8 engines are zeroed:
   - `screener` = 0.0 (demonstrated net-negative: IC −0.027, t=−2.36)
   - `cs_ranker` = 0.0 (live AUC 0.5017 — no edge)
   - `smart_money` = 0.0 (IC +0.004 at 1d, −0.016 at 5d — no edge)
   - `dl` = 0.0 (PAUSED — model inputs were rebuilt, weight awaiting honest retrain)
   
   **This means only `ml`, `confluence`, `technical`, and `breakout` carry any weight.** Are these weights justified? What evidence supports each?

3. **The screener scoring subsystem:** `scoring_engine.py` (74KB) uses `CAT_BASE_WT` (18 category weights), `SUBCAT_MOD` (23 subcategory modifiers), and `HORIZON_MULT` (6 horizon multipliers). **None of these have ever been empirically validated.** They are hand-tuned weights. Does this scoring reflect what actually predicts stock movement in Indian markets?

4. **Confluence engine:** `confluenceEngine.ts` (29KB) and `confluence_ml_engine.py` (23KB). Confluence reads the strongest IC (+0.065 to +0.147) but is LOW-DATA. How does it aggregate signals? Is the aggregation method sound?

5. **The `_blend()` function:** How are per-symbol missing engines handled? Does missing data silently change the effective weights for a stock?

### 2.2 The ML Pipeline

**`ml_ensemble.py` (270KB — the single largest file) is the ML workhorse.**

1. **Label definition:** Training uses `triple_barrier` (López de Prado cost-aware barrier) from `signal_excursions.tb_label`. Is the barrier width appropriate for Indian markets? Does it account for circuit limits?

2. **Feature set:** What features does the ensemble actually train on? Are they the same features available at prediction time? (Train/serve skew has been caught before.)

3. **Model selection:** The active model is a Stacking Ensemble with CV AUC ~0.5277-0.5361. This is barely above random (0.5). **Why is it this low?** Is the label too hard, or are the features uninformative, or is the model architecture wrong?

4. **Walk-forward validation:** Is it properly date-purged to prevent leakage? (The DL validation was inflated by date overlap — AF-20260910-08)

5. **Promotion gates:** `model_promotion.py` — what criteria must a model meet before going live? Are these gates sufficient?

### 2.3 The DL Pipeline

**`dl_engine.py` (65KB) + `dl_trainer.py` (18KB):**

- Weight is currently 0.0 (PAUSED). The active BiLSTM v5 saturates — 40% of predictions at extremes (< 0.01 or > 0.99).
- Walk-forward AUC was inflated before the fix. No honest DL number exists yet.
- **Question:** Is a BiLSTM the right architecture for cross-sectional stock prediction? Modern approaches use transformers, temporal fusion transformers, or attention-based architectures.

---

## Part 3 — WHAT ACTUALLY MOVES IN THE INDIAN MARKET (The Gap Analysis)

### 3.1 Reverse Engineering What Drives Real Market Moves

The codebase has a `reverse_engineering_study.py` (24KB). Use it. But more importantly, do your own analysis:

**Pull the top 20 gainers and top 20 losers from `stock_ohlcv` for each of the last 30 trading days.** For each:
1. Did this system's `unified_score` rank them correctly BEFORE the move?
2. What signals (if any) fired for these stocks before the move?
3. What is the overlap between what this system recommends and what actually moved?

**Expected finding:** The overlap will be very low. Document the specific patterns of failure:
- **Type A failures:** Stocks the system ranked high that went nowhere or fell
- **Type B failures:** Stocks that surged 5-10%+ that the system had no signal for
- **Type C failures:** Stocks where the signal was right but the timing was wrong

### 3.2 What Drives Indian Equity Returns (That This System Doesn't Capture Well)

Based on your expert knowledge, evaluate whether the system adequately captures:

1. **Institutional flow signals:**
   - FII/DII daily flow data (the system has `fii_dii_fetcher.py` — but how does it USE these flows for prediction?)
   - MF holding changes — `mf_holdings_fetcher.py` captures this but is it integrated into the scoring?
   - Block/bulk deal signals — `block_deal_fetcher.py` exists but the `bulk_deals` table has only 8 rows

2. **Earnings and fundamental catalysts:**
   - Earnings surprise (the system has `earnings_surprise_fetcher.py` and `pead_model.py` — PEAD is a well-documented anomaly)
   - Analyst estimate revisions — the trio (`eps_revision_3m_pct`, `target_revision_3m_pct`, `analyst_count_chg`) is writing data but still under the grading floor
   - Working capital / cash flow momentum — `working_capital_fetcher.py`, `finstack_cashflow_fetcher.py`

3. **Market microstructure signals:**
   - Options OI positioning — the `basis` 1d signal reads +0.139 IC (the strongest lead reading). Is this being exploited?
   - Delivery % — has a real quintile spread but fails as a long-only factor due to low-vol bias
   - Preopen auction data — `preopen_fetcher.py` captures this. Is preopen gap analysis used?

4. **Momentum and trend following:**
   - `momentum_12_1` reads t=1.45 in the cost-aware backtest — weak but the best long-only factor result. Is it weighted appropriately?
   - Sector rotation — `screener_sector_rotation.py` exists but is it actively used?
   - Relative strength — `relative_strength.py` (14KB) — how does it integrate?

5. **Event-driven signals:**
   - Corporate actions (splits, buybacks, rights) — are these systematically traded?
   - Index reconstitution (Nifty additions/deletions) — massive predictable flow
   - IPO listing day patterns
   - Credit rating changes — `credit_rating_fetcher.py` exists

6. **Sentiment and alternative data:**
   - News sentiment — the dual-definition problem means the system effectively has two different sentiment signals. Neither has demonstrated edge.
   - Broker recommendations — `mc_broker_reco_fetcher.py` — consensus changes can be predictive
   - TradingView technicals — `tradingview-ta` is installed but how is it used?

### 3.3 Market Structure Factors Missing Entirely

**What this codebase does NOT have that professional Indian market participants use:**

1. **Auction market data** — pre-open and closing auction order book snapshots. The system fetches preopen but doesn't model the information content.

2. **Intraday volume profile** — VWAP reversion, volume at price, time-weighted vs volume-weighted execution quality.

3. **Cross-asset signals** — USD/INR, US 10Y yield, crude oil, gold — these drive Nifty and sector rotations. `global_macro_fetcher.py` and `india_macro_fetcher.py` exist but are they used in scoring?

4. **Seasonality** — day-of-week, month-of-year, expiry-week effects in Indian markets. `expiry_features.py` exists but with only 3.7KB, it's likely minimal.

5. **Regulatory regime** — SEBI margin changes, lot size changes, ASM/GSM list changes (the system has `asm_gsm_fetcher.py` — good) — but are ASM/GSM stocks filtered from recommendations?

6. **Short-term reversal with liquidity filter** — the strongest feature_store signal (`atr_pct` -0.077 @21d on liquid names) but dies on costs (41-83% turnover). A smarter construction (sector-neutral, wider rebalance) is untested.

7. **Earnings quality signals** — Beneish M-score, Altman Z-score, Piotroski F-score (the system stores `piotroski_f_score` — is it used in scoring?)

---

## Part 4 — MEASUREMENT & BACKTESTING AUDIT

### 4.1 Factor Testing Framework

`factor_backtest.py` (95KB) and `factor_edge.py` (17KB) are the measurement harnesses.

1. **Panel spec compliance:** Every measurement must follow the documented panel spec (per-date not pooled, winsorised, liquidity floor ≥₹1cr ADT, next-day OPEN entry). Are ALL historical measurements compliant?

2. **The median-beater trap:** `factor_edge.py` centres excess return on the per-date MEDIAN; `factor_backtest.py` benchmarks against the equal-weight universe MEAN. Indian cross-sectional returns are right-skewed, so a factor can beat the median and lose to the mean. This was demonstrated 2026-09-26 with the low-vol composite (+0.049 IC, -0.53 to -0.94% net excess). **Every factor verdict must be checked against BOTH arbiters.**

3. **Overlapping window correction:** `factor_edge.py` historically counted overlapping forward windows as independent observations, overstating power by ~h. Now corrected with `eff_dates`. But are all historical readings retroactively corrected?

4. **Transaction cost model:** `indian_market_costs.py` (4KB) — does it correctly model:
   - Brokerage (varies by broker type — discount vs full-service)
   - STT (Securities Transaction Tax — different for delivery vs intraday vs F&O)
   - GST on brokerage
   - SEBI charges
   - Exchange transaction charges
   - Stamp duty
   - Impact cost (this is the big one — for small/mid-caps, market impact can dwarf all other costs)

5. **The only validated edge:** The capitulation triple (`gap_down AND open_eq_low AND top_loser`) at t=+3.48, p=0.0005, clears Bonferroni. But capacity is ~₹0.46cr/signal-day. **Is this signal being actively exploited? If not, why not?**

### 4.2 Outcome Resolution

`outcome_resolver.py` (70KB) grades signals against realized returns.

1. **Label consistency:** `signal_outcomes` had a three-writer collision (AF-20260925-05 / scoring-authority.md). Is this fully resolved?
2. **Horizon alignment:** Are outcomes measured at the correct forward horizons?
3. **Survivorship:** What happens to outcome resolution for delisted stocks?

---

## Part 5 — OPERATIONAL EXCELLENCE AUDIT

### 5.1 Job Scheduling & Reliability

72 scheduled jobs in `jobRegistry.ts`. For each job that touches scoring/ranking:
- What is its schedule?
- Does it actually run on time? Check `job_heartbeat` and `job_run_history`.
- What happens when it fails? Silent failure has been a recurring pattern.
- Are there dependency chains that can cascade?

### 5.2 Silent Failure Patterns

25 silent broad-`except` handlers still wrap DB calls with no log line (AF-20260925-02). These are in signal-critical paths:
- `unified_ranker.py` — a silent exception here means the ranking is wrong
- `scoring_engine.py` — silent exceptions mean scores are incomplete
- `ml_ensemble.py` — regime lookups could silently fail

### 5.3 Data Quality Monitoring

`dataQualityChecks.ts` (233KB) runs 175 checks. But:
- Are they checking the RIGHT things?
- The system recently went from 168/175 to 175/175 passes — but passing checks ≠ accurate predictions
- Is there a check that asks "did our top recommendations actually outperform?"

---

## Part 6 — REVERSE ENGINEERING ACTION PLAN

Based on your complete audit, produce a prioritized action plan with these sections:

### 6.1 Quick Wins (< 1 week, high impact)

Things that can be done immediately to improve prediction accuracy:
- Run the cost-aware backtest on `unified_score` — it has never been done
- Deploy pending fixes
- Verify/exploit the `basis` 1d F&O signal
- Grade `confluence_score` through `factor_backtest.py`

### 6.2 Architecture Changes (1-4 weeks)

Fundamental changes to how signals are generated and combined:
- Should the regime detection be rebuilt?
- Should the ML model switch to a different architecture?
- Should the feature set be redesigned based on what actually drives Indian market returns?
- Is the unified ranker's linear blend the right aggregation method?

### 6.3 New Signal Sources (2-8 weeks)

What entirely new signals should be added:
- Cross-asset signals (macro)
- Improved institutional flow integration
- Event-driven automation
- Market microstructure signals

### 6.4 Measurement Infrastructure (Ongoing)

How to build a continuous feedback loop:
- Daily automated grading of recommendations
- A dashboard showing "what we recommended vs what happened"
- Systematic tracking of Type A/B/C failures
- A/B testing framework for model changes

### 6.5 The Hard Truth Assessment

Be brutally honest:
- **What is the realistic accuracy ceiling** for a system like this on Indian equities?
- **Which parts of the current architecture are fundamentally sound** and which need to be rethought?
- **What would a professional quant desk do differently** that this system is not doing?
- **Is the system trying to do too many things?** (81 fetchers, 8 scoring engines, intraday + swing + positional + long-term) — would focusing on fewer, higher-conviction strategies yield better results?

---

## Part 7 — DELIVERABLES CHECKLIST

At the end of this audit, produce:

- [ ] **Data Quality Report** — per-table freshness, coverage, and known issues
- [ ] **Signal Accuracy Report** — reverse-engineered against last 30 days of actual market moves
- [ ] **Factor Verdict Summary** — every factor tested, its verdict, and evidence quality
- [ ] **Architecture Gap Analysis** — what's missing vs professional-grade systems
- [ ] **Prioritized Fix List** — ordered by impact on prediction accuracy, with effort estimates
- [ ] **Measurement Plan** — how to verify each fix actually improved predictions
- [ ] **Closed-Loop Dashboard Spec** — design for continuous accuracy monitoring

---

## RULES OF ENGAGEMENT

1. **Never fabricate evidence.** A number a model reports about itself is not evidence. Grade against realized returns.
2. **Verify against live production, not the code.** Use `scripts/sql.py` for read-only queries against the real database.
3. **Follow the panel spec** for every measurement (documented in `measurement.md`).
4. **Every claim needs a date and a source.** "The ML model has good accuracy" is not a claim — "ML ensemble CV AUC 0.5361, trained 2026-09-26, n=281K" is.
5. **If measurement.md already has an answer, start from that answer, don't re-derive from scratch.** But do verify the date — readings go stale.
6. **Commit findings to `docs/audit-findings.md`** with stable `AF-YYYYMMDD-NN` IDs. That is the one and only tracker.

---

> **The fundamental question this audit must answer:** *Given that the ranker reads a small positive IC but has never passed a cost-aware backtest, and that every factor individually tested has come back negative or not significant (except one capacity-constrained pattern) — is this system's approach to stock prediction fundamentally fixable, and if so, what specific changes would move it from "barely above random" to "actionable edge"?*
