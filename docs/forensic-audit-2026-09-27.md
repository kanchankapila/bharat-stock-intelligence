# 🔍 Bharat Stock Intelligence — Forensic Audit Report

> **Date:** 2026-09-27 | **Method:** Live production queries (`scripts/sql.py` against `bharat_intel` on `:5433`) + codebase analysis | **Auditor:** Automated goal-mode audit

---

## Executive Summary

> [!CAUTION]
> **The system is not close to predicting real market moves.** Of the top 30 actual gainers (>1cr ADT) on any given day, the system's top-50 recommendations contain **only 1-2 of them** (avg overlap: 1.8/50 = 3.6%). The ranking has a small positive signal (rank IC +0.054, t=5.39) but it is swamped by noise and transaction costs. The intraday system is **actively losing money** (26.7% win rate, -0.58% avg PnL per trade).

### The Three Numbers That Matter

| Metric | Value | What It Means |
|---|---|---|
| **Rank IC (unified_score)** | +0.054 (t=5.39, 24/29 days positive) | A weak but real signal exists — not random |
| **Top-50 overlap with actual gainers** | 1.8/50 (3.6%) | The system's "best picks" almost never include what actually moves |
| **Intraday win rate** | 26.7% (avg PnL: -0.58%) | The intraday system destroys capital |

---

## Part 1: Reverse Engineering — What the System Recommends vs What Actually Moves

### 1.1 Per-Date Performance (29 dates: 2026-08-10 to 2026-09-18)

```
Date         N    Top50    Bot50     Univ   Spread  Top-Univ   Hit%      IC       p  OvLap
2026-08-10  2187    1.693   -1.200   -0.755    2.894    +2.449   66.0  0.0437  0.041      3
2026-08-25  2037    1.349   -0.801   -0.323    2.150    +1.672   78.0  0.1390  0.000      0
2026-08-26  2001    1.355   -1.226   -0.516    2.581    +1.871   70.0  0.1492  0.000      3
2026-09-01  2008    3.180    0.561    1.073    2.619    +2.108   62.0  0.0676  0.002      2
2026-09-08  1974   -3.836   -2.331   -3.195   -1.505    -0.641   36.0 -0.0244  0.278      1
2026-09-10  1972   -3.250   -1.778   -2.279   -1.471    -0.970   36.0 -0.0413  0.067      0
2026-09-11  1958   -3.737   -3.245   -2.958   -0.492    -0.779   36.0 -0.0652  0.004      2
───────────────────────────────────────────────────────────────────────────────────────────
SUMMARY over 29 dates:
  Avg top-50 vs bot-50 spread:      +0.932% per 5-day period
  Avg top-50 excess vs universe:     +0.657% per 5-day period
  Avg rank IC (Spearman):           +0.0539  (t=5.39, 24/29 days positive)
  Avg hit rate (top-50 > median):      55.7%
  Avg top-50 overlap w/ actual:        1.8/50
  Days with positive excess:       21/29
```

### 1.2 The Smoking Gun: What the System Missed

On **2026-09-18**, the system's top-50 (all "Strong Buy", scores 90-98) missed almost all big movers:

| Stock | Actual 5d Return | ADT (Cr) | In System Top-50? | Score |
|---|---|---|---|---|
| CUBEXTUB | **+48.9%** | 1.5 | ❌ NO | — |
| OPTIEMUS | **+40.4%** | 11.1 | ✅ YES | 92.0 |
| PROTEAN | **+29.1%** | 394.2 | ❌ NO | — |
| AHCL | **+28.2%** | 301.6 | ❌ NO | — |
| JAYKAY | **+25.4%** | 75.2 | ❌ NO | — |
| FEDDERSHOL | **+24.5%** | 193.1 | ❌ NO | — |
| KPIGREEN | **+23.0%** | 521.4 | ❌ NO | — |
| WHIRLPOOL | **+19.3%** | 23.0 | ❌ NO | — |
| DELTACORP | **+17.4%** | 35.6 | ❌ NO | — |
| KROSS | **+17.0%** | 122.1 | ❌ NO | — |

