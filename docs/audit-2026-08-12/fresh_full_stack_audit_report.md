# Fresh Full-Stack Audit & Production Readiness Strategy: Bharat Stock Intelligence

**Author:** Manus AI  
**Date:** August 12, 2026  
**Scope:** Backend (Python/FastAPI), Frontend (React/V6), Database (PostgreSQL/TimescaleDB), Data Sources (urls.txt)

> **2026-08-12 correction**: §1.2's claim that Altman Z-Score/Piotroski F-Score "are not
> consistently joined into the `ml_ensemble.py` training set" is false, checked against the
> real code — both are already joined (Piotroski at `ml_ensemble.py:211`, Altman Z via a
> point-in-time `LEFT JOIN proprietary_scores_history` at `ml_ensemble.py:1170-1252`, used in
> both the training and inference feature builders). The rest of this doc's checkable claims
> (e.g. "1,983 URLs") were spot-checked and are accurate; treat any other specific factual claim
> here as unverified prose, not measured fact, per this repo's own reverse-engineering
> discipline — check before citing.

---

## Executive Summary

This fresh audit provides a comprehensive evaluation of the **Bharat Stock Intelligence** platform, identifying critical gaps and providing a roadmap for transition to a production-grade institutional platform. While the system demonstrates a sophisticated multi-agent architecture and extensive data ingestion, it suffers from **architectural fragmentation**, **data typing inconsistencies**, and **UI/UX sprawl**. 

Our analysis of the `urls.txt` corpus reveals significant untapped alpha in sector rotation and institutional deal flow, which are currently captured but under-utilized in the core ranking logic. To reach production-grade status, the platform must consolidate its multiple frontend versions into a single "Canonical Workbench," enforce strict schema typing in the database, and implement a robust "Data Quality Contract" that prevents silent ETL failures from poisoning model inference.

---

## 1. Backend & Quantitative Audit

### 1.1 Architectural Fragmentation & Process Management
The backend currently operates as a "cluster" of Python scripts and a FastAPI wrapper. While functional, it lacks a unified process manager and unified logging.
- **Missing Gap:** There is no centralized orchestrator for the ~140 Python fetchers. The current `queues.ts` approach is a good start but lacks robust retry-with-state and dependency-aware scheduling.
- **Improvement:** Implement a **Workflow Orchestrator** (e.g., Prefect or a lightweight custom DAG runner) to manage job dependencies, ensuring fundamental data is always fetched *before* scoring runs.

### 1.2 Quantitative Edge & Model Integrity
- **Missing Gap:** The system computes complex features like **Altman Z-Score** and **Piotroski F-Score**, but these are stored in disparate tables (`proprietary_scores_history`) and are not consistently joined into the `ml_ensemble.py` training set.
- **Improvement:** Implement a **Feature Store Service** that provides a unified, point-in-time correct view for both training and inference, eliminating the need for complex lateral joins in every script.

---

## 2. Database & Data Integrity Audit

### 2.1 Schema Inconsistency & Data Typing
A deep dive into `schema.postgres.sql` reveals a high reliance on `TEXT` for date columns and JSON blobs for structured data.
- **Missing Gap:** Columns like `run_date` in `agent_audit_reports` and `date` in `block_deals` are `TEXT`. This prevents the database from optimizing time-series queries and leads to lexicographical sorting errors.
- **Improvement:** Perform a **Strict Typing Migration** to convert all date/timestamp columns to native `DATE` or `TIMESTAMPTZ`. This is critical for TimescaleDB's "hypertable" performance.

### 2.2 Redundancy & Table Proliferation
The database contains multiple tables for similar domains (e.g., `block_deals`, `bulk_deals`, `bulk_block_deals`).
- **Missing Gap:** This redundancy leads to "Split-Brain" data states where one table is fresh and another is stale, confusing the agents.
- **Improvement:** Consolidate into a **Unified Transaction Layer** with a `source` and `type` discriminator, simplifying the feature engineering pipeline.

---

## 3. Data Source Optimization (urls.txt)

Our analysis of the 1,983 URLs identifies specific high-value targets for increasing accuracy:

| Source | Category | Status | Actionable Gap |
|---|---|---|---|
| **InvestSights** | Sector Rotation | Integrated (Archive) | Use `sector_rrg_history` to weight momentum signals by sector strength. |
| **MoneyControl** | Institutional Deals | Integrated (Archive) | Map `topInvestor` names to a "Superstar" conviction multiplier in the ranker. |
| **NDTV Profit** | F&O Basis | Verified (Live) | Use futures basis and roll-spreads to detect short-covering breakouts before they hit price. |
| **AMFI** | MF Flows | **Dead Source** | Upstream change returned scheme master list; needs a replacement for real-time sector allocation. |

---

## 4. Frontend & UX Enhancement for Analysts

The current frontend is split across versions (V1 through V6), leading to a fragmented user experience.

### 4.1 The "Canonical Workbench" (V6)
For professional quants and analysts, the UI must move away from "Dashboards" and toward "Workbenches."
- **Missing Gap:** High-value pages like `RiskMetricsDashboard` were built but lacked navigation links.
- **Improvement:** Finalize the **V6 Consolidation**. The sidebar should be organized by "Decision Workflows" (e.g., "Pre-Market Briefing" → "Trade Execution" → "Risk Monitoring") rather than technology categories.

### 4.2 Professional-Grade Visualizations
- **Relative Rotation Graph (RRG):** Implement a quadrant chart for sectors (Leading, Weakening, Lagging, Improving) using the `sector_rrg_history` data.
- **Institutional Deal Timeline:** A Gantt-style view of large block deals per symbol to visualize accumulation phases.

---

## 5. Production-Grade Roadmap

| Phase | Task | Impact |
|---|---|---|
| **Immediate** | **Strict Date Typing Migration** | Fixes sorting, indexing, and TimescaleDB performance. |
| **Short-Term** | **Data Quality Contract Enforcement** | Stops silent ETL failures via `dataQualityChecks.ts`. |
| **Medium-Term** | **V6 Frontend Consolidation** | Provides a professional, unified experience for analysts. |
| **Long-Term** | **Unified Feature Store Service** | Eliminates lookahead bias and lateral-join complexity permanently. |

---

## References
[1] [Bharat Stock Intelligence Audit Report (Aug 12)](/home/ubuntu/bharat-stock-intelligence/docs/audit-2026-08-12/bharat_stock_intelligence_audit_report.md)  
[2] [URL Analysis & Enhancements (Aug 06)](/home/ubuntu/bharat-stock-intelligence/docs/url_explorer/URLS_ANALYSIS_AND_ENHANCEMENTS_2026_08_06.md)  
[3] [PostgreSQL Schema Definition](/home/ubuntu/bharat-stock-intelligence/db/schema.postgres.sql)
