# Bharat Stock Intelligence: Systemic Improvement Roadmap

## Executive Summary

Following the full-stack quantitative audit and subsequent remediation of point-in-time join latency, insider transaction parsing defects, and institutional deal integration, the **Bharat Stock Intelligence** platform has achieved a significantly more robust foundation for equity screening and multi-factor ranking. However, quantitative trading systems operating in dynamic markets like the National Stock Exchange of India (NSE) require continuous hardening. This roadmap outlines remaining systemic gaps across data ingestion, feature engineering, model robustness, and infrastructure, accompanied by prioritized implementation recommendations.

---

## 1. Data Ingestion & Pipeline Monitoring Gaps

While critical fetchers like MoneyControl macros and insider transactions have been patched, the broader data pipeline relies on a distributed web of synchronous scripts (`moneycontrol_fetcher.py`, `institutional_deals_fetcher.py`, `fii_dii_history_fetcher.py`) that lack centralized telemetry and automated circuit breakers.

### Identified Vulnerabilities
*   **API Rate Limiting and Payload Drift:** External endpoints (MoneyControl, Trendlyne, TickerTape) frequently alter payload structures or institute aggressive rate limits. Currently, scrapers log exceptions to stdout but continue running, resulting in silent data truncation.
*   **Asynchronous Harmonization:** Ingestion schedules are loosely managed via cron or manual triggers. If an upstream fetcher (e.g., FII/DII daily flow) experiences network timeouts, downstream ranking models run on stale data without blocking execution.

### Strategic Recommendations
1.  **Unified Pipeline Orchestration:** Migrate ingestion scripts to a directed acyclic graph (DAG) scheduler (such as Apache Airflow or Prefect) with explicit dependency enforcement (e.g., *OHLCV -> Fundamentals -> Feature Engineering -> Ranking*).
2.  **Automated Health Checks and Alerts:** Implement automated assertions verifying row counts and freshness SLAs before each daily ranking cycle. If critical tables (like `stock_ohlcv` or `institutional_deal_signals`) fail to update by a specified hour, trigger an immediate alert and halt downstream model scoring.

---

## 2. Feature Engineering & Alpha Gaps

The recent integration of institutional block deals and MoneyControl ranked insights into the `unified_score` closed a major alpha gap. However, several high-value alternative data streams remain underutilized.

### Unexploited Alpha Vectors
*   **Options Market Microstructure (Order Flow Toxicity & PCR):** While Open Interest (OI) and Put-Call Ratio (PCR) fetchers exist, their signals are not fully incorporated into the cross-sectional ranking engine. Order flow toxicity metrics (e.g., VPIN - Volume-Synchronized Probability of Toxicity) can preempt institutional distribution.
*   **Supply Chain and Sector Concentration:** Cross-stock supply chain linkages (e.g., auto ancillaries reacting to OEM delivery numbers) are currently treated in complete isolation.

### Strategic Recommendations
1.  **Options Sentiment Integration:** Extend `unified_ranker.py` to ingest option-chain skew and change in IV (Implied Volatility) relative to HV (Historical Volatility) as a direct multiplier for breakout conviction.
2.  **Sector-Relative Momentum Normalization:** Refactor momentum features to compute excess returns relative to sector indices rather than the broad market benchmark (Nifty 50), filtering out sector-beta noise.

---

## 3. Model Robustness & Backtesting Gaps

The ensemble and ranking models rely heavily on heuristics and cross-sectional scoring weights. While regime-based weighting (`REGIME_WEIGHTS`) provides adaptability, the model lacks dynamic self-calibration.

### Methodological Limitations
*   **Look-Ahead Bias in Hyperparameter Tuning:** Cross-validation splits in `ml_ensemble.py` must strictly enforce walk-forward embargoes to prevent leakage from overlapping forward-return labels (e.g., 21-day holding periods).
*   **Regime Classification Lag:** Market regime shifts (Bull to Bear or Rangebound) are currently determined via moving-average crossovers on benchmark indices, which suffer from lag during sharp trend reversals.

### Strategic Recommendations
1.  **Walk-Forward Out-of-Sample Testing:** Institute a mandatory walk-forward validation harness that retrains the ranker weights monthly on rolling 2-year windows, ensuring model parameters adapt organically to changing market regimes.
2.  **Hidden Markov Model (HMM) Regime Detection:** Replace heuristic moving-average regime filters with an HMM trained on volatility, breadth, and FII/DII flow vectors to capture regime transitions earlier.

---

## 4. Infrastructure & Performance Bottlenecks

The platform currently operates in a dual-mode environment supporting both SQLite (local development/testing) and PostgreSQL/TimescaleDB (production).

### Architectural Friction
*   **Query Translation Overhead:** The `db_compat.py` and `sql_translate.py` layers dynamically rewrite SQL queries to support dual dialects. This introduces maintenance overhead and obscures database-specific optimizations.
*   **Hypertable Compression Constraints:** TimescaleDB compression policies on high-frequency tables (`stock_ohlcv`, `intraday_ohlcv`) occasionally conflict with retroactive data corrections, requiring manual chunk decompression.

### Strategic Recommendations
1.  **Native PostgreSQL Transition:** Fully deprecate SQLite for production workloads and standardize entirely on PostgreSQL with TimescaleDB extensions, eliminating query translation layers and unlocking native hypertable analytical functions.
2.  **Read-Replication for Heavy Analytics:** Separate transactional ingestion traffic from analytical ranking queries by introducing a read-replica for the ML ensemble and backtesting engines.

---

## 5. Prioritized Action Matrix

| Priority | Initiative | Target Component | Expected Impact |
| :--- | :--- | :--- | :--- |
| **High** | Automated Pipeline DAG & Freshness SLAs | Ingestion Scripts | Eliminates silent failures and stale-data processing. |
| **High** | Options Skew & VPIN Integration | `unified_ranker.py` | Captures sophisticated institutional hedging and positioning. |
| **Medium** | Walk-Forward Validation Harness | `ml_ensemble.py` | Prevents overfitting and ensures out-of-sample stability. |
| **Medium** | HMM-Based Market Regime Detection | Regime Engine | Reduces lag during rapid macro trend transitions. |
| **Low** | Full PostgreSQL/TimescaleDB Standardization | `db_compat.py` | Simplifies data access layer and improves query performance. |

---
**Prepared by:** Manus AI  
**Date:** August 12, 2026