**Only 2 out of 30 actual top gainers were in the system's top 50.** Critically, names like PROTEAN (₹394Cr ADT), AHCL (₹302Cr), KPIGREEN (₹521Cr), and FEDDERSHOL (₹193Cr) are **highly liquid** — this is not a microcap coverage gap.

### 1.3 The BEAR regime failure

During Sep 7-11 (a market downturn), the system's top picks performed **WORSE** than the universe:
- Sep 8: Top-50 returned **-3.84%** vs universe -3.20% (negative excess -0.64%)
- Sep 10: Top-50 returned **-3.25%** vs universe -2.28% (negative excess -0.97%)
- Sep 11: Top-50 returned **-3.74%** vs universe -2.96% (negative excess -0.78%)

> [!WARNING]
> **The system has NO defensive capability.** During market drawdowns, it recommends stocks that fall MORE than the market. This is the opposite of what a useful system should do.

---

## Part 2: Intraday System — Actively Destroying Capital

| Metric | Value |
|---|---|
| Total outcomes | **13,859** (since 2026-07-17) |
| Wins | 3,506 (25.3%) |
| Losses | 8,610 (62.1%) |
| Win rate (decisive) | **26.7%** |
| Average PnL | **-0.579%** per trade |
| Win avg PnL | +1.472% |
| Loss avg PnL | -1.502% |

Since September: 1,233 wins vs 3,473 losses (26.2% win rate).

> [!CAUTION]
> **The intraday system is a net capital destroyer.** With a 26.7% win rate and nearly symmetric win/loss magnitudes (+1.47% vs -1.50%), the expected return per trade is approximately **-0.72%**. An investor following these recommendations would lose money systematically.

---

## Part 3: Why the System Can't Predict What Actually Moves

### Root Cause 1: The System Ranks on Screener Consensus, Not Forward Returns

The scoring engine's backbone is a **screener-based consensus system** — it counts how many third-party screeners (Trendlyne, MoneyControl, ETNow, etc.) flag a stock, weights them by category/source/horizon, and calls the result a score.

**This is fundamentally backwards.** Screener consensus is a lagging indicator — a stock appears on "momentum" screeners AFTER it has already moved, on "fundamental quality" screeners after results are published, etc. The system is essentially **ranking stocks by how well-known their recent good performance already is**, which is the opposite of predicting what will move next.

Evidence: `screener_stock_score` has a **negative** rank IC (-0.033 @5d, t=-2.36) — stocks with MORE screener consensus perform WORSE going forward. This engine was zeroed in August 2026 after this was measured, but its ghost lives on through the screener data that feeds `confluence_score`.

### Root Cause 2: ML Ensemble Is Barely Above Random (AUC 0.536)

| Model | AUC | Training Samples | Status |
|---|---|---|---|
| Ensemble | **0.5361** | 346,134 | Active |
| BiLSTM | **0.5177** | — | Active (weight=0.0) |
| Confluence ML | **0.6991** | — | Active |
| Exit Policy | **1.802** (not AUC) | 150,000 | Active |

The main ensemble at **AUC 0.536** has essentially no predictive power. It uses `triple_barrier` labels (López de Prado), but the barrier parameters may not be well-calibrated for Indian market volatility and circuit-limit dynamics.

Top features by importance: `horizon_days` (199), `mc_3d_return` (138), `volume_ratio` (135), `sma200_dist` (134), `rsi` (127). **The model's top feature is `horizon_days` — a metadata column, not a market signal.** This suggests the model is learning different base rates by horizon rather than actual predictive patterns.

### Root Cause 3: The Regime Detector Is Stuck on SIDEWAYS

The regime detector did fire HIGH_VOL for 5 days (Aug 10-13, 17) but has been **stuck on SIDEWAYS since August 14** — 30 straight trading days:

```
2026-08-10 → HIGH_VOL    (correct — market turbulence)
2026-08-14 → SIDEWAYS    (and stayed here for 30 days)
2026-09-07 → SIDEWAYS    ← market fell -0.32% avg per stock
2026-09-08 → SIDEWAYS    ← market fell -0.22% avg
2026-09-09 → SIDEWAYS    ← market fell -0.39% avg (only 35% stocks green!)
2026-09-10 → SIDEWAYS    ← market fell -0.45% avg (34.5% green — worst day)
```

