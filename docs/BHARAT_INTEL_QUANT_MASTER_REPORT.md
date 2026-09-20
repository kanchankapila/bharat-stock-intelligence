# Bharat Intel — Quantitative Master Report

**Date:** 2026-09-18 · **Author:** Cline (principal-quant session, resumption) · **Mode:** evidence-first forensic analysis

**Evidence base for every claim below:**

| Source | What it provided | Freshness |
|---|---|---|
| Live Postgres `bharat_intel` @ :5433 (read-only probes `scratch_verify/quant_discovery_probe*.py`; outputs `quant_inventory.json`, `quant_probe4_out.txt`) | 499 relations incl. Timescale chunks, 27.33 GB, 234 public tables, 6 hypertables, registry/screener counts, indexed MIN/MAX date ranges, symbol coverage | measured 2026-09-18 |
| `unique_urls.txt` + `unique_urls_stats.json` | 3,103 unique URLs / 43 hosts, domain histogram (computed this session) | static file |
| `.claude/rules/measurement.md` (+ `docs/measurement-history.md`) | the platform's graded factor record: real edge vs dead, panel spec, power rules | re-verified 2026-09-10; corrections 2026-09-12 |
| `docs/data-pipeline-audit-2026-09-17.md` (+ AF-20260917-20..24 remediation, deployed 09-18) | freshness/jobs/serving-gap evidence, provider labels, 85 jobs, 113 freshness probes | 2026-09-17/18 |
| `docs/mover_study_report.md` | 218,948 mover events, 83 classes, factor-lift table, engine hit-rates | 2026-09-15 |
| `docs/audit-findings.md`, `.claude/rules/data-sources.md`, `docs/INGESTION_PIPELINE.md` | data-quality incidents, provider-ID map, ingestion specs | current |

Where this report says **DATA NOT AVAILABLE**, **LOW CONFIDENCE**, or **RESEARCH CANDIDATE**, that is a finding, not a hedge. This platform already has a measurement culture (`measurement.md`) that has repeatedly demonstrated with live data that *shipped ≠ predictive*. Nothing below contradicts it.

---

## 1. Executive Summary

**What Bharat Intel has today** (measured live 2026-09-18):

- A **27.3 GB TimescaleDB** (`bharat_intel`, :5433) with **234 public tables**: 5.7 years of daily OHLCV (2.69M rows, 2,428 symbols, 2021-01-01→2026-09-18), 15 years of news (106.8K items back to 2011-07-08), intraday bars, a 2.68M-row rolling `feature_store`, 7.3M rows of intraday `confluence_signals`, 1.6M intraday recommendation cycles, 1.03M `signal_outcomes`, 12.25M live-screener appearances with 9.2M tracked outcomes, F&O (option chains, index PCR/OI/max-pain, futures OI/basis/rollover), delivery data (734K rows, 2025-06→), corporate actions back to 1994, insider trades (80K), analyst estimates, breadth, and regime tables.
- A **3,408-entry discovery registry** (`market_endpoint_registry`: 3,327 EQUITY + 81 FNO; 18 provider labels) + **834 URL templates** + **3,103 unique URLs across 43 hosts** — Trendlyne ≈70%, MoneyControl ≈17%. **1,672 configured screeners** (Trendlyne 1,006 / ETnow 438 / MC 133 / et_marketstats 95).
- A **live decision pipeline**: BullMQ/Redis + pm2 → 81 Python fetchers → raw tables → `technical_signals` (2,281 symbols) → `feature_store` → engine scores (technical/ml/dl/confluence/cs/smart_money/screener) → `unified_ranker.py` (EOD) + `intraday_ranker.py` (15-min cycles) → `unified_recommendations` (59,239 rows) → Telegram digests, tRPC API, Grafana.
- A **mature measurement discipline**: `factor_edge.py` (rank-IC/AUC grader, independent-period power accounting), `factor_backtest.py` (cost-aware backtester), `assembly_ablation.py`, `factor_edge_history` (1,571 readings), `model_registry` (champion/challenger), `signal_outcomes`, DQ subsystem (496K rows).

**The single most important finding:** the platform's own graded record already answers the Phase-19/35 questions better than any new analysis could today, and its answers are deflating in a productive way:

1. **The one well-powered positive edge is 5-day mean reversion** (`feature_store` `rsi_14`/`bb_pct`/`ret_5d` inverted: rank-IC ≈ −0.04…−0.05 @5d, AUC 0.481–0.488, on 1,376–1,415 dates ≈ 275 independent observations; survived a full data-rebuild re-run on raw columns, 2026-09-10).
2. **The best currently-growing lead is `confluence_score`** (cross-evidence engine): rank-IC +0.084 @5d / +0.113 @10d / +0.168 @21d, AUC to 0.583 — strongest reading of any engine, still LOW-DATA (18/13/2 dates), already the highest-weighted engine in `REGIME_WEIGHTS` (0.30–0.378).
3. **Momentum is dead on this universe** at every tested construction (`momentum_21d/63d` t to −3.96; `momentum_12_1` t=1.45 NS post-cost; `reversal_21d` negative); **institutional/insider/vendor factors NS or no-edge** (`insider_net` t=1.73; `smart_money_score` IC ≈ 0; all 10 `ext_*` vendor columns no-edge at 1d/5d); and **two "different vendors'" quality columns are byte-identical** (corr = 1.0, AF-20260906-06) — direct proof that vendor count ≠ information count.
4. **Cost-awareness is decisive**: `win_probability` carried a real IC and still failed at 83.4% turnover. The mover study shows `technical_rank` top-20 hit-rate on next-day movers of 0.4–1.6% — the EOD engine effectively never sees the next day's movers coming. The intraday surface (confluence, movers, live screeners) is where unexploited information lives.
5. **Power, not ideas, is the binding constraint**: `factor_edge.py`'s overlapping-window bug (AF-20260912-15) invalidated most short-panel leads; after correction, of 895 readings only 46 had ≥20 independent periods and 1 survives. Most proposed factors are ungradeable for weeks-to-months for calendar reasons.

**What it can become:** a regime-gated, cost-aware, evidence-graded signal factory whose EOD ranker is honest but modest (~IC 0.05 @5d), whose intraday engine exploits the platform's genuinely differentiated assets (real-time live-screener snapshots, mover event stream, delivery/confluence history), and whose every candidate signal passes the existing `factor_edge`/`factor_backtest` gates with the independent-observations rule before receiving weight. The path is **not more data** (a vendor-onboarding freeze already exists because "more data kept not helping") — it is **outcome instrumentation of the intraday surface, per-symbol completeness watermarks, and a small set of pre-registered combination experiments**.

---

## 2. Complete Data Inventory (measured)

Method: catalog-only read-only probes (no `MAX(ts)` scans over large tables — AF-20260917-23 contention rule). Row counts are `pg_class.reltuples` estimates (marked ~; exact `count(*)` where stated). Hypertable parents show reltuples = 0 — a Timescale artifact; exact counts given where probed. Machine-readable inventory: `scratch_verify/quant_inventory.json` (every column of every table, type + nullability). Full table list: Appendix A.

### 2.1 Headline numbers

- **Database**: `bharat_intel`, PostgreSQL + TimescaleDB, port **5433**. **499 relations** (incl. ~120 `_timescaledb_internal` chunks), **27.33 GB**, **234 tables in `public`**, **6 hypertables** (`stock_ohlcv`, `intraday_ohlcv`, `feature_store`, `confluence_signals`, `macro_asset_prices`, `tick_data`), **0 materialized views**.
- **Registry layer**: `market_endpoint_registry` **3,408** (3,327 EQUITY / 81 FNO_DERIVATIVES; 18 provider labels) · `url_endpoints` **834** templates · `url_params` 2,375 · `url_fetches` 1,926 · `ai_endpoint_registry` · `screener_master` **1,672**.
- **Orchestration**: BullMQ/Redis schedules in `queues.ts` + `jobs/*.jobs.ts`; **85 job names** with runs in the trailing 7 days; `job_run_history` 31,065 rows; `job_heartbeat` 120 jobs; pm2 supervision; `pythonRunner.ts` caps 5 concurrent Python processes.

### 2.2 Canonical Data Inventory Matrix — Phase 1 requested format

Terse by necessity (11 columns); see §2.3–§2.7 for detail and Appendix A for all 234 tables. Depth/coverage from the 2026-09-18 probes.

| Dataset | Table/API | Description | Market Concept | Freq | Hist. Depth | Coverage | Key Fields | Quality | Potential Use | Horizon |
|---|---|---|---|---|---|---|---|---|---|---|
| Daily OHLCV | `stock_ohlcv` | Adjusted EOD bars | Price/volume | Daily | 2021-01→2026-09 (2.69M rows) | 2,428 symbols | o/h/l/c/v, `is_suspect`, adj basis | A− | Return panel, all targets | All |
| Intraday bars | `intraday_ohlcv` | 15-min bars | Microstructure-lite | Intraday | ~2 y | 2,347/09-16 | ts, ohlcv | B (timing SLA unproven) | Intraday targets, MFE/MAE | Intraday |
| Technical indicators | `technical_signals` | ~100 cols incl. vendor `ext_*` | Technical | Daily | 2024-06→ | 2,281 | rsi_14, adx, breakouts | B (duplicate vendors) | Features; ext_* graded no-edge | 1–21d |
| Feature store | `feature_store` | Engineered cross-section + `target_ret_5d` | Features | Intraday refresh | rolling (09-13→09-17 visible) | 2,426 | ret_5d, rsi_14, bb_pct, adx | B+ post-rebuild | ML features; mean-reversion edge | 1–21d |
| Mover events | `mover_snapshots` | Gap/open=high/low/vol-shock/breakout | Event | Intraday | ≥2 y | universe | event_class, ts | B+ | Intraday event backbone | Intraday |
| PE/PB history | `trendlyne_pe_history`, `trendlyne_pb_history` | Daily valuation TS | Valuation | Daily | ~2 y (4.2M each) | ~2,000 | pe, pb, date | C+ (restatement risk) | Valuation percentiles | Swing+ |
| Fundamentals | `fundamentals_history`, `investsights_fundamentals_history` | PIT financials (ROE source), history table | Quality/growth | Daily acq. | ~1 y+ | partial (ROE 929 syms) | roe, growth, margins | B (PIT-verified) | Quality factors | Pos/LT |
| Deep financials | `dalalos_financial_trends_history` | Revenue/EPS history 2005+ | Growth | Quarterly | **20 y** | partial | period_end, revenue, eps | B | LT factor research | LT |
| Analyst estimates | `analyst_estimates_history` | Consensus + revision trio | Revisions | Daily | 2026-06→ (37K rows) | ~2,000 | eps_rev_3m, target_rev_3m | B (ungraded, young) | Revision momentum | Swing+ |
| Corporate actions | `corporate_actions` | Splits/bonus/dividends | Bias control | Event | **1994→2026** (26K rows) | full | ex_date, action_type | A− | Adjustment + blackout windows | All |
| Delivery | `stock_delivery_data` | NSE delivery qty/% | Accumulation | Daily T+1 | 2025-06→ (734K) | 2,976 | deliv_qty, deliv_pct | B+ | Delivery-accumulation factor | Swing |
| Futures OI | `stock_futures_oi_history` | OI/basis/rollover/buildup | Positioning | Daily | 2026-08-21→ (4.9K) | F&O list | oi_chg, basis, rollover | C+ (14 dates) | OI confirmation | 1–10d |
| Index derivatives | `nt_index_pcr_ts`, `nt_index_oi_eod`, `index_max_pain` | Index PCR/OI/max-pain | Positioning | Intraday/EOD | ~1–2 y (212K) | NIFTY/BNF | pcr, oi, max_pain | B+ | Regime/sentiment input | Intraday–swing |
| Option chain | `so_option_chain` | Stock option chains | IV/skew | EOD | 569K rows | F&O list | strike, iv, oi | B− (EOD only) | IV/skew features | 1–10d |
| Insider | `insider_trades` | SAST/PIT trades | Institutional | Event | ~1 y (80K) | partial | qty, value, type | B | Weak confluence input | Pos |
| Deals | `block_deals`, `institutional_deal_signals` | Bulk/block disclosures | Smart money | T+1 | ~1 y | partial | client, qty, price | B (`bulk_deals` dead) | Deal context | 1–20d |
| News | `news_sentiment_items`, `news_articles` | Headlines + sentiment, symbol-linked | Sentiment | Event | **2011-07→2026-09 (106.8K)** | broad | sentiment, published_at | B+ | Event studies, detectors | 1–5d |
| Breadth/regime | `market_breadth`, `market_regimes` | A/D + regime labels | Context | Daily | ~1 y (1,429/707) | market | breadth, regime | B− (`regime_edge_status` empty) | Filters | All |
| Screeners | `screener_master` + `live_screener_appearances/_outcomes` | 1,672 screens; memberships + outcomes | Vendor opinions | Intraday/EOD | 12.25M appearances / 9.2M outcomes | broad | screener_id, symbol, outcome | B | Candidate generators + lab | Intraday–swing |
| EOD ranker | `unified_recommendations(_history)` | Fused engine output | Signal | Daily | 2026-08-10→ (100.7K) | ~1,900/day | unified_score, engines, class | B (LOW-DATA) | Serving surface | 5–21d |
| Intraday ranker | `intraday_recommendations(_history)` | Cyclic intraday picks | Signal | 15-min | ~2 y (1.6M) | ~1,400/cycle | score, computed_at | B− (no grading) | Intraday serving | Intraday |
| Outcomes | `signal_outcomes`, `signal_excursions` | Realized MFE/MAE/labels | Ground truth | Daily | 1.03M/395K rows | tracked | label_definition, mfe, mae | B+ | Learning loop | All |
| Models | `model_registry`, `deep_learning_predictions` | Champion/challenger + DL preds | Models | Weekly/daily | 177 rows | — | cv_roc_auc, is_active | C (DL ungraded) | Promotion gating | All |

