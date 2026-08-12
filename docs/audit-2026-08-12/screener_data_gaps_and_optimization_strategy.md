# Bharat Stock Intelligence: Screener Data Gaps & Optimization Strategy
**Author:** Manus AI  
**Date:** August 12, 2026  
**Status:** Institutional Quantitative Advisory  

## Executive Summary
The **Bharat Stock Intelligence** platform collects a vast corpus of live and End-of-Day (EOD) screener data from multiple providers (Trendlyne, Moneycontrol, ET Marketstats, ETNow, MarketsMojo). However, a comprehensive audit reveals critical architectural gaps in how this high-frequency, multi-filtered screener data is transformed into predictive alpha. This report identifies key missing gaps, analyzes the current data footprint, and outlines a rigorous engineering roadmap to convert raw screener appearances into institutional-grade trading signals.

---

## 1. Current Screener Data Footprint & Architecture
The platform maintains several core relational and hypertables dedicated to screener ingestion:
- **`screener_appearances` & `screener_membership_snapshot`**: Tracks daily symbol membership across hundreds of parameterized technical, fundamental, and sentiment filters.
- **`screener_performance_v2` & `screener_reliability`**: Evaluates historical Bayesian win rates and reliability scores per screener ID.
- **`trendlyne_screener_stocks` & `moneycontrol_screener_stocks`**: Provider-specific stock mappings.
- **`live_screener_appearances` & `live_screener_ml_scores`**: Intraday snapshots capturing real-time breakout and volume surge triggers.

---

## 2. Identified Gaps & Areas of Improvement

### Gap 1: Cross-Provider Collisions & Primary Key Normalization
As documented in recent database migrations, multiple providers (Moneycontrol, ETNow, Trendlyne) frequently reuse scan IDs and screener identifiers (e.g., screener ID `101` representing entirely different momentum filters on different platforms). While recent migrations added `source` composite primary keys to several tables, legacy queries in auxiliary Python fetchers still rely on bare `scan_id`, leading to silent overwrites and misattributed sentiment scores.

### Gap 2: Static Weighting vs. Dynamic Bayesian Decay
Currently, screener consensus scores (`screener_momentum_score`, `screener_net_score`) often apply static heuristic weights to screener categories (e.g., Breakout vs. Value). Screeners that exhibit high historical win rates in bull markets frequently experience severe performance decay during high-volatility regime shifts (VIX > 30), yet the ranking engine does not dynamically decay screener weights based on market regime.

### Gap 3: Lookahead & Publication Lag Blind Spots in EOD Screeners
EOD screeners published after market close (e.g., 6:00 PM IST) are frequently misaligned with the trading session timestamp $T$ rather than $T+1$ open. Without explicit publication timestamp tracking (`publication_time` vs. `run_timestamp`), features derived from EOD screener appearances inadvertently introduce lookahead bias into short-term ML models.

### Gap 4: Zero-Shot Transition Handling (New Screeners)
Newly introduced screeners or screeners with fewer than 30 historical observations default to neutral Bayesian scores (0.50 win rate), distorting the cross-sectional rank of stocks that appear *only* in novel screeners.

---

## 3. Strategic Blueprint: Maximizing Screener Data for Stock Prediction

To transform raw screener appearances into predictive alpha, we recommend implementing the following four pillars:

### Pillar 1: Dynamic Regime-Aware Screener Weighting
Instead of static weights, compute rolling Bayesian win rates conditional on the prevailing market regime:
$$\text{Weight}_{s, t} = \text{BayesianWinRate}_{s} \times \mathbb{I}(\text{Regime}_{t} == \text{Regime}_{s})$$
When the VIX exceeds 25 or FII net flows turn negative, automatically downweight momentum/breakout screeners and upweight quality/defensive screeners.

### Pillar 2: Screener Confluence & Persistence Scoring (Streak Analysis)
A stock appearing in a single screener on a single day is often noise. True institutional accumulation is characterized by **screener persistence**. We propose computing a **Multi-Screener Streak Score**:
$$\text{StreakScore}_{i, t} = \sum_{k=1}^{N} \sum_{d=0}^{5} \mathbb{I}(i \in \text{Screener}_{k, t-d}) \times \text{Reliability}_{k}$$
Stocks appearing concurrently across $\ge 3$ orthogonal screeners for $\ge 3$ consecutive days receive a high conviction multiplier in `unified_ranker.py`.

### Pillar 3: Intraday Live Screener vs. EOD Screener Divergence
Leverage the divergence between intraday live screener appearances (`live_screener_appearances`) and EOD confirmation (`screener_appearances`):
- *Early Breakout Signal*: Stock appears in intraday volume/momentum live screeners at 11:30 AM.
- *Institutional Confirmation*: Stock remains in EOD closing breakout screeners with net block deal accumulation.
- *Action*: Trigger high-priority execution alerts only when intraday live momentum converges with EOD institutional ownership.

### Pillar 4: Factor Orthogonalization of Screener Attributes
Decompose multi-filtered screeners into fundamental, technical, and sentiment factors before ingestion into machine learning models, ensuring that overlapping filters (e.g., "RSI > 70" and "Price near 52-week high") do not create multicollinearity traps in XGBoost/LightGBM feature spaces.

---

## 4. Conclusion
By addressing provider collision technical debt, implementing regime-aware dynamic weighting, and leveraging screener persistence streaks, the **Bharat Stock Intelligence** platform can unlock the full predictive potential of its extensive live and EOD screener repository, transitioning from heuristic aggregation to institutional-grade quantitative alpha generation.

*Report automatically generated by Manus AI.*