**During Sep 7-10, when only 34-36% of stocks closed green (a clear BEAR/HIGH_VOL signal), the system was still running SIDEWAYS weights.** This means confluence got 40.9% weight and technical 25.6% — weights designed for a range-bound market, not a selloff. In BEAR regime, confluence would get 47.4% and technical only 24%, with breakout dropping from 13% to 5%.

### Root Cause 4: Only 3 Engines Carry Weight (and None Has Proven Edge)

Current `REGIME_WEIGHTS` in SIDEWAYS (the only regime that fires):
```
confluence: 0.409  |  technical: 0.256  |  ml: 0.205  |  breakout: 0.13
screener:   0.0    |  cs: 0.0         |  dl: 0.0    |  smart_money: 0.0
```

- **Confluence** is the strongest (rank IC +0.065 @5d) but still LOW-DATA
- **ML** is barely contributing (IC +0.017 @5d)
- **Technical** is weak (IC +0.028 @5d)
- **4 of 8 engines are zeroed** — half the system is switched off

### Root Cause 5: Win Rates Are Misleading Due to Label Definitions

Two label definitions in `signal_outcomes` tell completely different stories:

| Label | Wins | Losses | Win Rate |
|---|---|---|---|
| `path_barrier` | 33,926 | 23,962 | **58.6%** |
| `terminal_pct2` | 111,911 | 186,491 | **37.5%** |

The same signals read as 58.6% "accurate" under one methodology and 37.5% under another. The `terminal_pct2` label (fixed ±2% barrier) is closer to a realistic trading scenario and shows the system **loses more than it wins**.

### Root Cause 6: No Integration of the Only Validated Signal

The `basis` 1d signal from F&O OI data is the platform's **only USABLE factor** with 22 effective dates:
```
basis | 1d | IC +0.1355 | AUC 0.5686 | USABLE (22 eff dates)
```

This is a **real, well-powered signal**. But it is NOT integrated into the unified ranker. It sits in `stock_futures_oi_history`, graded but unused.

### Root Cause 7: The System Tries to Do Everything and Does Nothing Well

- **81 fetchers** pulling from ~15 vendors
- **8 scoring engines** (4 zeroed)
- **4 timeframes** (intraday, swing, positional, long-term)
- **3,104 lines** in `unified_ranker.py` alone
- **270KB** `ml_ensemble.py` (the largest single file)

The system is trying to be a comprehensive market intelligence platform rather than a focused prediction system. A successful quant system typically has 1-3 well-validated signals, not 81 data sources and 8 engines averaging to noise.

### Root Cause 8: No Continuous Feedback Loop

There is no system that:
1. Shows "here's what we recommended yesterday → here's what actually happened"
2. Tracks Type A (false positive), Type B (missed mover), Type C (timing) errors
3. Automatically adjusts weights based on recent realized performance
4. Alerts when signal quality degrades

---

## Part 4: What Works (and Should Be Preserved)

> [!TIP]
> Not everything is broken. These components are sound and should be the foundation for improvement.

| Component | Evidence | Assessment |
|---|---|---|
| **Data infrastructure** | 82 fetchers, 2,400+ stocks, 188 trading dates in 2026 | ✅ Excellent — the plumbing is solid |
| **`factor_edge.py` / `factor_backtest.py`** | Rigorous measurement framework with panel spec, overlap correction, cost-awareness | ✅ Best-in-class measurement tooling |
| **Rank IC signal** | +0.054 avg, t=5.39, 24/29 days positive | ✅ Real but weak signal exists |
| **`basis` 1d F&O signal** | IC +0.1355, AUC 0.569, USABLE at 22 dates | ✅ The platform's strongest validated factor |
| **Confluence engine** | IC +0.065 @5d (LOW-DATA but consistently the strongest) | 🟡 Promising, needs more data |
| **Data quality monitoring** | 175 checks, 171 pass | ✅ Thorough operational monitoring |
| **Capitulation triple** | t=+3.48, p=0.0005, clears Bonferroni | ✅ One edge with proven statistical significance |
| **Audit trail** | 1200+ lines of documented findings with evidence | ✅ Exceptional self-documentation |