### 2.3 Price / Technical

| Dataset | Table | Freq | Depth (measured) | Coverage | Quality / graded evidence | Use → Horizon |
|---|---|---|---|---|---|---|
| Daily OHLCV | `stock_ohlcv` (hypertable) | Daily | **2021-01-01→2026-09-18, 2,691,505 rows (exact)** | **2,428 symbols** | Good; ~425 `is_suspect` quarantined bars (`ohlcv_quality.py`); winsorise mandatory (+127,900% RELIANCE bar recorded); corporate-action basis tracked (`ohlcv_adjustment_basis()` + 2,737 factors) | **Primary return panel for all backtests** → All |
| Intraday OHLCV | `intraday_ohlcv` (hypertable, 60 chunks) | ~15-min | ~2 y | 2,347 symbols, 60,035 bars on 09-16 | Bars retrospectively complete; **signal-time availability not proven** (audit P1) | Intraday targets/MFE-MAE → Intraday |
| Technical signals | `technical_signals` | Daily | **2024-06-01→2026-09-18, 124,424 rows (exact)** | 2,281 symbols | ~100+ indicator + vendor `ext_*` columns; two vendor columns corr = 1.0 (AF-20260906-06); `fcf_yield` never written; graded: ext_* **no-edge** at 1d/5d | Feature source → 1–21d |
| Feature store | `feature_store` (hypertable) | Intraday refresh | rolling retention; **visible 2026-09-13→09-17, 2,683,263 rows (exact)** | 2,426 symbols | **Rebuilt 2026-09-10** (was per-symbol RobustScaler — quarantined, now raw); pre-rebuild rows must never be pooled with post | ML features; hosts the 5d mean-reversion edge → 1–21d |
| Mover events | `mover_snapshots` 426,662 ~ | Intraday/EOD | ≥2 y | universe-wide | 218,948 events / 83 classes in mover study (calc_* + vendor classes) | **Intraday event backbone** → Intraday |
| MC price feed | `mc_pricefeed_daily` 102,676 ~ | Daily | — | ~2,000 | Redundant with `stock_ohlcv` core | Cross-check only |

### 2.4 Fundamentals / Earnings / Analyst

| Dataset | Table(s) | Depth (measured) | Quality / graded evidence | Use → Horizon |
|---|---|---|---|---|
| Valuation history | `trendlyne_pe_history` 4,151,477 ~; `trendlyne_pb_history` 4,195,898 ~ | ~2 y daily, ~2,000 symbols | Vendor-derived; not guaranteed point-in-time | Valuation percentile features → Swing+ |
| Fundamentals | `fundamentals_history` 139,229; `historical_fundamentals` 73,329; `stock_fundamentals` | ROE 151/2,474 in `stock_fundamentals` = thin; the **good ROE** is `investsights_fundamentals_history.return_on_equity` (Pearson 0.9608 vs yfinance, 0 sign flips; the `investsights_factor_scores.roe` twin 0.7727 with sign flips was rejected — AF-20260917-07) | Point-in-time backward as-of merge verified (older accepted, future excluded, pre-history unknown) | Quality/growth → Positional/LT |
| Deep financials | `dalalos_financial_trends_history` 60,247 | Revenue/EPS/growth **2005+** (deepest panel) | MCP bridge | LT factor research |
| Vendor financials | `marketsmojo_financials_history` 4,261,971 ~ (1.07 GB); `marketsmojo_technical_history` 17,259,576 ~ (3.63 GB — largest table) | ~2 y | **Low information density per GB**; compression/downweight candidate | Cross-check |
| Cash flow | `finstack_cashflow_history`, `et_cashflow_history` — **near-empty** | — | 13 US-companies contamination purged 09-12 (AF-20260912-01); **DATA NOT AVAILABLE at volume** | FCF quality → LT (blocked) |
| Earnings | `stock_earnings_dates` 3,752; `mc_earnings_rapid` 18,516; `eps_surprise_history` 1,062 | surprises thin | `earnings_beat_yoy/qoq` calendar-blocked (~12 months of history needed) | Event risk filter, earnings features → 1–20d |
| Analyst | `analyst_estimates_history` **37,166 rows, 2026-06-21→09-17 (exact)**; revision trio (`eps_revision_3m_pct` / `target_revision_3m_pct` / `analyst_count_chg`) live since 09-08; `trendlyne_analyst_targets` 516 | 3 months | Fresh; **ungraded — must not be graded before ~20 dates (~2026-10)** | Revision momentum → Swing+ |
| Corporate actions | `corporate_actions` **26,047 rows, 1994→2026-09-21 (exact)**; `stock_corporate_action_history` 30,293 | 32 y | Back-adjustment basis for OHLCV (mandatory bias control) | All |

### 2.5 F&O / Institutional

| Dataset | Table(s) | Depth (measured) | Graded evidence / notes | Use → Horizon |
|---|---|---|---|---|
| Stock futures OI | `stock_futures_oi_history` **4,865 rows, 2026-08-21→09-17 (exact)** | **14 trading dates** | **LOW-DATA — not gradeable yet** (re-check ~late Sept) | OI/price confirmation → 1–10d |
| Rollover | `fno_rollover` **10,643, 2026-06-29→09-17 (exact)** | ~3 monthly cycles | Was the stale input in the 09-17 ranker miss (AF-20260917-20/24, remediated + make-up run) | Roll-quality → 1–30d |
| Stock option chains | `so_option_chain` 568,957 ~ | EOD scrapes | Heavy stock-option scrapes remain EOD (audit) | IV/skew/max-pain → 1–10d |
| Index derivatives | `nt_index_pcr_ts` 211,784 ~; `nt_index_oi_eod` 48,201 ~; `nt_index_change_oi` 48,199 ~; `index_max_pain` 534; `historical_fno_sentiment` 555 | PCR time series = deepest derivatives panel | Regime + sentiment context | Intraday–swing |
| Delivery | `stock_delivery_data` **734,533, 2025-06-20→09-17, 2,976 symbols (exact)**; `stock_delivery_volume` 162,625 | ~15 months | Post-close T+1 vendor reality | **Delivery-accumulation features (underexploited)** → Swing |
| Insider | `insider_trades` 80,108; `insider_transactions` 23,596 (stale ~05-02) | ~1 y | `insider_net`: **not significant** (t=1.73, re-run 08-12) | Weak — confluence input only |
| Deals | `block_deals` (live, daily); `bulk_block_deals` 425; `bulk_deals` **dead since 2026-05-19 (8 rows)**; `institutional_deal_signals` 956 | — | Dead table confirmed; DQ repointed to `block_deals` | Smart-money context → 1–20d |
| MF holdings | `mf_holdings_no_coverage` 566 (566 confirmed no-coverage; 1,403 fetched within 80d) | Quarterly | Honest empty-vs-error classification (recently hardened) | Ownership quality → LT |

### 2.6 News / Events / Market state

| Dataset | Table(s) | Depth (measured) | Graded evidence / notes | Use → Horizon |
|---|---|---|---|---|
| News + sentiment | `news_articles` 106,604; `news_sentiment_items` **106,802, 2011-07-08→2026-09-18 (exact)**; `news_symbol_link` 102,499 | **15 years** | `f_news_sent` in mover study: IC-class 0.13, n=114, p=0.037 — **lead, not result**; GDELT retired | Event features → 1–5d |
| Announcements | `investsights_announcement_intel` 24,821; `concall_takeaways`; `credit_rating_events`; `stock_event_triggers` 64,342 | — | credit-trend signals documented "too thin" | Event detectors → 1–20d |
| Breadth | `market_breadth` 1,429; `intraday_breadth_snapshots` 923; `mc_advance_decline` 94 | ~1 y | Regime filter | All |
| Regime | `market_regimes` 707; `intraday_regime_history` 933; `regime_edge_status` **0 (never written)** | ~1 y | REGIME_WEIGHTS: BULL/BEAR/HIGH_VOL/CRASH/SIDEWAYS | **Per-regime edge table empty — build it (§13)** |
| Macro | `macro_asset_prices` (hypertable, 7 chunks); `eco_calendar` 1,183 | — | Currency/commodity/yields + econ calendar | Global context → Swing |
| Indices / sector | `index_valuation` 202,940; `marketsmojo_index_history` 183,529; `sector_rrg_history` 1,833; `screener_sector_rotation` 645; `sector_correlation_stats` 620 | — | Sector-rotation engine inputs | Swing+ |

### 2.7 Signals / Outcomes / Models (the intelligence layer)

| Dataset | Table(s) (rows ~) | Notes |
|---|---|---|
| Unified ranker (EOD) | `unified_recommendations` 59,239; `unified_recommendations_history` **100,696, 2026-08-10→09-18 (exact)** | Engines blended via `REGIME_WEIGHTS`; population boundaries 08-18 (zero-vs-NULL), 08-23 (calendar cutoff), 09-14 (dl removed) — **never pool across**; graded: unified_score IC +0.050 @5d (LOW-DATA, mixed-weights panel) |
| Intraday ranker | `intraday_recommendations` 72,396; `intraday_recommendations_history` 1,611,557 ~ (609 MB); 22–25 cycles/day | Independent engine by design; first-cycle timing gap documented (audit P1) |
| Confluence engine | `confluence_signals` **7,315,856, 2026-06-30→09-18 (exact)** | Strongest-graded engine score source (§11) |
| Screener intelligence | `screener_master` 1,672; `live_screener_appearances` 12,254,251 ~; `live_screener_outcomes` 9,202,047 ~; `live_screener_ml_scores` 888,337; `screener_appearances` 1,263,291; `screener_membership_snapshot` 1,137,363; `screener_performance_history` 48,292; `trendlyne_screener_stocks` 177,798 | **Unique asset: 12M appearances with 9M tracked outcomes = a completed screener-predictiveness laboratory** (§10, §20) |
| Outcomes | `signal_outcomes` 1,028,920; `unified_signal_outcomes` 336,189; `signal_excursions` 395,273 | **Signal-lifecycle tracking EXISTS** (Phase-26 requirement already met). Two label conventions (`terminal_pct2` vs `path_barrier`) read **88–91% vs 41–44%** win rate on the same window — always join on `label_definition` |
| Models | `model_registry` 177; `dl_model_performance` 45; `deep_learning_predictions` 137,351; `feature_importance_log` 510; `signal_source_weights` 220; `strategy_performance` 262; `backtesting_runs` 1,390; `backtest_strategies` **0** | Champion/challenger exists (`is_active` bigint 0/1); DL ungraded until first post-fix retrain; **strategy registry (Phase 28) NOT built** |
| Score history | `proprietary_scores_history` 552,972; `quant_scores_history` 60,600; `stock_scores` 9,641 (stale 09-15); `stock_factor_breakdown(_history)`; `trendlyne_dvm_scores` 41,612; `investsights_factor_scores` 58,413; `engine_composite_scores` 113,224 (weekly, 79 dates) | Vendor/composite scores — graded mostly no-edge; feed UI |
| MLOps / DQ | `job_run_history` 31,065; `job_heartbeat` 120; `data_quality_results` 175; `data_quality_history` 496,042 | DoD/DQ gates live here |

**Dead or empty (do not build on):** `tick_data` (hypertable, **0 chunks** — no tick feed exists; **DATA NOT AVAILABLE**), `bulk_deals`, `screener_runs`, `technical_scans`, `signal_actions`, `price_alerts`, `signal_portfolio_correlation`, `portfolio_holdings`, `mf_portfolio_holdings`, `trade_journal`, `watchlist`, `order_book_snapshots` (no order-book feed), `timeframe_scores`, `marketsmojo_stock_picks`, `high_flyer_daily_stats`, `regime_edge_status`, `data_ingestion_dlq`, `backtest_strategies`, `finstack_cashflow_history`/`et_cashflow_history` (near-empty). This is the honest Phase-40 "remove or deprecate" list — zero rows or documented retirement.

---

## 3. Data Taxonomy — what each dataset *means* (Phase 2)

Classification axes: **timing** (leading / coincident / lagging), **derivation** (raw / vendor-derived / platform-derived), **leakage risk** (can it contain information not knowable at signal time?).

