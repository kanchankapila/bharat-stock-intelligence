# AlphaQuant Pro — Institutional-Grade Indian Stock Intelligence

A local-first quantitative intelligence platform for NSE/BSE equities. Synthesizes technical analysis, fundamental data, derivatives, macro indicators, and news sentiment into actionable multi-horizon trading signals. Self-improving via a full ML feedback loop.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Data Sources                                                       │
│  MoneyControl · Trendlyne · ETnow · MarketsMojo · Yahoo Finance     │
│  NSE API · Finnhub · FinBERT NLP · Gemini API · Claude API          │
└────────────────────────┬────────────────────────────────────────────┘
                         │ fetch + cache (Redis / in-memory)
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  bharat-server  Express + tRPC (300+ procedures) · React frontend   │
│  :3000          WebSocket at /signals · BullMQ job scheduling       │
├─────────────────────────────────────────────────────────────────────┤
│  ml-api :8000       DL training/inference, outcome resolution       │
│  chatbot :8001      LangGraph RAG agent · ChromaDB                  │
│  alphaquant-api     Backtesting, scoring, TV bridge, optimisation   │
│  :8002                                                               │
│  engine-worker      Ingestion Governor, MCP server & Engine Worker  │
│  :8005                                                               │
├─────────────────────────────────────────────────────────────────────┤
│  Signal Pipeline (Node)                                             │
│  technicalSignalsService → confluenceEngine → scoring_engine.py    │
│                                                                     │
│  ML Pipeline (Python, ~200 modules incl. 79 *_fetcher.py)          │
│  feature_engineering → regime_detector → ml_ensemble → dl_engine  │
│  outcome_resolver → performance_tracker → reward_engine → rl_agent │
│  online_learner → strategy_optimizer → backtester                  │
│  → unified_ranker.py (canonical cross-source ranking)              │
├─────────────────────────────────────────────────────────────────────┤
│  greenfield/  parallel rebuild pipeline (~105 .ts files), scheduled │
│  as its own cron_restart tier — nothing in the app above imports it │
│  yet; see "Greenfield Shadow Pipeline" below                        │
└────────────────────────┬────────────────────────────────────────────┘
                         │ PostgreSQL/TimescaleDB (:5433) — the only DB
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend  React 19 · Vite · TailwindCSS 4 · Recharts              │
│  Six dashboard experiences (v1 default … v6), all lazy-loaded,     │
│  all reading the same tRPC surface — see "Frontend Versions" below │
└─────────────────────────────────────────────────────────────────────┘
```

All processes run under pm2 in production (`ecosystem.config.cjs`) — 17 apps total: the 5
long-running services above plus a `cron_restart` tier (11 `greenfield` one-shot jobs +
`pg-backup-nightly`). `npm start` runs the 4 core dev services directly without pm2.

See [Data Source Integration Guide](docs/DATA_SOURCE_INTEGRATION_GUIDE.md) for the reusable
provider catalog, endpoint families, identifier mappings, authentication, output ownership,
testing requirements, and known broken sources.

### Services

| pm2 name | Entry point | Port (env var) | Purpose |
|---|---|---|---|
| `bharat-server` | `server.ts` | 3000 (`PORT`) | tRPC API, React frontend, WebSocket at `/signals` |
| `ml-api` | `src/server/python_api.py` | 8000 (`PYTHON_API_PORT`) | DL training/inference, outcome resolution |
| `chatbot` | `src/server/chatbot/app.py` | 8001 (`CHATBOT_PORT`) | LangGraph RAG agent, ChromaDB |
| `alphaquant-api` | `backend-python/main.py` | 8002 (`PYTHON_PORT`) | Backtesting, scoring, TV bridge, optimisation |
| `engine-worker` | `src/server/worker_service.py` | 8005 (`ENGINE_WORKER_PORT`) | Ingestion Governor, MCP server, Engine Worker |

A change to one service is not live in the others, and none of the `.py`/`.ts` files are
hot-reloaded — a code change needs `pm2 restart <name>` (or `npm start`'s dev-mode watchers).

### Frontend Versions

Six dashboard shells coexist in one app, no separate build — `App.tsx`'s `dashboardVersion`
(localStorage) picks among v1/v2/v3/v6; v4 lives inside the v2 shell and v5 is its own route
tree at `/v5`. **v1 is the default** (classic tab list, nav-links every page the other shells
have). Nothing is deprecated — all six read the same tRPC procedures.

---

## Features

### Signal Intelligence & Confluence Engine
- **Multi-screener confluence**: aggregates Trendlyne + MoneyControl + ETnow screeners, deduplicates correlated signals, scores by source/category caps with exponential decay
- **Consensus bonus**: grants extra score when Technical + Fundamental + Momentum + Delivery domains align
- **RL-gated output**: Q-learning meta-controller gates signals with `win_probability >= 0.40`
- **Confluence signals table**: ranked ELITE/STRONG/MODERATE/WEAK opportunities, refreshed every 30 min
- **Real-time WebSocket**: pushes new signals to connected clients

### Technical Analysis Engine
- **2000+ stocks scanned** every 30 minutes for EMA crossovers, RSI divergences, Bollinger Band squeezes, MACD signals, candlestick patterns
- **Multi-timeframe alignment**: 1D / 1W / 1M trend confirmation with MTF alignment score
- **Intraday breakouts**: real-time detection during market hours
- **Win probability**: each signal scored by stacking ensemble (`ml_ensemble.py`)
- **Regime-aware signals**: attaches current HMM market regime to every signal

### Market Regime Detector
- **5-state Gaussian HMM**: classifies market into BULL / SIDEWAYS / HIGH_VOL / BEAR / CRASH
- Trained on Nifty returns, volatility, VIX, FII flows, macro factors (US10Y, DXY, SP500)
- Updates daily (`regime_detector.py --mode update`); retrain yearly (`--mode train`)
- Stored in `market_regimes` table; used by scoring engine and signal labeling

### Feature Engineering Pipeline
- **84 ML-ready features** per symbol per day: price returns, momentum, volatility, volume, FII/DII flows, fundamentals, macro indicators, sentiment, options data
- Leakage-prevented with FUND_LAG_DAYS=45 and FII_LAG_DAYS=1
- Persistent scaler (`ml_models/feature_scaler_v1.pkl`)
- Writes to `feature_store`; consumed by `ml_ensemble.py`, `dl_engine.py`, `online_learner.py`

### ML Continuous Learning Framework
- **Stacking Ensemble** (`ml_ensemble.py`): GradientBoosting + RandomForest + ExtraTrees + LogisticRegression with OOF stacking and calibrated probabilities
- **Online SGD** (`online_learner.py`): incremental `partial_fit` with 40% SGD / 60% ensemble blend, rolling 180-day window
- **Deep Learning** (`dl_engine.py`, `dl_trainer.py`): LSTM-based sequence model, predicts prob_up_1d/5d/15d
- **Outcome Resolver** (`outcome_resolver.py`): labels each signal WIN/LOSS/NEUTRAL/STOP_LOSS against OHLCV at 5-day and 15-day horizons
- **Performance Tracker** (`performance_tracker.py`): computes win rates, Sharpe, alpha vs Nifty; segments by signal_type / regime / sector / score_bucket
- **Reward Engine** (`reward_engine.py`): EMA-smoothed reward propagation updates `signal_type_weights`
- **RL Agent** (`rl_agent.py`): Q-learning meta-controller; logs episodes, updates Q-table daily from resolved outcomes
- **Strategy Optimizer** (`strategy_optimizer.py`): scipy `differential_evolution` on CATEGORY_WEIGHTS + SOURCE_WEIGHTS; persists to `app_settings`
- **Drift Detector** (`drift_detector.py`): monitors feature distribution shift; triggers retraining alerts

### Fundamental Analysis
- **Trendlyne**: DVM scores, SWOT, checklists, advanced technical metrics, sector rotation
- **MoneyControl**: SWOT, essentials, ratios, analyst ratings, earnings forecasts, price forecasts, consensus, OHLC, insights
- **Stock fundamentals**: P/E, P/B, ROE, debt-to-equity, operating margins, EPS growth, revenue growth, Piotroski F-score, earnings yield

### Derivatives (F&O) Intelligence
- **Options chain**: strike-level OI, IV, Greeks via NiftyTrader API
- **PCR scanner** (`pcr_fetcher.py`): daily Put/Call Ratio from NSE
- **F&O heatmaps**: Trendlyne FnO heatmap + MC FnO overview
- **Buildup analysis**: Long Buildup / Short Buildup / Long Unwinding / Short Covering
- **Bulk & block deals**: tracked in `block_deals` (NSE `block_deal_fetcher.py` + Tickertape `tickertape_deals_fetcher.py`, the latter carrying `pctTransacted` — % of float traded) — not the dead `bulk_deals` table, which has had no writer since 2026-05

### Sentiment & News
- **News ingestion**: corporate actions, earnings, order wins, macro events
- **FinBERT NLP** (`finbert_scorer.py`): sentiment polarity −1.0 to +1.0 with publisher quality-tier multiplier
- **Institutional flows** (`institutional_quant_engine.py`): FII/DII net flows, block deals, insider trades — on-demand only (not on any automatic schedule since 2026-08, see Python Scripts Reference below)
- **FII/DII fetcher** (`fii_dii_fetcher.py`): daily institutional data from NSE API
- **Claude AI re-scoring**: high-impact news re-evaluated by Claude (`ANTHROPIC_API_KEY`)

### Global Macro
- **`global_macro_fetcher.py`**: fetches US10Y, DXY, Crude, Gold, SP500, Nifty50 via yfinance into `macro_asset_prices`
- Macro features fed into feature store and regime detector

### NSE Stock Discovery
- **2366+ NSE stocks** with sector, industry, ISIN, market cap, P/E, dividend yield
- Full-text search, sector/industry cascading filters
- Card grid and tabular views

### Backtesting
- **`backtester.py`**: replays historical `technical_signals` against `stock_ohlcv` with stop-loss enforcement, equal-weight sizing, Nifty benchmark comparison
- **`backtest_optimizer.py`**: grid search for optimal backtest parameters
- Results stored in `backtesting_runs` (equity curve, trade log, Sharpe, alpha)

### OHLCV Management
- **`backfill_ohlcv.py`**: gap-fill or full-backfill from Yahoo Finance
  - `--mode gap-fill --lookback 30`: fill recent gaps (weekly)
  - `--mode full --start 2020-01-01`: complete historical backfill

### System Monitor (`/monitor`)
Visual dashboard for all Python pipeline scripts. Per-script status (Never / Running / OK / Stale / Failed), last-run time, key stats, and "Run Now" button. Auto-refreshes every 30 seconds.

Scripts tracked:

> Schedule column verified directly against the registered cron patterns in `queues.ts` /
> `src/server/jobs/*.jobs.ts` on **2026-08-30**. Several rows moved significantly since this
> table was last written (2026-08-06) — most notably **Unified Ranker, which reversed direction
> entirely**: it ran pre-open (7:30 AM IST) as of the last update, then was moved to **post-close
> (10:30 PM IST)** so all of a day's recommendations/digests/ranker updates finish before 11:30 PM.
> The three weekly-retrain jobs also moved from Sunday to **Saturday** (part of the closed-day
> early-scheduling pattern — a market-closed weekday runs batch work in the morning instead of
> waiting for a close that never comes; Saturday gets the same treatment for weekly jobs).

| Script | Schedule | Populates |
|---|---|---|
| Technical Signal Scan | Every 30 min, 8:30 AM–4:00 PM IST weekdays | `technical_signals` |
| DL Macro Fetch | Daily 8:00 AM IST | `macro_asset_prices` |
| Outcome Resolver | Daily 9:30 AM IST | `signal_outcomes` (1/5/15-day horizons) |
| Stock/OHLCV Refresh | Daily 4:00 PM IST | `stock_ohlcv` |
| OHLCV Gap Fill (daily) | Daily 4:15 PM IST, 3-day lookback | `stock_ohlcv` |
| Market Regime Detector | Daily 4:45 PM IST | `market_regimes` |
| Feature Engineering (DL) | Daily 5:00 PM IST | `feature_store` |
| Screener Syncs (ET-Marketstats/Trendlyne/MoneyControl/ETNow) | Daily 6:00–6:40 PM IST | `*_screeners`, `*_screener_stocks` |
| **ML Daily Ops** (FII/DII, FinBERT, Performance Tracker, ML Ensemble Score, Drift Detector, Reward Engine, RL Agent Update, Signal Type Stats, ~45 more steps) | Daily 6:50 PM IST | `fii_dii_flow`, `technical_signals.{news_sentiment_score,win_probability}`, `strategy_performance`, `dl_model_performance`, `signal_type_weights`, `rl_q_table`, `signal_type_stats` |
| Stock Scoring | Daily 8:30 PM IST | `stock_scores`, `stock_factor_breakdown` |
| Quant Scoring | Daily 8:50 PM IST | `quant_scores` |
| Confluence Outcomes | Daily 9:10 PM IST | confluence-sourced `signal_outcomes` |
| DL Engine Inference | Daily 9:30 PM IST | `deep_learning_predictions` |
| Sync Company Profiles | Daily (all 7 days) 9:00 PM IST | company description/profile tables |
| Chatbot Reingest | Daily (all 7 days) 1:30 AM IST | ChromaDB vector store |
| Quant EOD Sync | Daily 10:00 PM IST | `proprietary_scores_history` |
| Screener Performance | Daily 10:10 PM IST (same evening, not next morning) | `screener_performance_history` |
| **Unified Ranker** | **Daily 10:30 PM IST** (post-close — see note above) | `unified_recommendations` (canonical ranking) |
| Fundamentals Sync | Weekly **Saturday** 8:30 AM IST | `stock_fundamentals` |
| ML Ensemble Train, Strategy Optimizer | Weekly **Saturday** 10:30 AM IST | `model_registry`, `app_settings` weights |
| DL Model Trainer | Weekly **Saturday** 11:30 AM IST | `dl_model_performance` |
| OHLCV Gap Fill (weekly) | Weekly, Saturday 2:00 AM IST, 30-day lookback | `stock_ohlcv` |
| Mover Reverse-Engineering Study | Weekly Sunday 12:00 PM IST | `mover_study_results`, `docs/mover_study_report.md` |

**Greenfield shadow pipeline** (parallel rebuild, `greenfield/` — separate from everything
above, reads/writes its own tables, feeds nothing the live app reads yet): bhavcopy 7:30 PM IST →
FII/DII 9:00 PM → features 9:30 PM → DQ checks 9:40–9:50 PM → ranker 10:00 PM → divergence
analysis 10:15 PM, all daily weekdays; screener membership/fundamentals/analyst-estimates/
insider-activity transfers run Saturday mornings. Scheduled as pm2 `cron_restart` apps, not
BullMQ — see `ecosystem.config.cjs`.

**Holiday-aware scheduling.** On a mid-week NSE trading holiday (a weekday the exchange is shut —
not caught by cron's own day-of-week check), a dedicated `closed-day-early-batch` job runs the
critical daily pipeline early instead (~7:10 AM IST: Outcome Resolver → ML Daily Ops → Unified
Ranker), and every other job in the table above skips its normal run for that day — there is no
new market data to fetch or re-score, so running the full evening/night chain again would just
duplicate the same output. See `src/server/marketStatusService.ts`'s `isTradingHolidayToday()` /
`shouldSkipOnTradingHoliday()`. Weekends need no such handling — nearly every job above is already
weekday-only by cron pattern.

### Telegram Alerts
Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env` to receive signal alerts in a Telegram chat. Also configurable via the platform's settings page.

### AlphaQuant MCP Server
Local analytics MCP server at `ALPHAQUANT_URL` (default `http://127.0.0.1:8002`). Exposes tools: `get_market_dashboard`, `get_stock_profile`, `query_stocks_db`, `run_analytical_engine`, `search_codebase`, `get_db_schema`.

---

## Setup

### Prerequisites
- Node.js 18+
- Python 3.10+ with pip
- Redis (optional — falls back to in-memory cache + setInterval)

> **No local LLM since 2026-08-20.** `aiService` routes AI stock-signal/profile analysis and the
> chatbot to Gemini/Claude only — there is no Ollama fallback. `GEMINI_API_KEY` is effectively
> required for those features, not optional.

### 1. Clone and install dependencies

```bash
git clone https://github.com/your-org/bharat-stock-intelligence
cd bharat-stock-intelligence

npm install
pip install -r requirements.txt
```

### 2. Configure environment

Copy `.env` and fill in required keys:

```bash
cp .env .env.local   # or edit .env directly
```

Minimum required to run (all others have safe defaults or are optional):

```env
POSTGRES_URL=postgresql://bharat:bharat@localhost:5433/bharat_intel
GEMINI_API_KEY=your_key               # required — no local LLM fallback (removed 2026-08-20)
PYTHON_PATH=/usr/bin/python3          # full path to Python binary
```

> **Postgres is the only database.** `USE_POSTGRES` and `DATABASE_URL` used to appear here and are
> no longer read by any real process (2026-08-15) — the dialect consults no environment variable
> at all. Setting them does nothing; omitting them breaks nothing. A bad `POSTGRES_URL` now fails
> loudly instead of silently answering from a stale local SQLite file.

Optional but recommended:

```env
ANTHROPIC_API_KEY=                    # Claude AI for news re-scoring
FINNHUB_API_KEY=                      # Secondary live price source
TELEGRAM_BOT_TOKEN=                   # Signal alert notifications
TELEGRAM_CHAT_ID=
REDIS_HOST=localhost                  # BullMQ + distributed cache
```

### 3. Start the platform

```bash
npm start
```

Starts both Express tRPC server (port 3000) and Vite dev server.

- Web UI: http://localhost:3000
- tRPC API: http://localhost:3000/api/trpc
- WebSocket: ws://localhost:3000/signals

---

## Navigation Pages

> These routes are v1 (the default shell, `AppShell`). v2/v3 use a Bloomberg-terminal-styled
> `V2AppShell` (also home to v4's `MarketCommandCenter`/`StockIntelligencePage`); v5 is a separate
> institutional-workbench route tree at `/v5`; v6 (`V6Shell`) composes its own home/portfolio/
> screener pages. All six read the same tRPC procedures — see "Frontend Versions" above.

| Route | Page |
|---|---|
| `/dashboard` | Live market overview, indices, global markets |
| `/trade-cockpit` | Trade Decision Cockpit — signal confluence, entry/target/SL |
| `/top-rated` | Top-rated stocks by AI composite score |
| `/indices` | Nifty 50, Bank Nifty, Sensex detail pages |
| `/market-map` | Sector heatmap |
| `/screener` | NSE stock screener + discovery |
| `/fno-scanners` | F&O intelligence, options chain, buildup analysis |
| `/smart-money` | FII/DII flows, institutional data |
| `/trendlyne` | Trendlyne screeners and sector rotation |
| `/discover` | NSE stock discovery with filters |
| `/backtest` | Backtesting strategies |
| `/portfolio` | Portfolio analytics |
| `/watchlist` | Personal watchlist |
| `/signals` | Signal history and accuracy metrics |
| `/sentiment` | News sentiment, sector sentiment |
| `/economics` | Global macro indicators |
| `/strategy` | Strategy builder |
| `/monitor` | System Monitor — pipeline script status + manual triggers |
| `/todo` | Task list |

---

## Python Scripts Reference

### Daily (illustrative manual invocations — see the schedule table above for real auto-run times)

Every script below is auto-scheduled somewhere between 8:00 AM and 10:30 PM IST, not uniformly
5 PM — check the table above for the specific time before assuming one from this list. Most of
these (everything from `fii_dii_fetcher.py` through `ml_ensemble.py --score`) actually run as
steps inside `ml-daily-ops` at 6:50 PM IST, not standalone.

```bash
# Institutional flow data from NSE
python src/server/fii_dii_fetcher.py

# Put/Call ratios from NSE options data
python src/server/pcr_fetcher.py

# FinBERT sentiment scoring on today's news
python src/server/finbert_scorer.py --days 1

# Market regime detection (updates market_regimes table) — its own dedicated 4:45 PM IST job,
# not part of ml-daily-ops
python src/server/regime_detector.py --mode update

# Feature engineering — today-only fast mode (writes 1 row per symbol) — its own dedicated
# 5:00 PM IST job, not part of ml-daily-ops
python src/server/feature_engineering.py --date today

# Resolve signal outcomes at 1/5/15-day horizons
python src/server/outcome_resolver.py --horizon 1
python src/server/outcome_resolver.py --horizon 5
python src/server/outcome_resolver.py --horizon 15

# Compute win rates, Sharpe, alpha vs Nifty
python src/server/performance_tracker.py --horizon 5

# EMA reward propagation → signal_type_weights
python src/server/reward_engine.py

# Q-learning agent update → rl_q_table
python src/server/rl_agent.py --update

# ML ensemble win probability scoring on today's signals
python src/server/ml_ensemble.py --score

# Deep learning inference → deep_learning_predictions — auto-scheduled by chaining off
# feature_engineering.py's completion (see the schedule table above), not a fixed time
python src/server/dl_engine.py --mode infer

# Global macro data (US10Y, DXY, Crude, Gold, SP500)
python src/server/global_macro_fetcher.py
```

> `institutional_quant_engine.py` (block deals, insider trades) is **not** on any automatic
> schedule — it was retired as a nightly writer in 2026-08 because its full DELETE+re-INSERT into
> `quant_scores` was always clobbered a few hours later by `quantScoringService.ts`'s own upsert.
> Still reachable on-demand via the AlphaQuant MCP server's `run_analytical_engine` tool.

### Weekly (Saturday morning — closed-day early scheduling, see the schedule table above)

```bash
# Retrain stacking ensemble (GB + RF + ET + LR)
python src/server/ml_ensemble.py --train --score

# Optimize CATEGORY_WEIGHTS + SOURCE_WEIGHTS via differential evolution
python src/server/strategy_optimizer.py

# OHLCV gap fill — 30-day lookback
python src/server/backfill_ohlcv.py --mode gap-fill --lookback 30

# Retrain online SGD learner (180-day rolling window)
python src/server/online_learner.py --window 180

# DL model retrain (uses feature_store)
python src/server/dl_trainer.py --trigger scheduled

# Drift detection + optional retraining trigger
python src/server/drift_detector.py
```

### Monthly / One-time

```bash
# Full historical backtest vs Nifty benchmark
python src/server/backtester.py --start 2023-01-01

# Grid search for optimal backtest parameters
python src/server/backtest_optimizer.py

# Full feature store bootstrap — all symbols, 504-day lookback (slow, ~60 min)
python src/server/feature_engineering.py

# HMM regime model retrain (once yearly or after major market regime change)
python src/server/regime_detector.py --mode train

# Sync full OHLCV history from scratch
python src/server/backfill_ohlcv.py --mode full --start 2020-01-01

# NSE stock master sync
# Trigger via tRPC: syncNSEStocks
```

### RL Agent operations

```bash
# Update Q-table from today's resolved episodes
python src/server/rl_agent.py --update

# Inspect current Q-table and policy
python src/server/rl_agent.py --inspect

# Dry run (no DB writes)
python src/server/rl_agent.py --update --dry-run
```

### Regime Detector operations

```bash
# Train new HMM model (run after major regime shift or yearly)
python src/server/regime_detector.py --mode train

# Update today's regime entry
python src/server/regime_detector.py --mode update

# Classify a specific date
python src/server/regime_detector.py --mode update --date 2026-01-15
```

### Feature Engineering operations

```bash
# Full backfill — all symbols, 504-day lookback
python src/server/feature_engineering.py

# Today-only fast mode (daily use)
python src/server/feature_engineering.py --date today

# Specific symbols only
python src/server/feature_engineering.py --symbols HDFCBANK INFY RELIANCE

# Custom lookback window
python src/server/feature_engineering.py --lookback 252
```

---

## Database Tables (~126 total)

> The trade-signal model was consolidated in the Phase-3 program: **four signal tables, and that's
> the ceiling** — `unified_signals`, `technical_signals`, `signal_outcomes`, `unified_signal_outcomes`
> — the legacy `signals` and `technical_analysis_signals` tables were dropped/folded in.
> `unified_recommendations` (from `unified_ranker.py`) is the canonical cross-source ranking;
> `stock_scores`/`quant_scores` are its component *inputs*, not duplicates. The table set has
> grown well past the original 67 as alt-data fetchers were added (delivery, insider, options OI,
> credit ratings, corporate calendar, market breadth, analyst estimates, MarketsMojo, F&O
> positioning, etc.); the groups below list the load-bearing core, not every table.

| Group | Tables |
|---|---|
| Core | `users`, `watchlist`, `nse_stocks`, `stock_ohlcv`, `stock_fundamentals` |
| Signals | `technical_signals`, `technical_scans`, `confluence_signals`, `unified_signals`, `unified_recommendations` |
| Outcomes | `signal_outcomes`, `unified_signal_outcomes`, `recommendation_log` |
| Screeners | `trendlyne_screeners`, `trendlyne_screener_stocks`, `moneycontrol_screeners`, `moneycontrol_screener_stocks`, `etnow_screeners`, `etnow_screener_stocks`, `screener_master`, `screener_reliability` |
| ML Models | `model_registry`, `feature_importance_log`, `feature_store`, `deep_learning_predictions`, `dl_model_performance` |
| ML Ops | `strategy_performance`, `screener_weight_history`, `backtesting_runs`, `signal_type_stats`, `signal_type_weights` |
| RL | `rl_q_table`, `rl_episodes` |
| Market Data | `stock_scores`, `stock_factor_breakdown`, `quant_scores`, `market_regimes`, `market_sentiment_snapshots` |
| Macro | `macro_asset_prices`, `macro_indicators`, `fii_dii_flow` |
| Options / F&O | `stock_options_oi`, `intraday_ohlcv`, `stock_futures_oi_history` (long/short buildup, rollover, basis) |
| News | `news_articles`, `news_sentiment_items` |
| Events | `block_deals`, `bulk_block_deals`, `insider_trades` |
| MarketsMojo | `marketsmojo_{technical,financials,fintrend,index,shareholding}_history` |
| Ops / Monitoring | `job_heartbeat`, `job_run_history`, `data_quality_results` |
| Config | `app_settings`, `_migrations` |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite 6, TailwindCSS 4, Recharts, Framer Motion, Lucide React |
| Backend | Express.js, tRPC, SuperJSON, React Query |
| Database | PostgreSQL + TimescaleDB (:5433) — the only database any **real process** talks to (`usePostgres()` reads no env var outside a test runner). `db/schema.postgres.sql`, regenerated from live via `npm run schema:regen`, is the schema to trust. `db.ts` has been deleted (`a2a20d2`); there is no SQLite schema file left to mis-read |
| Cache / Queue | Redis (ioredis) + BullMQ; in-memory + setInterval fallback |
| Auth | Firebase (Google OAuth) |
| AI | Google Gemini API, Anthropic Claude (news re-scoring) — no local LLM since 2026-08-20 |
| Python Engines | Pandas, NumPy, scikit-learn, SciPy, PyTorch, hmmlearn, ta, yfinance |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `POSTGRES_URL` | `postgresql://bharat:bharat@localhost:5433/bharat_intel` | Postgres connection string |
| ~~`USE_POSTGRES`~~ | — | **Removed 2026-08-15.** Read by no real process. Survives only as a fixture selector inside pytest |
| ~~`DATABASE_URL`~~ | — | **Removed 2026-08-15.** The SQLite fallback it pointed at no longer exists |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis auth password |
| `PYTHON_API_PORT` | `8000` | `ml-api` service port |
| `CHATBOT_PORT` | `8001` | `chatbot` (LangGraph RAG) service port |
| `PYTHON_PORT` | `8002` | `alphaquant-api` service port |
| `ENGINE_WORKER_PORT` | `8005` | `engine-worker` service port |
| `GEMINI_API_KEY` | — | Google Gemini API key — required for AI features, no local-LLM fallback since 2026-08-20 |
| `ANTHROPIC_API_KEY` | — | Claude API key for news re-scoring and signal insights |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Claude model ID |
| `FINNHUB_API_KEY` | — | Secondary live price source |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for signal alerts |
| `TELEGRAM_CHAT_ID` | — | Telegram chat/channel ID |
| `PYTHON_BIN` | `python3` | Python alias for MCP server |
| `PYTHON_PATH` | `python3` (Linux) / full path (Win) | Full Python binary path for BullMQ workers and Monitor |
| `ALPHAQUANT_URL` | `http://127.0.0.1:8002` | AlphaQuant MCP server URL |
| `QUOTE_FETCH_TIMEOUT_MS` | `8000` | Yahoo Finance batch request timeout |
| `MAX_INDIVIDUAL_FALLBACKS` | `250` | Max symbols for individual fallback fetching |
| `LOG_LEVEL` | `info` | `info` or `debug` |
| `USE_FINBERT` | `true` | Enable FinBERT NLP engine |
| `TRENDLYNE_FETCH_INTERVAL_MS` | `43200000` | Screener sync interval (12h) |
| `TRENDLYNE_SCREENER_NAMES_INTERVAL_MS` | `86400000` | Screener name sync interval (24h) |
| `TRENDLYNE_BASE_DELAY_MS` | `500` | Base delay between Trendlyne requests |
| `TRENDLYNE_JITTER_PERCENT` | `15` | Random jitter % on Trendlyne delays |
| `TRENDLYNE_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout for Trendlyne |