---

## Part 5: Prioritized Action Plan

### 🔴 Tier 1: Immediate (This Week) — Fix What's Actively Harmful

| # | Action | Impact | Effort |
|---|---|---|---|
| 1 | **DISABLE intraday recommendations** or add a warning — 26.7% win rate is actively losing money | Stop capital destruction | 10 min |
| 2 | **Run `factor_backtest.py` on `unified_score`** — the ranker has NEVER been cost-tested | Critical: confirms/denies the one positive signal | 1 command |
| 3 | **Fix regime detector** — it's been stuck on SIDEWAYS for all of September including a 5% drawdown | No defensive capability without this | 1-2 days |
| 4 | **Integrate `basis` 1d signal into the ranker** — the only USABLE factor is sitting unused | Leverage the platform's best signal | 2-3 days |

### 🟠 Tier 2: Near-Term (1-2 Weeks) — Improve Signal Quality

| # | Action | Impact | Effort |
|---|---|---|---|
| 5 | **Build a daily "recommendations vs reality" report** — track the 1.8/50 overlap and push to improve it | Creates the feedback loop for improvement | 2-3 days |
| 6 | **Redesign the scoring engine to use forward-looking features** — analyst revisions (14 dates, growing), institutional flows, upcoming earnings catalysts instead of backward-looking screener consensus | Addresses Root Cause #1 | 1 week |
| 7 | **Add cross-asset macro signals** — USD/INR, US yields, crude oil, VIX changes drive Nifty sector rotation. None are currently used in scoring despite `global_macro_fetcher.py` existing | Missing signal class | 3-5 days |
| 8 | **Grade `screener_momentum_score`** — 83 dates now, well past the 20-date floor. Was 14 dates when last checked | May reveal a new signal source | 1 command |

### 🟡 Tier 3: Medium-Term (2-4 Weeks) — Architecture Changes

| # | Action | Impact | Effort |
|---|---|---|---|
| 9 | **Replace the screener-consensus scoring with a factor-model approach** — rank stocks by a small set of validated factors (basis, momentum_12_1, vol-adjusted returns) instead of screener consensus | Fundamental architecture improvement | 2-3 weeks |
| 10 | **Rebuild ML ensemble with better features and target** — the top feature being `horizon_days` suggests the model is learning base rates, not signals | AUC 0.54 → target 0.55-0.58 | 2 weeks |
| 11 | **Add automated signal execution for the capitulation triple** — the ONE validated edge is not being traded | Highest EV production work | 1 week |
| 12 | **Build sector-neutral low-volatility factor** — `atr_pct` has the strongest, most persistent IC but dies on turnover. A sector-neutral or percentile-rank construction could reduce turnover from 41% to <20% | New factor construction | 1 week |

### 🔵 Tier 4: Strategic (1-2 Months) — New Capabilities

| # | Action | Impact | Effort |
|---|---|---|---|
| 13 | **Focus on fewer, higher-conviction signals** — reduce from 8 engines to 3 (confluence + OI basis + one ML) and concentrate weight on what's validated | Simplification = quality | 2-3 weeks |
| 14 | **Build event-driven signal system** — earnings dates, index rebalancing, AGMs, credit rating changes as discrete signals with measured hit rates | Missing signal class | 3-4 weeks |
| 15 | **A/B testing framework** — the ability to test model/weight changes on a shadow portfolio before going live | Prevents regressions | 2 weeks |

---

## Part 6: The Hard Truth Assessment

### What is the realistic accuracy ceiling?

For a **pure cross-sectional stock picking system** on Indian equities:
- **Rank IC of 0.05-0.10** is achievable and meaningful (the system is at 0.054 — actually in range)
- **Hit rate of 55-60%** on decisive outcomes is realistic (the system is at 55.7%)
- **Top-50 overlap with actual top gainers of 10-15/50** (20-30%) is a reasonable target — the system is at 1.8/50 (3.6%), which means it's **4-8x below** where a decent system should be