| Category | Datasets | Timing | Raw? | Key meaning & caveats |
|---|---|---|---|---|
| Price/volume raw | `stock_ohlcv`, `intraday_ohlcv` | Coincident → target | Raw | The only self-owned truth. Corporate-action basis mandatory; `is_suspect` bars quarantined. |
| Technical derived | `technical_signals`, `feature_store` | Coincident (of price) | Platform-derived | Features, not information: they re-express price. Value = what grading says (§11). ext_* columns are vendor opinions. |
| Movers/events | `mover_snapshots`, `stock_event_triggers` | Leading within-day | Raw-ish | Gap / open=high / volume-shock classes — the intraday event backbone. |
| Fundamentals | `fundamentals_history`, `dalalos_*`, vendor financials | **Lagging** (quarterly, delayed publication) | Vendor + PIT merge | Useful only point-in-time; announcement vs period vs acquisition dates distinct (audit rec #7). |
| Earnings/analyst | `eps_surprise_history`, `mc_earnings_rapid`, `analyst_estimates_history` (+ revision trio) | Leading (estimates) / coincident (results) | Vendor | Revision trio ungraded (calendar-blocked to ~2026-10). |
| Delivery | `stock_delivery_data` | Coincident, T+1 | Raw (NSE) | Underexploited: highest-frequency ownership-behaviour proxy on the platform. |
| F&O | `so_option_chain`, `stock_futures_oi_history`, `fno_rollover`, `nt_index_*`, `index_max_pain` | Leading-ish (positioning) | Raw/vendor | Deep index panels; stock panels young (14 dates). |
| Institutional | `insider_trades`, `block_deals`, MF holdings | Leading (insider/deals) | Raw/vendor | Graded weak standalone (insider_net NS). Confluence-only. |
| News | `news_sentiment_items` (15 y), `investsights_announcement_intel` | **Leading** when fresh | Vendor + NLP | 15-year depth enables event studies no other table supports. |
| Breadth/regime | `market_breadth`, `market_regimes`, `intraday_regime_history` | Context | Platform-derived | Filters, not alpha. |
| Screeners | `screener_master` + appearances/outcomes | Vendor opinions | Vendor | **Candidate feature generators, never truth** (Phase 20) — but the only dataset with 9M pre-tracked outcomes. |
| Engine scores | unified/intraday/confluence/proprietary | Platform outputs | Derived | confluence = only engine score with a growing positive graded reading. |
| Outcomes | `signal_outcomes`, `signal_excursions` | Ground truth | Platform-derived | The learning loop's substrate; label-definition discipline mandatory. |

**Leading vs lagging summary:** genuinely *leading* information on this platform = (a) overnight/pre-open gaps and live-screener surges, (b) fresh news/announcements, (c) derivatives positioning (index PCR), (d) delivery accumulation (T+1), (e) analyst revisions. Everything else is coincident or lagging and earns its place only through measured conditioning value.

---

## 4. Data Reliability & Quality (Phase 4)

No fabricated scores; every item is a documented, live-verified incident or measurement:

| # | Problem | Evidence | Status |
|---|---|---|---|
| 1 | Overlapping forward windows overstated factor power ~h× (only dates/h independent obs) | AF-20260912-15; only 46/895 readings survive | Fixed in `factor_edge.py` (`eff_dates`, `DEGENERATE-XS` guard) |
| 2 | Vendor-quality duplication: `ext_mojo_quality_rank` ≡ `ext_t80_quality_rank`, corr 1.0 across 28,584 rows | AF-20260906-06 | Documented; both downweighted |
| 3 | US-listed companies stored under NSE tickers (yfinance bare-symbol bug); USD currency was the tell | AF-20260912-01 | Fixed (`yahoo_ticker()` → `.NS`); 67 rows purged |
| 4 | `feature_store` stored per-symbol RobustScaler output incl. targets (230,572 rows `target_ret_5d < −1`; RSI ±millions) | AF-20260910-18/-20 | **Rebuilt 2026-09-10; readings re-run on raw** |
| 5 | DL walk-forward sliced a symbol-major panel by row position → 100% train/test date overlap; every pre-09-10 DL AUC inflated (0.65 vs the 0.52–0.55 ceiling all engines hit — the gap WAS the tell) | AF-20260910-08 | Fixed (date-grouped `purged_cv`, 15-day purge); DL = "ungraded" |
| 6 | OHLCV bad bars: +127,900% RELIANCE bar → phantom 850%/yr edge; ~425 suspect bars | `measurement.md` panel spec; `ohlcv_quality.py` | Winsorise + `is_suspect` filter mandatory |
| 7 | Two `signal_outcomes` label conventions read 88–91% vs 41–44% win rate on the same window | `measurement.md` | Join on `label_definition`; never mix |
| 8 | Post-close job cluster exhausted Postgres pool; 13 ml-daily-ops steps failed; ranker consumed 1-day-stale rollover; zero 09-17 recommendations | AF-20260917-20..24 (3,863 timeouts, 545 in one hour; identical-second process-kill signature) | **Remediated + deployed 09-18**; confirm on tonight's run |
| 9 | Symbol mapping: provider IDs opaque; NSE symbol canonical; yfinance needs `.NS`; better ROE twin found by enumerating every table with the column | `.claude/rules/data-sources.md`; AF-20260917-07 | Registry + `stocklist.ts` (2,000 stocks, 89–100% per-field) |
| 10 | Freshness gaps (09-17/18 sweep): `gdelt` retired, `fintrend` 08-26, `engine_composite` 09-11 (weekly), `market_holidays` ≤06-26 (**NSE holiday API returns 200 with 0-byte body**), `insider_transactions` 05-02, `bulk_deals` dead | AF-20260917-22 | Several ACCEPT; holiday alternate **NEEDS USER DECISION** |
| 11 | Timezones: logs IST, DB UTC, `computed_at` TEXT in `unified_recommendations`; naive-UTC epochs in `job_heartbeat`; `factor_edge` converts Asia/Kolkata before day cuts | measurement + journal | Handling rules documented — keep them |
| 12 | Survivorship/coverage: `stocklist.ts` 2,000 mapped vs 2,366 master; no delisted universe file | `data-sources.md` + probes | **Full survivorship control = DATA NOT AVAILABLE**; mitigate via `nse_universe_history` as-of membership |

**Data Quality Score (evidence-graded, not invented):** `stock_ohlcv` **A−** (self-owned, quarantined suspects, adjustment basis) · `feature_store` **B+** post-rebuild · `technical_signals` **B** (duplicate vendor columns) · `news_sentiment_items` **B+** (deep, fresh) · `fundamentals_history` **B** (PIT-verified, thin fields) · `stock_futures_oi_history` **C+** (young) · `marketsmojo_*` **C** (huge, low density, graded no-edge) · DL predictions **D** (ungraded until honest retrain).

---

## 5. URL Intelligence Analysis (Phase 3)

**Volume:** 3,103 unique URLs (from 9,837 raw lines; 6,367 duplicates removed — `unique_urls_stats.json`), **43 distinct hosts**. Machine-readable superset: `market_endpoint_registry` 3,408 rows (3,327 EQUITY + 81 FNO_DERIVATIVES), `url_endpoints` 834 templates, `url_params` 2,375.

**Host histogram (computed this session):** kayal.trendlyne.com **2,041 (65.8%)** · api.moneycontrol.com **411 (13.2%)** · trendlyne.com 131 · appfeeds+priceapi.moneycontrol 66 · frapi+www.marketsmojo 60 · webapi/api.niftytrader 58 · www.moneycontrol 57 · investsights.in 52 · ndtvprofit 24 · ticker.finology 19 · tickertape family 28 · json.bselivefeeds 13 · nseindia.com 12 · sapphirebroking 12 · tapetide 11 · stockedge 9 · sensibull 7 · ET/indiatimes family ~25 · others (trading80, mse, bloombergquint…) ~20.

**Taxonomy (registry categories, top combos measured):** Trendlyne Technical-Indicators-&-Intraday 91 · Trendlyne Derivatives-&-F&O 50 · MoneyControl Market-Data 42 · Trendlyne Indices-&-Breadth 33 · Moneycontrol Indices 31+18 · InvestSights Market-Data 30 · Moneycontrol Price-&-Charts 29+22 · Corporate-Actions 16 · ET Technical-Intraday 15 · MC earnings 15 · premarket 14 · Analyst-Estimates 13 · NiftyTrader F&O 18+12 · News-&-Sentiment 12 · Fundamentals 12 · NSE Market-Data 8.

**Redundancy findings ("what unique information does this source add?"):**

1. **Opinion-layer overlap is severe.** Trendlyne ≈ MoneyControl ≈ MarketsMojo at the score/screener layer. Graded proof: all 10 `ext_*` vendor columns no-edge at 1d/5d, and two "different vendors'" quality ranks are identical (corr 1.0). 1,672 configured screeners compress into `screener_momentum_score`, which no longer clears USABLE post-regrade.
2. **Complementary, non-redundant assets:** NSE delivery data (no vendor substitute); 15-year news panel; live-screener appearance/outcome stream (event-grade, unique); index PCR/OI time series; corporate actions to 1994; `dalalos_*` financials to 2005.
3. **Dead/decayed (documented, do not chase):** GDELT (retired); NSE holiday API (200 + 0-byte body); NiftyTrader Prime-gated POST screeners (401 only when POSTed correctly — 405 on GET proves nothing); Trendlyne under concurrent host load (healthy solo).
4. **Operational rules already encoded (keep):** probe bare headers first (a wrong `sec-fetch-site` value *causes* 403s); distinguish 405/401/403 before declaring a route gated; a round-number `--limit` default is a deferred measurement, not a vendor cap (measured: 1,000 symbols in 129 s, zero failures); registry views `v_stock_screeners` (2,709) / `v_fno_endpoints` (82) for alternates; vendor-onboarding freeze stands — endpoint count ≠ information count (audit rec #8).

**Verdicts:** retain host families feeding live tables; treat `extra_endpoint_responses` (38,370 rows / 472 MB raw JSON) as archive, not serving; deprecate host families with zero live-table writers; never onboard a host before the registry-alternate contract runs.

---

## 6. Market Knowledge Graph (Phase 5)

The conceptual graph exists *implicitly* in the pipeline; here it is with quantifiable edges (each annotated with the realizing table and its graded status):

```text
Market regime (market_regimes, intraday_regime_history)
   ├─ REGIME_WEIGHTS gate ───────────→ engine blend (unified_ranker._blend)   [quantified; live]
   ├─ breadth (market_breadth, intraday_breadth_snapshots) → filters         [ungraded filter]
   └─ index PCR/OI (nt_index_pcr_ts, nt_index_oi_eod) → sentiment tilt       [RESEARCH CANDIDATE]
Sector (sector_rrg_history, screener_sector_rotation, index_valuation)
   └─ sector momentum/rotation → stock relative strength                     [RESEARCH CANDIDATE — not graded]
Stock price/volume (stock_ohlcv, intraday_ohlcv)
   ├─→ technical_signals / feature_store → engine scores          [graded: 5d mean-reversion edge]
   ├─→ movers (mover_snapshots) → intraday detectors              [lift measured: f_mom_5d, f_news_sent]
   └─→ delivery (stock_delivery_data) → accumulation features     [RESEARCH CANDIDATE — T+1 lag]
F&O (stock_futures_oi_history, fno_rollover, so_option_chain, index_max_pain)
   └─→ positioning confirmation                        [LOW-DATA (14 dates); index panel deeper]
Institutional (insider_trades, block_deals, MF holdings)
   └─→ confluence input only                           [graded weak standalone]
News/events (news_sentiment_items, announcement_intel, earnings calendar)
   ├─→ f_news_sent conditioning on movers (lift ~0.13, n=114, p=0.037)   [lead, not result]
   └─→ event-aware risk filter (avoid pre-results entries)
Screeners (1,672 master; 12.25M live appearances → 9.2M outcomes)
   └─→ candidate generator + predictiveness laboratory  [§10; screener_momentum aggregate no longer USABLE]
Engines (technical/ml/dl/confluence/cs/smart_money) → unified_score
   └─ graded: confluence carries the ranker; ml ≈ +0.02; dl paused 0.0; screener/cs/smart_money 0.0 all regimes
Outcomes (signal_outcomes, signal_excursions, unified_signal_outcomes)
   └─→ factor_edge_history / feature_importance_log → weights → regime_edge_status (to be built)
```

**Quantified chain (the "NIFTY bullish → …" cascade):** regime (BULL) → weights re-blend → sector rotation tilt → stock RS percentile → confluence cross-evidence → delivery/OI confirmation → sized position (coverage multiplier) → outcome recorded → per-regime edge table updated. Every arrow exists as a table; the missing quantified links are **sector→stock RS**, **delivery→swing returns**, and **per-regime edge** — Experiments 3/4/5 in §J.

---

## 7. Feature Engineering Blueprint (Phase 6)

The platform already has a feature layer (`feature_store`, 2,426 symbols; `technical_signals` ~100 columns; `feature_engineering.py` merges fundamental/analyst/earnings/flow/delivery/option/market-context families). The blueprint below **names what exists, what to add, and each feature's graded status**. Conventions are the panel spec (§17): per-date cross-sections, winsorised, `is_suspect = 0`, ≥₹1 cr ADT liquidity floor, next-day OPEN entry, Asia/Kolkata day cuts.

| Family | Features (existing → candidate) | Source tables | Graded status |
|---|---|---|---|
| Price/returns | ret_1d/5d/21d, gap, dist-from-VWAP, dist-from-MA | `feature_store`, `technical_signals` | ret_5d @5d: **inverted, real** (−0.051); momentum horizons dead |
| Momentum/RS | rsi_14, adx, macd; **sector-relative RS (add)**, index-relative RS (exists as `f_rs_vs_nifty` in mover features) | `feature_store`, `technical_signals` | rsi_14 @5d −0.038 (mean-reversion); adx ≈ 0; RS-vs-NIFTY lift 2.05 on breakout movers (n=114) |
| Volume/delivery | rel-volume, volume shocker; **delivery-% surprise z-score (add)**, delivery-price divergence (add) | `stock_delivery_data`, `stock_delivery_volume`, movers | calc_volume_shocker = 9,994 events; delivery ungraded — Experiment 4 |
| Breakout | 20d/52w breakout flags, range compression | `technical_signals`, movers | breakout_probability reading **retracted** (power); re-test with open-entry + independent-obs rule |
| Mean reversion | rsi_14, bb_pct, ret_5d inverted arms; `mean_reversion_14` | `feature_store` | **The platform's best-powered edge** (275 indep. obs @5d) |
| F&O | OI change, buildup labels, basis, rollover %, PCR, max-pain distance | `stock_futures_oi_history`, `fno_rollover`, `nt_index_*`, `so_option_chain` | LOW-DATA (14 dates); index PCR deep but ungraded — Experiment 6 |
| Fundamentals | ROE (use `investsights_fundamentals_history.return_on_equity`), growth, margins, PIT valuation percentiles (PE/PB history) | `fundamentals_history`, `dalalos_*`, `trendlyne_pe/pb_history` | `value_book_to_price` t=1.99 NS; PIT discipline verified |
| Earnings/analyst | surprise flags, **revision trio** | `eps_surprise_history`, `analyst_estimates_history` | Ungraded; calendar-blocked to ~2026-10 |
| Institutional | insider net flow, block-deal imbalance, MF ownership delta | `insider_trades`, `block_deals` | insider_net NS — keep as confluence input only |
| News/events | sentiment score/count, freshness, event class | `news_sentiment_items`, `investsights_announcement_intel` | f_news_sent lift 0.13 (lead); 15-y panel enables proper event studies |
| Regime/market | regime label, breadth, VIX-family, index PCR | `market_regimes`, `market_breadth`, `nt_index_pcr_ts` | Filter features — validate per-regime edge (Experiment 5) |
| Screener-derived | appearance counts (live + EOD), cluster memberships (§10), screener_momentum aggregate | `live_screener_*`, `screener_*` | Aggregate no longer USABLE; **appearance-count features ungraded** — Experiment 2 |

**Dangerous features (do not use without controls):** anything merged without point-in-time discipline (vendor restatements); pre-rebuild `feature_store` rows; `win_probability` as a feature (engine output, isotonic-banded); revised fundamentals as-of period date; screener *labels* (they embed vendor universe changes — the 08-29 reclassification broke the panel); `target_*` columns as inputs (labels!). `fcf_yield` (never written) is schema debris.

---

## 8. Target Variables by Horizon (Phases 7–8)

Existing infrastructure: `feature_store.target_ret_5d`; `signal_outcomes` (terminal_pct2 + path_barrier conventions with MFE/MAE via `signal_excursions`); `unified_recommendations` horizons graded at 1d/5d/10d/21d by `factor_edge.py`.

| Horizon | Target (define once, store once) | Entry convention | Status |
|---|---|---|---|
| Intraday (5–60 min, EOD) | forward bar return from signal ts; MFE/MAE to 15:30; | signal-timestamp price (intraday bars) | **DATA NOT AVAILABLE as a graded target yet** — intraday outcome grading is the #1 build (§22) |
| 1–5 days | `fwd_ret_1d/3d/5d` (open→open), quintile + sign labels | next open | Standard; `factor_edge.py` @5d is the house convention |
| 10–20 days | `fwd_ret_10d/20d` | next open | Graded columns exist (10d/21d) |
| 1–3 months | `fwd_ret_63d` | next open | Sparse (power hungry — 63d needs years) |
| 6–12 months | `fwd_ret_126d/252d` | next open | LOW POWER — only `dalalos_*`-style deep panels support honest tests |
| Classification | Strong-Up/Mod-Up/Neutral/Mod-Down/Strong-Down (cost-aware bands: ±2% @5d ≈ round-trip cost) | — | Cost-aware label switch already shipped (ensemble label); bands must clear costs |
| Event labels | ±2/3/5% within h days, first-touch (path_barrier) | next open | Exists in `signal_outcomes.path_barrier`; label-definition discipline mandatory |

Rule (already learned here the hard way): **risk-adjusted, cost-aware targets only** — `win_probability`'s 83.4%-turnover failure is the canonical warning; and a ±2% terminal-barrier label vs a path-barrier label differ by ~2× in measured win rate on identical signals.

---

## 9. Strategy Research — what the platform has actually proven (Phases 9, 35)

This is the report's core table. Every row is a *measured* verdict from `measurement.md` / `factor_edge_history` / `factor_backtest.py` — not folklore. (IC = rank IC, cross-sectional, open-entry unless noted; "indep obs" = dates/horizon.)

| Strategy family | Verdict | Evidence (date) |
|---|---|---|
| **5d mean reversion** (oversold/band-low, `rsi_14`/`bb_pct`/`ret_5d` inverted) | **REAL EDGE — best-powered positive result** | IC −0.038…−0.051 @5d, AUC 0.481–0.488, 1,376–1,415 dates (≈275 indep obs); survived feature_store rebuild re-run on raw columns (09-10) |
| **Cross-evidence confluence** (engine score) | **RESEARCH CANDIDATE → growing lead** | IC +0.084 @5d / +0.113 @10d / +0.168 @21d, AUC to 0.583; LOW-DATA (18/13/2 dates); highest REGIME_WEIGHT (0.30–0.378); clean panel ~09-26/29 |
| Momentum (21d/63d, 12-1) | **DEAD / NS** | t = −3.96 (21d/63d reversal-negative); 12-1 net +0.686%/period, t=1.45, bit-identical ×3 runs |
| Value (book/price) | NS | +0.78%/mo, t=1.99; vendor history restrospectively restated |
| Insider net | NS | +0.29%/period, t=1.73 (superseded the non-reproducing t=2.05) |
| `smart_money_score` | NO EDGE | +0.004 @1d / −0.016 @5d, 18 usable dates |
| Vendor technical score columns (10 × `ext_*`) | NO EDGE at 1d/5d | best: ext_t80_tech_score +0.185/0.574 @21d on 17 dates — a *lead*, re-check >20 dates |
| `ccc_trend` | NO EDGE (mildly inverted, well-powered) | −0.006/−0.035/−0.042 @1/5/21d, 64/60/44 dates |
| `screener_momentum_score` | NO LONGER USABLE | +0.172 @21d fell below AUC bar on re-grade; post-08-29 reclassification panel calendar-blocked (~late Sept re-run) |
| `breakout_probability`, `ml_breakout_probability` | RETRACTED | +0.153/+0.082 readings failed the corrected independent-obs count |
| Win-probability engine | Real IC, **failed at 83.4% turnover** | cost-aware lesson — IC ≠ money |
| Capitulation triple (factor_backtest, cost-aware, disjoint periods) | **SIGNIFICANT — t=+3.48, p=0.0005** | the one surviving factor_backtest positive; rows unaffected by the power fix |
| DL (BiLSTM) | **UNGRADED** | all pre-09-10 AUCs inflated (fold leakage); purged-CV fix shipped; first honest number pending `dl-retrain-weekly`; weight paused 0.0 (user decision 09-13) |
| Mover-conditioning (intraday) | **LEADS WORTH TESTING** | f_mom_5d on intraday breakouts: 9.67 stat / IC-class 0.096, n=114; f_news_sent IC-class 0.130 (p=0.037); f_rs_vs_nifty lift 2.05; engine top-20 hit-rate on next-day movers only 0.4–1.6% → the gap is the opportunity |

**Honest overall read:** the EOD cross-sectional stock-selection edge on this universe is small (IC ~0.05 at best, cost-fragile); the *statistically strongest* family is short-horizon mean reversion plus the capitulation pattern; and the differentiated opportunity is intraday, where the platform has unique event data and where grading infrastructure, not ideas, is missing.

---

## 10. Screeners: candidate generators, not truth (Phase 20)

Assets: `screener_master` 1,672 (Trendlyne 1,006 / ETnow 438 / MC 133 / et_marketstats 95) · live capture: `niftytrader_live_screener_snapshots` 3.63M rows, `live_screener_appearances` 12.25M, `live_screener_outcomes` 9.2M, `live_screener_ml_scores` 888K · EOD: `screener_appearances` 1.26M, `screener_membership_snapshot` 1.14M, `screener_performance_history` 48K, `trendlyne_screener_stocks` 178K.

What the graded record says: the *aggregate* screener momentum score no longer clears the bar; individual vendor screeners overlap heavily (three vendors' "momentum" screens correlate by construction); and vendor reclassifications (08-29) contaminate panels spanning the change.

What to do (concrete, building on existing tables):
1. **Cluster, don't consume**: group the 1,672 screeners into factor-ish clusters by membership overlap (Jaccard on `screener_membership_snapshot` / appearances) — expected clusters: momentum/trend, breakout, value, quality, delivery/accumulation, event. This is Experiment 2 (§J).
2. **Use the 9.2M-outcome laboratory**: per-cluster forward-return lift and per-screener precision@k from `live_screener_outcomes` — this is a *completed* dataset nobody has to backfill.
3. **Consensus beats count**: membership in ≥K independent clusters is the testable "multi-screener event" (Phase 21); independence must be verified via cluster-overlap, not vendor labels.
4. **Never pool across the 08-29 reclassification**; grade post-change dates only (~20 dates exist by late Sept).

---

## 11. Signal-Combination Analysis (Phases 10, 21, 33)

**Already-measured combination facts:**
- `confluence_score` *is* the combination engine — and it is the only engine whose graded IC grows with horizon (5d +0.084 → 21d +0.168). Cross-domain convergence therefore already carries the ranker; the task is to make its inputs independent and auditable, not to add another blender.
- Independence audit: `ext_mojo_quality_rank` ≡ `ext_t80_quality_rank` (corr 1.0) — combining "both vendors" double-counts one column. Any consensus scheme must deduplicate by measured correlation first.
- Isotonic calibration banding is *correct* behaviour: breaking ties inside a calibrated band to restore raw ordering costs 23% of the 5d IC to buy +0.007 at 21d. Do not "fix" collapsed bands.

**Candidate stacks (pre-registered, to be graded — none is proven):**
1. `L1 mean-reversion arm` + `L2 delivery-accumulation` + `L3 regime not-HIGH_VOL` → swing engine (tests whether delivery confirms the platform's one real edge).
2. `Intraday breakout mover` + `f_mom_5d lift` + `positive f_news_sent` + `index PCR not-stressed` → intraday long (mover-study leads, n≥114 per cell needed).
3. `Screener-cluster consensus ≥2` + `live-screener appearance surge vs own 20d baseline` + `L1 not-overbought` → intraday radar.
4. `Analyst revision-up trio` + `5d mean-reversion arm` → "dip in an improving fundamental" (calendar-gated to ~2026-10 for the trio's 20 dates).
5. `F&O long-buildup + price-up` (the classic) → **LOW-DATA**: 14 graded-area dates; queue behind data accumulation, not ahead of it.

**Multiple-testing discipline (mandatory, from AF-20260912-15):** any combination search must (a) pre-register the list before running, (b) report `eff_dates/h` independent observations, (c) hold out a date block, (d) apply the platform bar (|IC| ≥ 0.03 *and* AUC ≥ 0.55 *and* ≥20 indep obs), (e) survive parameter perturbation. Bonferroni-aware reporting exists in the harness's 23-column sweeps — keep it.

---

## 12. ML Architecture (Phases 11–12, 29)

**What exists and is honest today:**
- **Active ensemble**: GradientBoosting-based ensemble, CV 0.5277, test ROC-AUC 0.5422, n=281,476 (model_registry id=322, trained 09-10). Post-label-switch champion trend mildly *down* as training grows (0.5348→0.5277) — that is an honest label regressing toward its true value, not degradation. 0.52–0.55 is the realistic ceiling on this problem; any engine reporting far above it was leaking (the DL lesson).
- **cs_ranker**: pairwise GradientBoosting regressor, champion + rejected challengers; promotion gates live in `model_registry` (`is_active` 0/1 bigint). Caution recorded: its stored `cv_roc_auc` column holds an error-style metric (>1 values) — do not compare across model types.
- **DL BiLSTM**: paused at 0.0 weight in all regimes (user decision, AF-20260913-05) until inputs rebuilt + honest retrain. Served probabilities were saturating (40% of `prob_up_5d` < 0.01 or > 0.99 on v5).
- **Isotonic calibration** on `win_probability` — keep; banding collapse is correct (§11).
- **Feature importance** persisted (`feature_importance_log` 510 rows).

**Recommendation by horizon (aligned to what the data can support):**
- EOD 1–21d: keep gradient-boosted cross-sectional model as primary; **prefer ranking formulation (pairwise/lambdarank) over raw-return regression** — the cs_ranker precedent — because cross-sectional IC is the graded objective. Features: §7 families minus dangerous list. Re-fit cadence weekly (exists).
- Swing/positional: factor-model style — the 5d mean-reversion arm + capitulation triple + (once ≥20 dates) revision trio; simple regularized linear (Ridge) as challenger to GB; prefer interpretability at long horizons.
- Intraday: gradient boosting on event-conditioned features (mover + live-screener + confluence context) **once outcome grading exists** (§22); until then no intraday ML claim is possible.
- DL/sequence models: only after one honest walk-forward number exists; promote solely on realized `factor_edge_history`, never on self-reported CV (standing rule).

**Champion/challenger:** already implemented in `model_registry`. Keep the rule "challenger promotes only on predefined validation criteria + realized-grade confirmation".

---

## 13. Market-Regime Engine (Phase 13)

Exists: `REGIME_WEIGHTS` over BULL / BEAR / HIGH_VOL / CRASH / SIDEWAYS; current live state: screener, cs, smart_money all 0.0 in **all five** regimes; dl paused 0.0 (09-13); confluence highest (0.30–0.378); `market_regimes` 707 rows + `intraday_regime_history` 933; dispersion checks per engine per regime (`ZERO_DISPERSION_MIN_SD_BY_ENGINE`).

Gaps and builds:
1. **`regime_edge_status` is never written (0 rows)** — the per-regime, per-strategy performance table Phase 13 wants does not exist yet. Build: nightly job writing per-engine/per-strategy IC, hit-rate and return by regime from `signal_outcomes` into `regime_edge_status`; alert when a production strategy's edge is regime-concentrated.
2. Regime *inputs* to extend (all present in DB): index PCR trend, breadth slope, VIX-family, FII/DII merges, macro (currency/yields) — as filters only until graded.
3. Validate the folkloric mappings ("trend following works in trends; mean reversion in ranges") on this data: the 5d mean-reversion edge should be tested per regime first — it is the platform's best-powered family and its regime-dependence is currently unmeasured (Experiment 5).

---

## 14. Stock Ranking System (Phases 14, 37, 38)

Existing: `unified_ranker.py` (EOD, positional/cross-source) → `unified_recommendations` (per-symbol: unified_score, engine scores, class, reasons, computed_at, dl/ml/technical/confluence); `intraday_ranker.py` → `intraday_recommendations` (+ history cycles); `stock_factor_breakdown(_history)` for explainability; `recommendation_log` 65,181 rows for audit.

Recommended ranking method per horizon (formulation matters more than model choice):

| Horizon | Formulation | Universe / eligibility | Ranking output |
|---|---|---|---|
| Intraday long/short | probability of ±x% first-touch within window, **plus rank** | ≥₹5 cr ADT intraday, price > ₹20, no circuit/halt flags, data-quality gates pass | Top-N long + Top-N short with entry zone/stop from ATR |
| 1–3d / 1–5d | cross-sectional rank (learning-to-rank or quantile model) | ₹1 cr ADT floor (house rule) | Top-50 + top-decile short |
| Swing 10–20d | rank on the mean-reversion arm + trend filter + delivery confirm | ₹5 cr ADT, no earnings inside 3 days unless the strategy is event-based | Top-30 |
| Positional 1–3m | factor blend (value+quality+revision, once powered) | ₹10 cr ADT, liquidity + PIT-fundamental availability | Top-25 |
| Long-term 6–12m | factor screen, not ML (power limits) | deep-history names only (`dalalos_*`, PIT fundamentals) | Ranked watchlist, quarterly refresh |

Eligibility filters already exist partially (`is_suspect`, ADT floors in the harness). Make them explicit, per-strategy, and stored (Phase 38): liquidity, turnover, spread proxy (H-L range/close), history length, corporate-action-in-window, data-quality flags, event blackout.

Every emitted row should carry: symbol, price, direction, horizon, probability (calibrated), confidence, expected move, risk (ATR/σ), entry zone, stop, target, R:R, reason codes, supporting + contradictory factors, regime, sector regime, F&O context, news context, fundamental context, timestamps, model/feature versions — most of these columns already exist in `unified_recommendations`/`recommendation_log`; the gaps are **calibrated probability in the ranking output**, **contradictory-factors**, and **model_version/feature_version stamps on the served row**.

---

## 15. Signal Confidence & Calibration (Phase 15)

Rules this platform has already proven:
1. **Never equate score with probability.** `unified_score` 80/100 ≠ 80%.
2. **Calibrate where a probability is claimed.** `calibrated_win_probability` (isotonic) exists; its banding collapse is intended behaviour; do not restore raw ordering inside bands (costs 23% of 5d IC).
3. **Report the historical calibration table next to every probability**: bucket → realized hit-rate + n + independent-observation count. The infrastructure for this exists (`factor_edge_history` + `signal_outcomes`); the missing piece is emitting it with the served signal.
4. **Distinguish four numbers**: signal strength (rank), probability (calibrated), expected return (cost-adjusted), expected risk (ATR/σ, MAE distribution from `signal_excursions`).
5. **Minimum-n discipline:** no probability is shown when independent observations < 20 — display "LOW-DATA" instead (house standard).

---

## 16. Risk Engine (Phase 16)

What exists: `size_confidence_multiplier(strength, coverage)` with **`FULL_ENGINE_COVERAGE` derived from `REGIME_WEIGHTS`** (not hard-coded) — covered by `test_engine_coverage_denominator.py`; ATR available; stops/targets implicit in intraday recommendations.

Recommendations (India-specific, cost-aware):
1. **Position size ∝ risk budget / (ATR × price)** with per-name cap and sector cap; the coverage multiplier stays as a confidence shrink on top.
2. **Cost model must be explicit in every backtest and in the served R:R**: brokerage, STT (delivery vs intraday differ), exchange charge, GST, stamp duty, SEBI fee, plus slippage and bid-ask spread. Turnover is the killer (83.4% turnover killed a real-IC signal) — prefer fewer, larger-edge trades at EOD horizons.
3. **Exits**: ATR-based stop, time stop equal to the strategy's target horizon (a 5d signal must expire at 5d), trailing stop for swing, invalidation condition (regime flip, contrary event) — all persisted in the signal row so outcomes can grade them.
4. **Portfolio-level**: sector exposure cap, correlation cap (correlation infra exists: `sector_correlation_stats`, `signal_portfolio_correlation` — the latter is empty and should be populated), max concurrent signals per regime.
5. **Intraday realism**: entry latency, data latency (the audit's "retrospectively complete bars ≠ signal-time availability"), liquidity cap (≤x% of recent volume), no market orders on illiquid names.

---

## 17. Backtesting Framework (Phases 17–18, 36)

**Existing harness (use it, don't rebuild):** `factor_edge.py` (IC/AUC grader with `eff_dates`, `DEGENERATE-XS`, entry open/close modes, Asia/Kolkata day cuts), `factor_backtest.py` (portfolio hold-to-rebalance → **disjoint periods**, cost/turnover aware — the source of the only statistically significant positive: capitulation triple t=+3.48, p=0.0005), `assembly_ablation.py`, `feature_importance_log`, `backtesting_runs` (1,390).

**Non-negotiable panel spec (already established here):**
- Per-date cross-sections, then average — **never pool** (pooling inflated a conclusion three times; a pooled +0.798% became per-date +0.098%, t=1.22).
- Winsorise; filter `is_suspect = 1`; liquidity floor ≥₹1 cr ADT.
- Next-day **OPEN** entry; close-to-close IC is an upper bound (h=1 overstated by >2×: +0.045→+0.021).
- Independent observations = dates/horizon; the reliability floor applies to *that*, not the raw date count.
- Costs: full Indian cost stack + slippage (§16).
- Regime-split every result; report per-regime, per-sector, per-cap, per-volatility bucket.
- Any combination search: pre-registration + held-out date block + parameter perturbation + Bonferroni awareness.

**Targets to instantiate** (§8): intraday first-touch labels (missing); 1/3/5/10/20d open→open (exists); 63/126/252d (power-limited).

---

## 18. Real-Time Signal Engine (Phase 22) — architecture, from what is already running

Current live architecture (verified in the 09-17/18 audit and this session): providers → TS services + 81 Python fetchers → Postgres; BullMQ/Redis schedules (`queues.ts`, `jobs/*.jobs.ts`); pm2 supervision + nightly backup; `pythonRunner.ts` **5-process cap** with a heavy-job lock (no aggregate RAM budget — documented); `feature_engineering.py` → `feature_store`; engines → `unified_ranker.py` (EOD, 45-min budget + bounded make-up run) and `intraday_ranker.py` (15-min cycles); Telegram digests + tRPC + Grafana.

Target state (incremental, not a rewrite):
```text
Providers/registry (3,408) → Ingestion (watermarks per symbol/field)
  → Validation (schema + DQ gates + completeness counts: eligible/attempted/validated/committed)
  → Feature engine (incremental per-date recompute; single writer per feature table)
  → Engines (technical / F&O / news / sector / confluence) → Regime filter
  → ML inference (batch for EOD; event-driven for intraday)
  → Fusion + calibration → Risk/eligibility filter → Ranking
  → Signal store (lifecycle columns + model/feature versions) → Alerts (tiered, deduped)
  → Outcome tracker → factor_edge/factor_backtest → weights → regime_edge_status
```
Operational requirements to add, ranked by the failures actually observed: **per-symbol completeness watermarks + declared completion waits** (fixes the "feature refresh predates arrivals" P1); **connection-pool / cross-queue resource ceiling** (the 09-17 cascade: 3,863 connect timeouts, 545 in one hour, four jobs killed at the same second); **one writer per feature table** (inline-DDL/PK drift class); **alert dedup keyed on (symbol, strategy, day)**; retry with backoff on fetchers; feature/model version stamps on every served signal.

---

## 19. Data Refresh Priority Matrix (Phase 23)

| Tier | Data | Cadence (current → recommended) | Why |
|---|---|---|---|
| T0 near-real-time (market hours) | index quotes, intraday bars, live screeners (45 slots), index PCR/OI, breadth | 15 min (current) → keep; add completeness gate before ranking | Intraday engine consumes these |
| T1 every few minutes (market hours) | intraday features, relative volume, intraday rankings, mover events | 15-min cycles exist; ensure the *first* cycle lands pre-09:30 (P1 gap: first retained cycle was 10:56 IST on 09-16) | Opening decisions |
| T2 event-driven | news, announcements, corporate actions/calendar, earnings | as-arrives; SLA measurement missing | Event detectors + risk blackout |
| T3 daily post-close | EOD OHLCV, delivery (T+1), F&O OI/rollover, technical_signals, feature_store rebuild, engines, ranker | sequenced after arrivals; atomic publish, not equal-cadence | Removes the "snapshot predates inputs" defect |
| T4 daily/periodic | fundamentals, analyst estimates, institutional deals, screeners, DVM | daily/weekly convergence (PK upsert) | Swing+ |
| T5 quarterly/monthly | results, shareholding, MF holdings, credit events | quarterly convergence with 80–90d markers | LT factors |

---

## 20. Event Detection & Anomaly Detection (Phases 24–25, 43–44)

**Event infrastructure that exists:** `mover_snapshots` (calc_gap_up/down, calc_intraday_breakout, calc_open_eq_high/low, calc_volume_shocker + vendor classes; 218,948 events / 83 classes studied), `stock_event_triggers` 64,342, `live_screener_appearances` 12.25M, `news_sentiment_items` (15 y), `corporate_actions` (to 1994), `credit_rating_events`, `insider_trades`, `block_deals`.

Bullish detectors: breakout with volume ≥2σ of own 20-day log-volume + regime not-HIGH_VOL; volume explosion; delivery-% spike (T+1); long buildup with price up; positive earnings/announcement surprise; screener-cluster surge vs own baseline; RS breakout vs sector.
Bearish detectors: breakdown with volume; volume expansion on a down day; short buildup; long unwinding; negative announcement; sector/market regime deterioration; delivery spike with falling price (distribution).

**Anomaly detection (unsupervised, runs before direction is assigned):** unusual volume, unusual price move vs own vol, unusual OI change, unusual delivery, unusual news volume, and four divergences (price-vs-fundamentals, price-vs-OI, stock-vs-sector, index-vs-constituent). Implementation: per-symbol robust z-scores (median/MAD) with a **minimum-history gate** — a z-score on 14 days of OI history is a data artifact, not an anomaly (`stock_futures_oi_history` is 14 dates old). Anomalies enter the radar as "something unusual is happening" with *no direction*; directional engines attach afterwards.

**Alert tiers (Phase 43) must be earned, not asserted.** CRITICAL = ≥3 independent domains converging + regime supportive + liquidity passing AND historically graded; HIGH = 2 independent domains; MEDIUM = one strong detector; LOW = informational single weak channel. Per-tier precision is derived from `signal_outcomes`; today only the EOD tier is measurable.

**Deduplication (Phase 44):** consolidation key = (symbol, day, direction, strategy-family); all supporting evidence (screeners, incidents, detectors) stored as JSON on the one signal row. Precedent: 1,672 screeners → ~6 clusters → ≤3 independent confirmations → 1 alert.

---

## 21. Signal Lifecycle & Continuous Learning (Phases 26–27)

**Already built:** `signal_outcomes` (1.03M rows; `label_definition` = `terminal_pct2` / `path_barrier`), `unified_signal_outcomes` (336K), `signal_excursions` (395K, MFE/MAE), `recommendation_log` (65K), `model_registry` (177, champion/challenger, `is_active` bigint), `factor_edge_history` (1,571), `feature_importance_log` (510), `backtesting_runs` (1,390), `job_run_history`/`job_heartbeat`, `data_quality_results`.

**Missing / to complete:**
1. **A single queryable signal surface** — today split across `unified_recommendations`, `unified_signals` (134K), `intraday_recommendations`, `confluence_signals`. Add a `signal_registry` **view** (not a new table) unioning them with `signal_id`, `strategy_id`, `model_version`, `feature_version`, `data_snapshot_reference`, entry/stop/target, joined to outcomes.
2. **Intraday outcome grading** — the largest instrumentation hole on the platform (§22).
3. **Per-regime edge table** (`regime_edge_status` is empty), written nightly from the registry view.
4. **Retraining with promotion gates** — weekly retrain exists; challenger promotes only if (a) honest purged-CV ≥ champion and (b) realized `factor_edge_history` IC ≥ champion on ≥20 independent observations from eligible dates. Never auto-deploy.
5. **Drift monitoring** — dispersion checks exist per engine; add PSI/KS on top features + a distribution-shift alert (the 08-29 screener reclassification is the cautionary precedent).

---

## 22. Strategy Registry (Phase 28) & Research/Production Separation (Phase 45)

`backtest_strategies` is **empty** and `strategy_performance` holds only 262 rows — the formal registry does not exist yet. Build it as tables + views with the lifecycle states requested (`RESEARCH → BACKTESTING → VALIDATION → PAPER → PRODUCTION → DEPRECATED`) and the full per-strategy schema (id, name, description, regime applicability, horizon, entry/exit rules, features used, data dependencies, parameters, backtest and OOS results, expected risk, known failure modes, version, status, owner).

Research/production separation: the platform already has the two harnesses and a de-facto paper trail. Formalize:
- **RESEARCH** — `factor_edge.py`/`factor_backtest.py` runs writing only to `factor_edge_history`.
- **PAPER** — signals written with `strategy_status='PAPER'`, graded by outcomes, **not alerted**.
- **PRODUCTION** — alerting + serving, promoted only by the §21.4 gate (honest CV *and* realized grade, ≥20 independent observations).

This is the single cheapest safety improvement available, because the platform's own history shows strategies that looked good on a thin panel collapsing at full power (`breakout_probability`, `ml_breakout_probability`, `screener_momentum_score`).

---

## 23. Explainability (Phase 30)

Existing: reason codes in `unified_recommendations`, `stock_factor_breakdown(_history)` (424K rows), `feature_importance_log`, digests. Enforce this served structure for every signal:

```text
Signal: BULLISH (5d)   probability 0.71 (calibrated; bucket 0.70-0.75 realized 68%, n=412, 31 indep periods)
Why: 1) top-decile rank on the mean-reversion arm (rsi_14/bb_pct inversion — the platform's best-powered 5d edge)
     2) delivery-% z = +2.1 (accumulation)   3) sector RS improving   4) regime = SIDEWAYS (supportive for reversion)
     5) confluence_score percentile 92
Risks: 1) earnings in 2 days   2) ATR 6% (elevated)   3) breadth deteriorating   4) engine panel LOW-DATA (13 indep periods)
Invalidation: close below entry-day low; regime flips HIGH_VOL; delivery reversal < -1σ
Versions: model 20260910_102154 · feature v2026-09-10 · snapshot feature_store@<date>
```

Never state certainty — use historical probability, expected return, confidence, scenario analysis only (Phase 31). A recommendation without contradictory factors listed is not acceptable output.

---

## 24. Database Architecture Recommendations (Phase 40) — incremental, not a redesign

Keep everything that works (PK-upsert convergence, hypertables, DQ gates). Changes with clear benefit only:

1. **Hypertable/retention**: `feature_store` (25 chunks, 2.68M rows in a 5-day window) is the fast-growing table; it already relies on Timescale retention. Formalize retention + compression policy per hypertable and document it; `tick_data` has **0 chunks** — create the retention/compression policy only when a tick source exists, or drop the dead hypertable.
2. **Partition very large flat tables** by month where access is time-scoped: `marketsmojo_technical_history` (17.3M / 3.63 GB — largest object in the DB), `niftytrader_live_screener_snapshots` (3.63M / 1.73 GB), `live_screener_appearances` (12.25M / 1.65 GB), `live_screener_outcomes` (9.2M / 1.34 GB), `marketsmojo_financials_history` (4.26M / 1.07 GB). Compression (columnar) for vendor grids.
3. **`extra_endpoint_responses`** (38K rows / 472 MB raw JSON): move bodies to object storage or a lowercase compression policy; keep key fields normalized.
4. **JSONB vs normalized**: keep JSONB for raw/vendor payloads; never serve decision features from JSONB; promote any JSONB field that a strategy consumes into a typed column (the `mc_general_metrics`/`stock_factor_breakdown` pattern).
5. **Missing indexes that already caused incidents**: `MAX(timestamp)` probes without indexes caused live-DB contention (AF-20260917-23) — add `(symbol, date DESC)`/`(date DESC)` indexes where freshness sweeps run, and ensure every feature/signal table has the `(date)` and `(symbol, date)` access paths.
6. **Constraint hygiene**: the inline-DDL PK-vs-schema drift class (2 instances in 2 days) argues for a schema-drift check in CI (`npm run schema:drift` already exists) plus a PK-shape test for every new table.
7. **New objects to add (small, high value)**: `signal_registry` view (§21), `regime_edge_status` writer (§13), `strategy_registry` tables (§22), `completeness_watermarks` table (per symbol/field: last acquisition, last validated, expected cadence), `feature_version`/`model_version` columns on served signals.
8. **Timezone/typing cleanup (avoid the two known traps)**: `unified_recommendations.computed_at` is TEXT-date; `job_heartbeat` stores naive-UTC epochs. Do not "fix" these casually — they are load-bearing for existing readers; add typed shadow columns (`computed_at_ts timestamptz`) and migrate readers deliberately.

---

## 25. API / Dashboard / Alerting (Phases 41–42)

**API (extend the existing tRPC surface; the audit found one serving gap on `getTopRatedStocks`):** `GET /market/regime`, `/market/breadth`, `/stocks/rankings?horizon=`, `/stocks/{symbol}/intelligence`, `/signals/live`, `/signals/history`, `/strategies`, `/strategies/{id}/performance`, `/stocks/{symbol}/factors|fno|news|fundamentals`, `/sectors/rankings`, `/alerts`. Add: mandatory `as_of` + freshness + data-quality header on every response, and never serve a stale canonical table silently (last_updated stamp + engine/feature versions).

**Dashboard (decision-first, not data-volume-first):** Market Overview (NIFTY/BankNIFTY/VIX/breadth/rotation/FII-DII) · Intraday Radar (top longs/shorts, breakouts/breakdowns, volume and OI anomalies, screener-cluster surges) · Stock Intelligence (fundamental, technical, F&O, news, ML probability, overall — with LOW-DATA badges) · Strategy Monitor (live signals, realized outcomes, per-regime performance) · Research (backtests, feature importance, regime tables). The platform already has Grafana + a web frontend; the change is *what to show* (probabilities with calibration and n, not scores).

**Alerting:** Telegram exists (digest + rate-limit handling + VITEST guard). Requirements: tiered priority (§20), dedup key (symbol, strategy, day), quiet hours around known Telegram rate limits, and every alert linking to its persisted signal row so outcomes are gradable. Email optional; no alert without a stored signal.

---

## Implementation Roadmap (Phase 45)

Ordered by data dependency; each phase lists deliverables, DB changes, outputs and exit validation.

| # | Phase | What to build | DB changes | Exit validation |
|---|---|---|---|---|
| 1 | **Data Audit** (mostly DONE) | This report + `quant_inventory.json` + registry taxonomy; keep the weekly freshness sweep | none (read-only) | inventory reproducible from probes; every claim traceable |
| 2 | **Data Normalization** | Per-symbol completeness watermarks; declarative availability/completion waits before feature rebuild; typed shadow columns for TEXT/epoch traps; deprecate the dead-table list | `completeness_watermarks`; `computed_at_ts` shadow; drop/retire dead tables; partition the 5 oversized flat tables | a feature rebuild provably cannot run before its declared inputs land (audit P1 closed) |
| 3 | **Feature Engineering** | Freeze feature versioning; add the §7 candidates (delivery surprise, sector RS, revision trio joins, screener-cluster membership counts); store per-date feature snapshots for point-in-time replay | `feature_store` version column + retention; `feature_version` registry | point-in-time replay of any past signal reproduces its features |
| 4 | **Backtesting** | Run §J experiments through `factor_edge.py`/`factor_backtest.py` with the panel spec; persist everything to `factor_edge_history` | none new | each experiment reported with eff-dates, IC+AUC, costs, per-regime split |
| 5 | **Strategy Engine** | Strategy registry tables + paper mode; explicit eligibility filters; signal_registry view; per-regime edge writer | `strategy_registry`, `strategy_runs`, populate `regime_edge_status`, `signal_registry` view | a strategy can move RESEARCH→PAPER with no code change |
| 6 | **ML Models** | Weekly retrains continue; challenger gate formalized; drop/replace leak-prone features; ranking (LTR) challenger for EOD; DL only after first honest grade | `model_registry` versioning (exists); feature_version stamp | challenger promotion reproducible from stored metrics |
| 7 | **Signal Fusion** | Calibrated-probability output on the served row + calibration table in the API; independence audit before any consensus weighting; horizon-specific blends | `unified_recommendations` + probability/version columns; `calibration_buckets` materialization | every served probability carries n + independent periods |
| 8 | **Real-Time Engine** | Connection-pool/cross-queue ceiling; first-cycle timing fix (pre-09:30 intraday cycle); incremental features; event-driven news/announcement path | indexes for freshness sweeps; DQ additions | first intraday cycle lands before session open; zero connect-timeout cascades in 5 sessions |
| 9 | **Dashboard** | Decision-first views (§25) with LOW-DATA badges and calibration | none | a user can see probability, n, risk and invalidation for every ranked name |
| 10 | **Paper Trading** | PAPER status on all new strategies; Telemetry graded nightly by `signal_outcomes` | `strategy_status` column; outcome grading for intraday | ≥20 independent observations per candidate before any promotion review |
| 11 | **Production** | Promote only graded strategies; tiered alerting with dedup; API freshness headers | `signal_actions`, `price_alerts` (currently empty) become real or are dropped | every alert links to a persisted, gradable signal |

**Critical-path note:** phases 2 and 10 are the ones that unblock everything else — completeness/ordering (2) is what makes features trustworthy, and intraday outcome grading (10) is what makes any intraday claim testable. Feature work (3) without (10) produces unusable factors; this is exactly the trap `measurement.md` documents.

---

# FINAL OUTPUT SECTIONS

## A. WHAT WE HAVE

A 27.3 GB Timescale Postgres (`bharat_intel` @ :5433) with 234 public tables and 6 hypertables covering: 5.7 y of daily OHLCV (2.69M rows / 2,428 symbols) and intraday bars; ~100-column daily technical signals (2,281 symbols, since 2024-06); a 2.68M-row rolling feature store; 15 y of news sentiment (106.8K items); corporate actions to 1994; fundamentals (PIT-verified) incl. deep `dalalos_*` history to 2005; analyst estimates + the revision trio (live since 09-08); delivery data (734K rows, 2,976 symbols, 15 months); insider trades (80K); block deals; F&O (option chains 569K, index PCR/OI time series 212K, futures OI 4.9K, rollover 10.6K, max pain); breadth and regime tables; 1,672 screeners with 12.25M live appearances and 9.2M tracked outcomes; EOD + intraday rankers (1.6M intraday cycles); 1.03M outcome rows with MFE/MAE; 177-model registry with champion/challenger; a 3,408-endpoint discovery registry + 834 URL templates + 3,103 raw URLs; and a measurement harness (`factor_edge.py`, `factor_backtest.py`, `factor_edge_history` 1,571 readings) plus DQ gates and job history.

**What it does not have (honest gaps):** a tick/order-book feed (`tick_data` empty — DATA NOT AVAILABLE); intraday outcome grading; a per-regime edge table (`regime_edge_status` empty); a strategy registry (`backtest_strategies` empty); completeness watermarks; power on most proposed factors (only 46 of 895 readings had ≥20 independent periods); an honest DL number; full survivorship control.

## B. WHAT ACTUALLY MATTERS (demonstrated incremental value)

1. **5d mean reversion** (feature_store's inverted RSI/BB/5d-return) — the only well-powered positive (≈275 independent 5d observations; survived the raw-rebuild re-test).
2. **Capitulation pattern** — cost-aware, disjoint-period significance (t=+3.48, p=0.0005).
3. **Cross-evidence confluence** — the ranker-carrying engine (+0.084@5d → +0.168@21d, LOW-DATA but the only engine improving with horizon).
4. **Mover-conditioning features** — `f_mom_5d` and `f_news_sent` show lift on intraday breakout/gap classes (n≈114, p≈0.04) — the best available leads for intraday.
5. **Live-screener appearance dynamics + 9.2M tracked outcomes** — unique, pre-collected, and the only path to measuring intraday screener value.
6. **Delivery data** (T+1 accumulation) — untested but structurally distinct from every vendor score; cheapest untested hypothesis with real upside.
7. **Regime state** — as a *filter* interacting with the mean-reversion edge, currently unmeasured.

## C. WHAT SHOULD BE REMOVED OR DOWNWEIGHTED

- **Dead tables/feeds** (zero rows or documented retirement): `bulk_deals`, `tick_data` (until a feed exists), `screener_runs`, `technical_scans`, `signal_actions`, `price_alerts` (or make them real), `signal_portfolio_correlation`, `order_book_snapshots`, `timeframe_scores`, `marketsmojo_stock_picks`, `high_flyer_daily_stats`, `finstack_cashflow_history`/`et_cashflow_history` (near-empty), `bulk_block_deals` supersession check.
- **Graded no-edge / duplicate information**: the 10 `ext_*` vendor technical columns at 1d/5d (keep only `ext_t80_tech_score` as a 21d lead under review); one of the two identical quality columns (`ext_mojo_quality_rank` ≡ `ext_t80_quality_rank`); `smart_money_score` (currently 0.0 weight — correct); `ccc_trend` (negative, well-powered); `momentum_21d/63d`; `screener_momentum_score` as a *primary* input (demote to one cluster member).
- **Storage/handling**: `extra_endpoint_responses` raw JSON (472 MB) → archive/compress; `marketsmojo_technical_history` (3.63 GB) compression/partitioning before further growth; `stock_scores` (stale since 09-15, 4,546+5,042 retained rows) — either repair its job or retire the surface (the audit P1 says fresh raw data has not repaired it).
- **Process**: no new vendors (onboarding freeze stands); no "one more indicator" work until intraday grading exists; do not re-litigate closed verdicts (smart_money, ccc_trend, momentum) without stating what changed.

## D. BEST STRATEGY FAMILIES BY HORIZON (research conclusions — no profitability claims)

| Horizon | Best-supported family | What the evidence actually says | Status |
|---|---|---|---|
| **Intraday** | Mover-conditioned events (breakout/gap/volume-shocker) + news-sentiment lift + screener-cluster surge | `f_mom_5d` (9.67 stat / IC-class 0.096, n=114) and `f_news_sent` (0.130, p=0.037) condition intraday breakout/gap events; the EOD ranker's hit-rate on next-day movers is 0.4–1.6% → the edge must be built intraday, not inherited | **RESEARCH CANDIDATE** — needs intraday outcome grading first |
| **1–3 days** | Mean-reversion arm (short horizon) + confluence percentile + regime not-HIGH_VOL | 5d inversion is real but 1d AUC ≈ 0.49 (no edge at 1d) — the family pays at ~5d, so 1–3d is weaker than 3–5d | **RESEARCH CANDIDATE** |
| **3–5 days** | 5d mean reversion (+ capitulation pattern for tails) | The platform's best-powered result (≈275 indep obs; AUC 0.481–0.488 inverted; capitulation t=+3.48 cost-aware) | **BEST-SUPPORTED on the platform** |
| **Swing (10–20d)** | Confluence + sector RS + delivery confirmation | confluence IC rises to +0.113 (10d) / +0.168 (21d) but on 13/2 dates — genuinely LOW-DATA until ~late Sept; sector/delivery untested | **RESEARCH CANDIDATE** |
| **Positional (1–3m)** | Quality/value + revisions (once powered) | `value_book_to_price` t=1.99 NS (restatement risk); revision trio ungraded; deep `dalalos_*` panel is the only honest long-horizon data | **RESEARCH CANDIDATE — calendar-blocked** |
| **Long-term (6–12m)** | Factor screen (quality/growth/valuation) — not ML | power limits make short-window ML claims meaningless; `dalalos_*` (2005+) is the only panel deep enough | **RESEARCH CANDIDATE — power-limited** |

## E. BEST SIGNAL COMBINATIONS (evidence-ranked)

1. **Capitulation triple + mean-reversion arm + regime filter** — the two best-evidenced families are in the same behavioural family (panic/reversal); testable now on a well-powered panel. **Highest expected value.**
2. **Mean-reversion arm + delivery accumulation (T+1)** — tests whether the platform's one real edge is confirmed by the most independent data it owns.
3. **Intraday: mover class + `f_mom_5d` + `f_news_sent` + index-PCR state** — best-available intraday leads, needs n≥114 per cell.
4. **Screener-cluster consensus (≥2 independent clusters) + appearance-surge vs own baseline** — uses 9.2M pre-tracked outcomes; independence must be verified by membership overlap.
5. **Revision-up trio + mean-reversion dip** — the classic "buy the dip in an improving name"; calendar-gated to ~2026-10 (trio needs 20 dates).
6. **F&O long-buildup + price-up + volume** — LOW-DATA (14 dates); queue behind data accumulation.

Everything else (momentum blends, multi-indicator confirmations, vendor-score stacks) has either been graded negative or double-counts correlated inputs.

## F. REAL-TIME SIGNAL FORMULA (exact path from raw data to a served signal)

```text
1. ELIGIBILITY (hard gates, stored per strategy):
   data_completeness=OK AND is_suspect=0 AND ADT >= floor AND history >= min_days
   AND no corporate-action distortion window AND no event blackout (unless event strategy)
2. FEATURES (as-of, point-in-time; feature_version stamped):
   mean_reversion_arm (rsi_14, bb_pct, ret_5d inverted)
   + trend/RS context (adx, sector-relative RS, index-relative RS)
   + volume/delivery (rel-volume z, delivery-% z)
   + F&O context (OI change, basis, rollover) [only where history >= 20 days]
   + news/event (sentiment, freshness, event class)
   + regime (BULL/BEAR/SIDEWAYS/HIGH_VOL/CRASH, breadth, index PCR)
3. SCORE per engine → percentile ranks (never raw sums of correlated inputs)
4. BLEND with REGIME_WEIGHTS (current live weights; zero-weight engines excluded)
5. ML probability where a model is HONESTLY graded (else omit — never fill with a score)
6. CALIBRATION → probability with (n, independent periods) attached; suppress below 20
7. RISK: ATR-based entry zone, stop, target, R:R; size = risk_budget / (ATR*price) * coverage_multiplier
8. FUSION: require >=2 independent domains for HIGH tier, >=3 for CRITICAL; dedupe by (symbol, day, direction, family)
9. PERSIST: signal row with model_version, feature_version, supporting + contradictory factors, snapshot ref
10. GRADE: outcome tracker fills MFE/MAE/realized R → factor_edge_history → regime_edge_status → weights
```

**Hard rule:** steps 5–6 must never fabricate confidence. If a model has no honest grade or the panel is LOW-DATA, the served signal says so explicitly.

## G. RECOMMENDED SYSTEM ARCHITECTURE

```text
3,408 registry endpoints ──► Ingestion workers (watermarked, throttled, per-symbol completeness)
        ▼
Postgres/Timescale (raw → normalized; partitioned + compressed; one writer per table)
        ▼
Validation & DQ (schema drift, PK shape, freshness, quarantine flags, completeness watermarks)
        ▼
Feature layer (versioned, point-in-time snapshots, incremental recompute) ──► feature_store
        ▼
Engines: technical | mean-reversion | F&O | news/event | sector | institutional | screener
        ▼
Regime engine (classification + per-regime edge table)   ◄── regime_edge_status writer
        ▼
ML layer (EOD ranker + calibrated probability; intraday model only after grading exists)
        ▼
Fusion + calibration + eligibility/risk filter + ranking (horizon-specific)
        ▼
signal_registry (view) + recommendation_log + Telegram/API/dashboard (tiered, deduped alerts)
        ▼
Outcome tracker (signal_outcomes / excursions) → factor_edge_history → weights (champion/challenger)
```

This is the requested architecture realized with objects that already exist (raw→feature→engine→regime→rank→outcome) plus four missing pieces: watermarks, intraday grading, per-regime edge, strategy registry.

## H. IMPLEMENTATION PRIORITY (impact × effort × dependency × risk)

| Rank | Work item | Impact | Effort | Data dependency | Risk |
|---|---|---|---|---|---|
| 1 | **Intraday outcome grading** (MFE/MAE/labels for intraday cycles from `intraday_ohlcv`) | Very high — unblocks every intraday claim | Medium | `intraday_ohlcv` exists | Low |
| 2 | **Completeness watermarks + declared completion waits** before feature rebuild/ranking | High — closes the audit's P1 ordering defect | Medium | none | Low |
| 3 | **Run the pre-registered experiments** (§I 1,2,3) through the existing harness | High — converts leads into verdicts | Low–Med | existing panels | Low |
| 4 | **Per-regime edge table** (`regime_edge_status` writer) | High — honest regime gating | Low | `signal_outcomes` | Low |
| 5 | **Calibrated probability + n on served signals** | High trust impact | Low | calibration code exists | Low |
| 6 | **Postgres/queue resource ceiling + first-cycle timing fix** | High operational | Medium | — | Medium (deploy coupling) |
| 7 | **Strategy registry + PAPER mode** | Med–High governance | Medium | — | Low |
| 8 | **Screener clustering + 9.2M-outcome sharpening** | Med–High (unique asset) | Medium | existing | Low |
| 9 | **Storage: partition/compress 5 largest tables; archive raw JSON** | Medium (cost/speed) | Medium | — | Low |
| 10 | **Ranking model (LTR) challenger for EOD** | Medium | Medium | clean panel post-09-26 | Medium |
| 11 | **DL un-pause** | Unknown until graded | High | honest retrain + inputs | Medium |
| 12 | **Long-horizon factor work** | Low now (power-blocked) | High | years of data | — |

## I. TOP 10 RESEARCH EXPERIMENTS (first quantitative work to run)

1. **Re-grade the mean-reversion arm by regime** — `factor_edge.py --table feature_store --entry open`, split by `market_regimes`: does the platform's one real edge depend on regime?
2. **Screener-cluster predictiveness** — Jaccard clustering on `screener_membership_snapshot`/appearances, then per-cluster lift and precision@k from `live_screener_outcomes`; produce the independence matrix.
3. **Capitulation triple × mean-reversion arm** — do the two best-evidenced families overlap or add?
4. **Delivery-accumulation factor** — delivery-% z-score and delivery–price divergence vs 5d/10d forward returns (`stock_delivery_data`, 15 months, 2,976 symbols).
5. **Intraday mover-conditioning** — `f_mom_5d`, `f_news_sent`, `f_rs_vs_nifty` lift per mover class on post-2026-06 data, n≥114 per cell, held-out date block.
6. **Index-PCR / F&O state as a conditioning variable** on the mean-reversion arm (deep PCR panel; stock-F&O panel too young).
7. **`confluence_score` clean-panel re-grade** on post-2026-09-14 dates (dl removed) with ≥20 independent observations + its input-independence matrix.
8. **Sector→stock RS** — does sector RS percentile (RRG/rotation) add incremental IC on top of stock-level RS?
9. **Cost-aware re-run of every survivor** through `factor_backtest.py` (21-day rebalance, 25 bps) — weeding out IC-with-no-money effects.
10. **Duplicate-information census** — pairwise correlation matrix across all candidate factors (`ext_*`, DVM, screener scores, technical_signals, feature_store) → the Phase-19 redundancy table; expectation: a large fraction collapses into a few families.

Protocol for all ten: pre-registered hypothesis, §17 panel spec, results persisted to `factor_edge_history`/`backtesting_runs`, one-line verdict appended to `measurement.md`. Report `eff_dates/h`, never raw date counts.

## J. DETAILED NEXT-ACTION PLAN (dependency order)

1. **Build intraday outcome grading** — job computing forward returns, MFE/MAE and first-touch labels for `intraday_recommendations`/confluence cycles; extend `signal_outcomes.label_definition` with `intraday_first_touch`. *Unblocks Experiments 5 and the whole intraday surface.*
2. **Add completeness watermarks + rebuild ordering** — `completeness_watermarks` table + a feature-rebuild readiness gate; verify by replaying one past date.
3. **Write the `signal_registry` view**; stamp `model_version`/`feature_version` on all new signals.
4. **Build the `regime_edge_status` writer** (nightly, per regime × strategy × horizon from `signal_outcomes`).
5. **Run Experiments 1, 2, 3, 5, 6, 7, 10** (cheap, existing data); file results in `measurement.md` + `factor_edge_history`.
6. **Screener clustering + consensus definition** (feeds Experiment 2); then Experiment 8.
7. **Delivery factor** (Experiment 4) after items 1–5 land; then Experiment 9 for survivors.
8. **Serve calibrated probability + n + contradictory factors** on the ranking API and dashboard; add the calibration bucket table.
9. **Operations** — first-cycle intraday timing fix + Postgres/queue resource ceiling; keep the weekly freshness sweep; partition/compress the five largest tables.
10. **Governance** — create the strategy registry, route all new strategies through PAPER, promote only via the §21.4 gate.

No step above requires a new vendor, a rewrite, or removal of existing functionality. Steps 1–5 are the minimum credible path to a measurably better system; everything else is leverage on top.

---

## Appendix A — Complete public table inventory (234 tables, measured 2026-09-18)

Row figures are `reltuples` estimates (~); hypertable parents report 0 (Timescale artifact) — exact counts for those are in §2. Size in MB.

| Table | rows (est) | MB |
|---|---:|---:|
| `marketsmojo_technical_history` | 17,259,576 | 3628.9 |
| `niftytrader_live_screener_snapshots` | 3,630,267 | 1734.3 |
| `live_screener_appearances` | 12,254,251 | 1647.2 |
| `live_screener_outcomes` | 9,202,047 | 1342.8 |
| `marketsmojo_financials_history` | 4,261,971 | 1068.7 |
| `mc_general_metrics` | 3,536,461 | 855.6 |
| `intraday_recommendations_history` | 1,611,557 | 609.3 |
| `trendlyne_pb_history` | 4,195,898 | 601.3 |
| `trendlyne_pe_history` | 4,151,477 | 595.1 |
| `nse_universe_history` | 3,325,500 | 475.9 |
| `extra_endpoint_responses` | 38,370 | 472.1 |
| `screener_appearances` | 1,263,291 | 388.2 |
| `technical_signals` | 124,430 | 381.4 |
| `signal_outcomes` | 1,028,920 | 355.0 |
| `so_option_chain` | 568,957 | 227.9 |
| `screener_membership_snapshot` | 1,137,363 | 226.2 |
| `unified_recommendations` | 57,349 | 182.4 |
| `screener_history_log` | 788,536 | 181.7 |
| `mover_snapshots` | 426,662 | 169.8 |
| `news_sentiment_items` | 106,563 | 165.5 |
| `recommendation_log` | 65,181 | 142.7 |
| `data_quality_history` | 496,042 | 132.7 |
| `live_screener_ml_scores` | 888,337 | 131.7 |
| `unified_signal_outcomes` | 336,189 | 116.7 |
| `proprietary_scores_history` | 552,972 | 113.1 |
| `unified_signals` | 134,381 | 110.3 |
| `signal_excursions` | 395,273 | 106.9 |
| `news_articles` | 106,604 | 93.4 |
| `stock_factor_breakdown_history` | 424,003 | 81.3 |
| `stock_delivery_data` | 708,097 | 79.8 |
| `nt_index_pcr_ts` | 211,784 | 74.2 |
| `trendlyne_screener_stocks` | 177,798 | 69.1 |
| `deep_learning_predictions` | 137,351 | 65.6 |
| `investsights_pe_band_history` | 316,190 | 62.9 |
| `intraday_recommendations` | 72,396 | 58.1 |
| `mc_pricefeed_daily` | 102,676 | 47.2 |
| `stock_delivery_volume` | 162,625 | 42.4 |
| `index_valuation` | 202,940 | 41.5 |
| `marketsmojo_index_history` | 183,529 | 34.6 |
| `fundamentals_history` | 139,229 | 33.2 |
| `insider_trades` | 80,108 | 32.5 |
| `stock_scores` | 9,641 | 31.2 |
| `quant_scores_history` | 60,600 | 28.3 |
| `unified_recommendations_history` | 100,696 | 26.4 |
| `news_symbol_link` | 102,499 | 25.0 |
| `et_marketstats_screener_stocks` | 11,248 | 24.6 |
| `trendlyne_technical_snapshots` | 2,002 | 22.7 |
| `investsights_announcement_intel` | 24,821 | 21.5 |
| `engine_composite_scores` | 113,224 | 19.7 |
| `stock_corporate_action_history` | 30,293 | 18.0 |
| `dalalos_financial_trends_history` | 60,247 | 17.5 |
| `trendlyne_adv_tech_daily` | 48,552 | 16.7 |
| `nt_index_oi_eod` | 48,201 | 16.5 |
| `backtesting_runs` | 1,390 | 16.3 |
| `trendlyne_price_analysis` | 55,587 | 15.8 |
| `mc_stock_scans` | 67,304 | 15.5 |
| `nt_index_change_oi` | 48,199 | 14.5 |
| `investsights_factor_scores` | 58,413 | 14.3 |
| `historical_fundamentals` | 73,329 | 13.4 |
| `screener_performance_history` | 48,292 | 12.5 |
| `trendlyne_eps_history` | 62,925 | 12.2 |
| `trendlyne_div_yield_history` | 62,945 | 12.2 |
| `mc_pattern_signals` | 99,986 | 12.2 |
| `marketsmojo_shareholding_history` | 63,490 | 11.5 |
| `market_endpoint_registry` | 3,408 | 10.3 |
| `stock_event_triggers` | 64,342 | 9.7 |
| `moneycontrol_screener_stocks` | 31,026 | 9.3 |
| `stock_factor_breakdown` | 9,641 | 9.2 |
| `trendlyne_fno_activity` | 27,767 | 8.8 |
| `nse_stocks` | 2,366 | 8.8 |
| `analyst_estimates_history` | 33,999 | 8.6 |
| `corporate_actions` | 25,951 | 8.2 |
| `url_fetches` | 1,926 | 7.7 |
| `insider_transactions` | 23,596 | 7.4 |
| `trendlyne_dvm_scores` | 41,612 | 7.3 |
| `mc_earnings_rapid` | 18,516 | 7.0 |
| `job_run_history` | 31,065 | 6.5 |
| `mover_study_results` | 40,275 | 6.4 |
| `preopen_stock_snapshot` | 29,554 | 5.7 |
| `url_candidates_validation_audit` | 4,477 | 5.5 |
| `quant_scores` | 2,424 | 5.4 |
| `signal_type_weights_history` | 26,572 | 5.3 |
| `trendlyne_checklist` | 2,237 | 5.2 |
| `marketsmojo_fintrend_history` | 33,506 | 4.3 |
| `block_deals` | 11,929 | 4.1 |
| `stock_options_oi` | 11,384 | 3.6 |
| `macro_indicators` | 11,551 | 3.5 |
| `tl_financial_quality` | 13,793 | 3.5 |
| `nt_fno_dashboard` | 12,586 | 3.3 |
| `stock_option_features` | 11,609 | 3.2 |
| `trendlyne_stock_profile` | 889 | 3.2 |
| `intraday_recommendation_outcomes` | 11,761 | 2.8 |
| `credit_rating_events` | 869 | 2.8 |
| `investsights_fundamentals_history` | 9,005 | 2.6 |
| `etnow_screener_stocks` | 7,187 | 2.5 |
| `stock_fundamentals` | 2,474 | 2.5 |
| `fno_rollover` | 8,728 | 2.5 |
| `screener_reliability` | 1,841 | 2.5 |
| `company_profiles` | 387 | 2.4 |
| `signal_type_stats_history` | 11,030 | 2.4 |
| `trendlyne_stock_metrics_history` | 10,107 | 2.4 |
| `technical_composite_scores` | 2,532 | 2.2 |
| `working_capital_history` | 7,182 | 2.1 |
| `screener_catalog` | 2,539 | 2.1 |
| `mf_scheme_sector_allocation` | 10,136 | 2.1 |
| `so_stock_oi_summary` | 6,921 | 2.0 |
| `mc_analyst_ratings` | 3,919 | 2.0 |
| `gdelt_sentiment` | 13,887 | 1.9 |
| `ndtv_fno_basis` | 6,420 | 1.9 |
| `screener_master` | 1,672 | 1.9 |
| `stock_futures_oi_history` | 4,865 | 1.9 |
| `mc_stock_vitals` | 6,652 | 1.8 |
| `concall_takeaways` | 406 | 1.6 |
| `mc_earnings_forecast` | 8,447 | 1.6 |
| `url_fields` | 8,249 | 1.6 |
| `mc_chart_patterns` | 878 | 1.5 |
| `mc_price_forecast` | 3,853 | 1.5 |
| `trendlyne_screeners` | 1,006 | 1.5 |
| `superstar_investor_activity` | 5,225 | 1.5 |
| `stock_earnings_beats` | 2,862 | 1.3 |
| `high_flyer_candidates` | 3,330 | 1.3 |
| `sector_correlation_pairs` | 5,700 | 1.3 |
| `stock_mf_holdings` | 8,404 | 1.3 |
| `daily_research_reports` | 109 | 1.2 |
| `screener_instances` | 1,624 | 1.2 |
| `screener_weight_history` | 0 | 1.2 |
| `url_endpoints` | 834 | 1.1 |
| `index_option_oi` | 3,804 | 1.0 |
| `early_hours_predictions` | 2,797 | 1.0 |
| `mc_price_shockers` | 2,799 | 1.0 |
| `app_settings` | 85 | 0.9 |
| `screener_performance_v2` | 1,672 | 0.9 |
| `ai_endpoint_registry` | 1,058 | 0.9 |
| `fii_dii_flow` | 2,628 | 0.9 |
| `factor_edge_history` | 2,451 | 0.8 |
| `stock_master` | 2,001 | 0.8 |
| `mc_estimates_hits_misses` | 4,469 | 0.8 |
| `mc_global_snapshot` | 1,981 | 0.8 |
| `agent_strategy_picks` | 876 | 0.7 |
| `mc_broker_reco` | 2,219 | 0.7 |
| `mf_stock_holdings` | 3,031 | 0.7 |
| `signal_type_weights` | 893 | 0.7 |
| `ohlcv_adjustment_factors` | 2,737 | 0.7 |
| `stock_earnings_dates` | 3,752 | 0.7 |
| `url_params` | 2,375 | 0.6 |
| `data_quality_results` | 175 | 0.6 |
| `market_regimes` | 707 | 0.6 |
| `mc_seasonality_best_stocks` | 1,267 | 0.5 |
| `sector_rrg_history` | 1,833 | 0.5 |
| `intraday_breadth_snapshots` | 923 | 0.5 |
| `trendlyne_market_insights` | 675 | 0.5 |
| `trendlyne_screener_pk_history` | 1,052 | 0.5 |
| `mc_swot_history` | 499 | 0.5 |
| `et_mf_universe` | 3,891 | 0.5 |
| `eps_surprise_history` | 1,062 | 0.4 |
| `market_breadth` | 1,429 | 0.4 |
| `eco_calendar` | 1,183 | 0.4 |
| `market_sentiment_snapshots` | 635 | 0.4 |
| `etnow_screeners` | 438 | 0.3 |
| `agent_audit_reports` | 229 | 0.3 |
| `institutional_deal_signals` | 956 | 0.3 |
| `nt_fno_expiry` | 1,310 | 0.3 |
| `live_screener_runs` | 1,385 | 0.3 |
| `screener_sector_rotation` | 645 | 0.3 |
| `index_max_pain` | 534 | 0.3 |
| `intraday_regime_history` | 933 | 0.3 |
| `model_registry` | 177 | 0.2 |
| `ohlcv_corporate_actions_checked` | 2,410 | 0.2 |
| `marketsmojo_financials_checked` | 1,831 | 0.2 |
| `bulk_block_deals` | 425 | 0.2 |
| `feature_importance_log` | 510 | 0.2 |
| `intraday_strategy_lifts` | 436 | 0.2 |
| `strategy_performance` | 262 | 0.2 |
| `signal_type_stats` | 350 | 0.2 |
| `historical_fno_sentiment` | 555 | 0.2 |
| `job_sweep_results` | 28 | 0.2 |
| `signal_source_weights` | 220 | 0.2 |
| `agent_optimizer_reports` | 86 | 0.2 |
| `agent_data_scientist_reports` | 93 | 0.2 |
| `job_heartbeat` | 120 | 0.2 |
| `sector_correlation_stats` | 620 | 0.2 |
| `index_provider_map` | 557 | 0.2 |
| `moneycontrol_screeners` | 133 | 0.1 |
| `et_marketstats_screeners` | 95 | 0.1 |
| `nse_filed_corporate_actions` | 59 | 0.1 |
| `mc_scid_map` | 480 | 0.1 |
| `sector_fo_sentiment` | 197 | 0.1 |
| `trendlyne_analyst_targets` | 516 | 0.1 |
| `nse_ipo_calendar` | 214 | 0.1 |
| `sector_global_corr` | 366 | 0.1 |
| `mf_holdings_no_coverage` | 566 | 0.1 |
| `screener_runs` | 0 | 0.1 |
| `high_flyer_retrospective` | 144 | 0.1 |
| `technical_scans` | 0 | 0.1 |
| `stockedge_high_delivery_alerts` | 59 | 0.1 |
| `mf_sector_allocation` | 25 | 0.1 |
| `provider_score_consistency_audit` | 61 | 0.1 |
| `signal_actions` | 0 | 0.1 |
| `price_alerts` | 0 | 0.1 |
| `_migrations` | 121 | 0.1 |
| `dl_model_performance` | 45 | 0.1 |
| `trading80_call_alerts` | 48 | 0.1 |
| `sector_correlation_summary` | 21 | 0.1 |
| `pgmigrations` | 161 | 0.1 |
| `finstack_cashflow_history` | 0 | 0.1 |
| `signal_portfolio_correlation` | 0 | 0.1 |
| `confluence_signals` | 0 | 0.1 |
| `users` | 0 | 0.0 |
| `bulk_deals` | 8 | 0.0 |
| `stock_block_deal_daily` | 55 | 0.0 |
| `portfolio_holdings` | 0 | 0.0 |
| `mf_portfolio_holdings` | 0 | 0.0 |
| `et_cashflow_history` | 0 | 0.0 |
| `mc_advance_decline` | 94 | 0.0 |
| `stock_ohlcv` | 0 | 0.0 |
| `mc_sector_earnings` | 31 | 0.0 |
| `high_flyer_daily_stats` | 0 | 0.0 |
| `tick_data` | 0 | 0.0 |
| `timeframe_scores` | 0 | 0.0 |
| `watchlist` | 0 | 0.0 |
| `intraday_ohlcv` | 0 | 0.0 |
| `preopen_snapshot` | 44 | 0.0 |
| `todos` | 0 | 0.0 |
| `market_holidays` | 75 | 0.0 |
| `trade_journal` | 0 | 0.0 |
| `feature_store` | 0 | 0.0 |
| `regime_edge_status` | 0 | 0.0 |
| `url_field_correlations` | 0 | 0.0 |
| `marketsmojo_stock_picks` | 0 | 0.0 |
| `finstack_cashflow_checked` | 0 | 0.0 |
| `order_book_snapshots` | 0 | 0.0 |
| `macro_asset_prices` | 0 | 0.0 |
| `backtest_strategies` | 0 | 0.0 |
| `data_ingestion_dlq` | 0 | 0.0 |
