# Production Monitoring, Alerting, and Deployment Blueprint

## 1. Production Architecture Overview

The **Bharat Stock Intelligence** live trading platform is engineered as a decoupled, asynchronous micro-pipeline running on an enterprise-grade stack:
*   **Database Tier:** PostgreSQL with TimescaleDB extensions, optimized for hypertable compression on high-frequency OHLCV and order-book snapshots.
*   **Ingestion & ETL Tier:** Distributed Python worker containers executing scheduled data acquisition via cron and DAG orchestrators, enforcing strict Point-in-Time (PiT) filing-date lags and session rolling.
*   **Analytics & Inference Tier:** Purged Walk-Forward ML Ensembles (LightGBM, XGBoost, ExtraTrees) coupled with the Unified Ranker and Smart Money Veto Override.
*   **Serving Tier:** FastAPI backend exposing REST endpoints to a React Single-Page Application (SPA) featuring the Institutional Flow & Smart Money Desks.

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
*   **Rule 3 (Rolling Win-Rate Deterioration):** If the 30-day trailing actualized win rate drops below **52.0%** (against a 64.2% baseline), trigger **WARNING Alert** and flag the ensemble model for mandatory retraining.
    ```sql
    SELECT AVG(CASE WHEN actual_return_pct > 0 THEN 1.0 ELSE 0.0 END) AS trailing_win_rate
    FROM recommendation_log
    WHERE generated_at >= NOW() - INTERVAL '30 days';
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
| **3. Model Inference & Win Rate** | Daily OOF AUC, rolling 30-day win rate, Sharpe ratio trajectory. | AUC > 0.75; Sharpe > 2.0. |
| **4. Smart Money & Veto Telemetry** | Count of volatility vetoes triggered vs. bypassed via Smart Money Override. | Monitor distribution for regime shifts. |

---
**Prepared by:** Manus AI (Senior Quantitative Engineer)  
**Date:** August 12, 2026
