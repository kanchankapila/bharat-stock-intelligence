# AlphaQuant Pro — Institutional-Grade Indian Stock Intelligence

A local-first quantitative intelligence platform for NSE/BSE equities. Synthesizes technical analysis, fundamental data, derivatives, macro indicators, and news sentiment into actionable multi-horizon trading signals. Self-improving via a full ML feedback loop.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Data Sources                                                       │
│  MoneyControl · Trendlyne · ETnow · Yahoo Finance · NSE API        │
│  Finnhub · FinBERT NLP · Ollama LLM · Gemini API · Claude API      │
└────────────────────────┬────────────────────────────────────────────┘
                         │ fetch + cache (Redis / in-memory)
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Backend  Express + tRPC (130+ procedures) · PostgreSQL/Timescale · BullMQ │
│                                                                     │
│  Signal Pipeline                                                    │
│  technicalSignalsService → confluenceEngine → scoring_engine.py    │
│                                                                     │
│  ML Pipeline (Python)                                               │
│  feature_engineering → regime_detector → ml_ensemble → dl_engine  │
│  outcome_resolver → performance_tracker → reward_engine → rl_agent │
│  online_learner → strategy_optimizer → backtester                  │
└────────────────────────┬────────────────────────────────────────────┘
                         │ tRPC + WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend  React 19 · Vite · TailwindCSS 4 · Recharts              │
│  18 pages: Dashboard · Trade Cockpit · Screeners · F&O · Monitor …  │
└─────────────────────────────────────────────────────────────────────┘
```

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
- **Bulk & block deals**: tracked in `bulk_deals` table

### Sentiment & News
- **News ingestion**: corporate actions, earnings, order wins, macro events
- **FinBERT NLP** (`finbert_scorer.py`): sentiment polarity −1.0 to +1.0 with publisher quality-tier multiplier
- **Institutional flows** (`institutional_quant_engine.py`): FII/DII net flows, block deals, insider trades
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

| Script | Schedule | Populates |
|---|---|---|
| Technical Signal Scan | Every 30 min | `technical_signals` |
| Outcome Resolver (5D) | Daily 9:30 AM | `signal_outcomes` (5-day) |
| Outcome Resolver (15D) | Daily 9:30 AM | `signal_outcomes` (15-day) |
| Performance Tracker | Daily 9:30 AM | `strategy_performance` |
| FII/DII Fetcher | Daily 5 PM | `fii_dii_flow` |
| FinBERT Sentiment | Daily 5 PM | `technical_signals.news_sentiment_score` |
| ML Ensemble Score | Daily 5 PM | `technical_signals.win_probability` |
| ML Ensemble Train | Weekly Sunday | `model_registry` |
| Strategy Optimizer | Weekly Sunday | `app_settings` weights |
| OHLCV Gap Fill | Weekly Saturday | `stock_ohlcv` |
| Market Regime Detector | Daily 5 PM | `market_regimes` |
| Feature Engineering | Daily 5 PM | `feature_store` |
| Reward Engine | Daily 5 PM | `signal_type_weights` |
| RL Agent Update | Daily 5 PM | `rl_q_table` |
| DL Engine Inference | Daily 5 PM | `deep_learning_predictions` |
| DL Model Trainer | Weekly Sunday | `dl_model_performance` |
| Signal Type Stats | Daily 5 PM | `signal_type_stats` |

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
- Ollama (optional — falls back to Gemini API)

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
USE_POSTGRES=true                     # live DB engine (Phase 3); see docker-compose.yml
POSTGRES_URL=postgresql://bharat:bharat@localhost:5433/bharat_intel
DATABASE_URL=database.sqlite          # legacy SQLite path (schema-of-record / dev fallback)
GEMINI_API_KEY=your_key               # or use Ollama locally
PYTHON_PATH=/usr/bin/python3          # full path to Python binary
```

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

### Daily (run after market close — 5 PM IST)

```bash
# Institutional flow data from NSE
python src/server/fii_dii_fetcher.py

# Put/Call ratios from NSE options data
python src/server/pcr_fetcher.py

# FinBERT sentiment scoring on today's news
python src/server/finbert_scorer.py --days 1

# Institutional quant analysis (block deals, insider trades)
python src/server/institutional_quant_engine.py

# Market regime detection (updates market_regimes table)
python src/server/regime_detector.py --mode update

# Feature engineering — today-only fast mode (writes 1 row per symbol)
python src/server/feature_engineering.py --date today

# Resolve signal outcomes at 5-day and 15-day horizons
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

# Deep learning inference → deep_learning_predictions
python src/server/dl_engine.py --mode infer

# Global macro data (US10Y, DXY, Crude, Gold, SP500)
python src/server/global_macro_fetcher.py
```

### Weekly (Sunday after market close)

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

## Database Tables (67 total)

| Group | Tables |
|---|---|
| Core | `users`, `watchlist`, `nse_stocks`, `stock_ohlcv`, `stock_fundamentals` |
| Signals | `signals`, `technical_signals`, `technical_scans`, `confluence_signals`, `unified_signals` |
| Outcomes | `signal_outcomes`, `unified_signal_outcomes`, `recommendation_log` |
| Screeners | `trendlyne_screeners`, `trendlyne_screener_stocks`, `moneycontrol_screeners`, `moneycontrol_screener_stocks`, `etnow_screeners`, `etnow_screener_stocks`, `screener_master`, `screener_reliability` |
| ML Models | `model_registry`, `feature_importance_log`, `feature_store`, `deep_learning_predictions`, `dl_model_performance` |
| ML Ops | `strategy_performance`, `screener_weight_history`, `backtesting_runs`, `signal_type_stats`, `signal_type_weights` |
| RL | `rl_q_table`, `rl_episodes` |
| Market Data | `stock_scores`, `stock_factor_breakdown`, `quant_scores`, `market_regimes`, `market_sentiment_snapshots` |
| Macro | `macro_asset_prices`, `macro_indicators`, `fii_dii_flow` |
| Options | `stock_options_oi`, `intraday_ohlcv` |
| News | `news_articles`, `news_sentiment_items` |
| Events | `bulk_deals`, `insider_trades`, `institutional_rankings` |
| Config | `app_settings`, `_migrations` |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite 6, TailwindCSS 4, Recharts, Framer Motion, Lucide React |
| Backend | Express.js, tRPC, SuperJSON, React Query |
| Database | PostgreSQL + TimescaleDB (`USE_POSTGRES=true`, :5433); SQLite (better-sqlite3) legacy/dev fallback + schema-of-record (`db.ts`) |
| Cache / Queue | Redis (ioredis) + BullMQ; in-memory + setInterval fallback |
| Auth | Firebase (Google OAuth) |
| AI — Local | Ollama (Mistral / Llama3) |
| AI — Cloud | Google Gemini API (Ollama fallback), Anthropic Claude (news re-scoring) |
| Python Engines | Pandas, NumPy, scikit-learn, SciPy, PyTorch, hmmlearn, ta, yfinance |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | `development` or `production` |
| `USE_POSTGRES` | `true` | Use PostgreSQL/TimescaleDB (live engine) instead of SQLite |
| `POSTGRES_URL` | `postgresql://bharat:bharat@localhost:5433/bharat_intel` | Postgres connection string |
| `DATABASE_URL` | `database.sqlite` | Legacy SQLite path (schema-of-record / dev fallback) |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis auth password |
| `OLLAMA_API_URL` | `http://localhost:11434` | Ollama instance URL |
| `OLLAMA_MODEL` | `mistral` | Ollama model name |
| `GEMINI_API_KEY` | — | Google Gemini API key (Ollama fallback) |
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
