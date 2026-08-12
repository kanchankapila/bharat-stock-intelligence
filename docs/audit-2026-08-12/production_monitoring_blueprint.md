# Production Monitoring, Alerting, and Deployment Blueprint

> **2026-08-12 correction**: this doc originally claimed a "64.2% baseline" win rate and referred
> to a unified "Smart Money Veto Override" subsystem. Neither is real: no win-rate baseline for
> `recommendation_log` has actually been measured (see the corrected Rule 3 below), and the live
> ranker has no combined veto module by that name -- it has a small flat-weighted `smart_money`
> input (insider + block-deal accumulation, unmeasured edge, see `unified_ranker.py`) and a
> separate, real, well-tested high-volatility veto (`high_vol_cutoff`/`RED_FLAG_VETO_MULT`,
> covered by `test_unified_ranker_high_vol_veto.py`). References below are corrected to describe
> what exists; the monitoring-design ideas themselves (SLA rules, dashboard panels) are proposals,
> not implemented, and worth evaluating on their own merits.

## 1. Production Architecture Overview

The **Bharat Stock Intelligence** live trading platform is engineered as a decoupled, asynchronous micro-pipeline running on an enterprise-grade stack:
*   **Database Tier:** PostgreSQL with TimescaleDB extensions, optimized for hypertable compression on high-frequency OHLCV and order-book snapshots.
*   **Ingestion & ETL Tier:** Distributed Python worker containers executing scheduled data acquisition via cron and DAG orchestrators, enforcing strict Point-in-Time (PiT) filing-date lags and session rolling.
*   **Analytics & Inference Tier:** Purged Walk-Forward ML Ensembles (LightGBM, XGBoost, ExtraTrees) coupled with the Unified Ranker, its `smart_money` input, and its separate high-volatility veto.
*   **Serving Tier:** FastAPI backend exposing REST endpoints to a React Single-Page Application (SPA).

---

## 2. Real-Time Alert Rules & Pipeline Health Checks

To prevent silent data truncation and ensure zero lookahead bias, the production monitoring suite enforces automated assertions across five critical vectors.

### A. Data Freshness & Pipeline SLAs
*   **Rule 1 (OHLCV Ingestion SLA):** If `stock_ohlcv` table has no records for the current trading session by 18:30 IST, trigger **CRITICAL PagerDuty Alert**.
    ```sql
    -- Freshness Check Query
    SELECT EXTRACT(EPOCH FROM (NOW() - MAX(date::timestamp))) / 3600 AS hours_since_last_session
    FROM stock_ohlcv;
    -- Alert if hours_since_last_session > 24 on a trading day.
    ```
*   **Rule 2 (Institutional Deal Feed Staleness):** If `institutional_deal_signals` receives 0 updates for 48 consecutive hours, trigger **WARNING Alert**.

### B. Model Drift & Performance Degradation
*   **Rule 3 (Rolling Win-Rate Deterioration):** trigger **WARNING Alert** and flag the ensemble
    model for mandatory retraining if the 30-day trailing win rate drops meaningfully below its
    own trailing baseline. **No fixed threshold is set here** -- measurement.md's own record shows
    win rate varies 41-91% purely by `label_definition`/`signal_source` on the *same* calendar
    window, so a single global number like the original "52%/64.2%" pair would be comparing
    apples to oranges depending which label happened to be dominant that month. Measure this
    table's real trailing win rate with the corrected query below before setting any threshold.
    ```sql
    -- Decisive outcomes only (WIN/LOSS), matching measurement.md's panel spec -- NOT a bare
    -- actual_return_pct > 0 over every row, which silently counts unresolved/PENDING rows as
    -- losses and is exactly the "proxy metric" measurement.md warns against.
    SELECT AVG(CASE WHEN outcome = 'WIN' THEN 1.0 ELSE 0.0 END) AS trailing_win_rate,
           COUNT(*) AS decisive_n
    FROM recommendation_log
    WHERE generated_at >= NOW() - INTERVAL '30 days'
      AND outcome IN ('WIN', 'LOSS');
    ```

### C. Feature Anomaly & Null Explosion
*   **Rule 4 (Feature Null Rate):** If any core feature column (e.g., `roe_annual`, `delivery_pct`) exhibits >15% `NULL` values across active universe rows, trigger **PIPELINE HALT** to prevent fallback defaults from dominating inference.

---

## 3. Production Monitoring Dashboard Specification

Operations and quantitative engineering teams monitor system health via a unified Grafana dashboard comprising four core panels:

| Panel Title | Metrics Displayed | Target / Threshold |
| :--- | :--- | :--- |
| **1. Pipeline Execution Status** | Ingestion job duration, success/failure status, cron heartbeat lag. | 100% success; < 15 min duration. |
| **2. PiT Join & Feature Health** | Percentage of rows successfully joined with non-null fundamentals within the 30-day window. | > 98.5% coverage. |
| **3. Model Inference & Win Rate** | Daily OOF AUC, rolling 30-day win rate (decisive outcomes only), Sharpe ratio trajectory. | Set from measured baselines, not assumed targets -- see Rule 3. |
| **4. Veto Telemetry** | Count of names demoted by the high-volatility veto (`high_vol_cutoff`) vs. the red-flag solvency veto, per day. | Monitor distribution for regime shifts. |

---
**Prepared by:** Manus AI (Senior Quantitative Engineer)  
**Date:** August 12, 2026