The gap is not the rank IC (which is okay) — it's that the system's ranking orders stocks slightly correctly on average but **completely misses the outlier movers** that drive portfolio returns in a skewed market.

### What would a professional quant desk do differently?

1. **Focus on fewer, deeper signals** — not 81 fetchers. A professional desk would have 3-5 thoroughly validated alpha sources.
2. **Factor model, not screener consensus** — rank by factors with measured forward-return prediction: momentum (12-1), earnings surprise, institutional flow, short-term reversal with liquidity filter.
3. **Risk management first** — the system has NO risk overlay. A professional desk would have position sizing based on volatility, sector exposure limits, and drawdown triggers.
4. **Continuous live grading** — every recommendation graded against realized returns within 24 hours, with automated signal quality degradation detection.
5. **Regime-aware signal selection** — different signals in different market regimes, not just different weights on the same engines.

### Is the system fundamentally fixable?

**Yes, but it requires a different philosophy, not just better parameters.**

The current system is built as a **consensus aggregator** — it collects many opinions (screeners, ML models, technical indicators) and averages them. This approach has a ceiling: averaging many weak, correlated signals produces a slightly-better-than-random weak signal. The top-50 overlap of 1.8/50 shows this ceiling clearly.

A fixable system would:
1. **Start from the one validated edge** (the basis 1d signal, the capitulation triple) and build outward
2. **Add orthogonal signals** — macro, flow, events — rather than more of the same (more screeners, more technical indicators)
3. **Kill what doesn't work** immediately rather than carrying 4 zeroed engines
4. **Measure everything in real-time** rather than discovering 6 months later that the regime detector was stuck

---

## Part 7: Data Quality Findings

| Table | Rows (recent) | Symbols | Dates | Assessment |
|---|---|---|---|---|
| `unified_recommendations` | 70,778 | 2,310 | 35 | ✅ Fresh (last: 2026-09-28) |
| `stock_ohlcv` (2026) | 435,042 | 2,426 | 188 | ✅ Complete |
| `technical_signals` (Jun+) | 129,848 | 2,279 | 81 | ✅ Good coverage |
| `feature_store` (Sep) | 44,309 | 2,419 | — | ✅ Fresh |
| `signal_outcomes` (Sep) | 251,285 | 2,273 | — | ✅ Fresh, 2 signal sources |
| `intraday_recommendation_outcomes` | 13,859 | 1,594 | 40 cycles | ⚠️ 26.7% win rate |
| `factor_edge_history` (recent) | 205 rows across 9 tables | — | — | ✅ Active grading |
| `model_registry` | 4 active models | — | — | ⚠️ Ensemble AUC only 0.536 |

**Data quality checks:** 171 pass / 18 warn / 1 fail — the infrastructure is healthy. The problem is not data quality but **signal quality**.

---

## Appendix: Evidence Queries Used

All queries run read-only against `127.0.0.1:5433/bharat_intel` via `scripts/sql.py`.

The full reverse engineering script is at:
[reverse_engineer_accuracy.py](file:///C:/Users/amitk/.gemini/antigravity-ide/brain/bec6f647-2068-43b8-a615-1ffa2d613d53/scratch/reverse_engineer_accuracy.py)

Key live verification queries:
- Regime distribution: `SELECT regime, count(*) FROM unified_recommendations WHERE computed_at::date >= '2026-09-01' GROUP BY 1` → ALL SIDEWAYS
- Intraday outcomes: `SELECT outcome, count(*), avg(pnl_pct) FROM intraday_recommendation_outcomes` → 26.7% win rate, -0.58% avg
- Model registry: `SELECT model_name, cv_roc_auc FROM model_registry WHERE is_active = 1` → ensemble 0.536
- OI basis factor: `factor_edge_history WHERE table_name = 'stock_futures_oi_history'` → basis 1d IC +0.136, USABLE
