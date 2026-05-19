# AlphaQuant Pro: Institutional-Grade Indian Stock Intelligence

A real-time, local-first quantitative intelligence platform for NSE/BSE markets. Synthesizes live prices, technical signals, fundamental data, news sentiment, F&O intelligence, and a self-improving ML feedback loop into actionable BUY/SELL/HOLD recommendations.

---

## Key Features

### Multi-Factor Consensus Engine
- Ingests and normalizes screener data from **Trendlyne**, **MoneyControl**, and **ETnow**
- Dual-horizon rankings: **Long-Term Institutional** and **Intraday Momentum**
- Domain attribution: Fundamental, Technical, Momentum, Delivery
- Quantitative scoring via `quantScoringService.ts` with Sharpe, drawdown, and Piotroski factors

### Live Market Intelligence
- 5-second price simulation + 5-minute Yahoo Finance batch refresh (50 symbols/batch, 8 concurrent)
- Nifty 50, Sensex, Bank Nifty, global indices (US, Asia, Europe)
- Top movers, intraday breakouts, sector heatmaps
- NSE stock discovery across 2000+ stocks with sector/industry filtering

### Technical Analysis Engine
- OHLCV backfill via `backfill_ohlcv.py` (yfinance, 200 stocks)
- Signal detection: RSI divergence, MACD crossover, Bollinger squeeze, EMA crossovers, candlestick patterns
- Entry/Target/Stop-Loss predictions with risk/reward ratios
- Win-probability gating: only signals with `win_probability >= 0.40` are surfaced

### News Sentiment Intelligence
- Multi-source news ingestion (Indian + global) with NLP classification
- FinBERT scoring (`finbert_scorer.py`) for High/Medium/Low impact events
- Claude AI re-scoring of high-impact items via Anthropic API (Haiku)
- Market sentiment snapshots every 15 minutes; symbol-level sentiment overlay

### F&O Intelligence Center
- Options chain with OI, PCR, IV from NiftyTrader
- Buildup analysis (Long/Short buildup, OI unwinding)
- FII/DII daily flow tracking (`fii_dii_fetcher.py`, `pcr_fetcher.py`)
- F&O screeners from MoneyControl and Trendlyne

### Smart Money Flow & Trade Decision Cockpit
- Institutional quant engine (`institutional_quant_engine.py`)
- Smart Money Flow visualization page
- Trade Decision Cockpit: all signals consolidated into a single decision view

### Self-Improving ML Feedback Loop
- **Outcome Resolver** (`outcome_resolver.py`): evaluates signal_outcomes, detects stop-loss hits
- **Reward Engine** (`reward_engine.py`): EMA-smoothed reward/penalty propagation per signal type
- **RL Agent** (`rl_agent.py`): Q-learning meta-controller, state = (regime × sector × score_bucket)
- **Performance Tracker** (`performance_tracker.py`): segments win rates by signal_type, regime, sector
- **ML Ensemble** (`ml_ensemble.py`): GradientBoosting + RandomForest + ExtraTrees + LogisticRegression stacking; calibrated probabilities written to `technical_signals.win_probability`
- **Online Learner** (`online_learner.py`): incremental SGD (40% blend) on rolling 180-day window
- **Strategy Optimizer** (`strategy_optimizer.py`): scipy differential_evolution on CATEGORY_WEIGHTS + SOURCE_WEIGHTS
- **Backtest Optimizer** (`backtest_optimizer.py`): grid search over stop_loss_pct, hold_days, score_threshold
- **Backtester** (`backtester.py`): replays historical signals vs OHLCV; Nifty benchmark; Sharpe/Calmar/Sortino

### Backtesting & Strategy Management
- Full backtest framework with equity curve, trade log, alpha vs Nifty
- Saved strategy configs with parameter versioning
- ML model registry with AUC, accuracy, feature importance

---

## Architecture

| Layer | Technology |
|---|---|
| **Frontend** | React 19 + TypeScript, Vite 6, TailwindCSS 4, Recharts, Framer Motion, Lucide React |
| **Backend** | Express.js + tRPC (type-safe RPC) + SuperJSON, React Query |
| **Database** | SQLite (better-sqlite3, WAL mode) — 25+ tables |
| **Cache** | Redis (ioredis) → in-memory fallback |
| **Background Jobs** | BullMQ on Redis → setInterval fallback |
| **AI (LLM)** | Ollama (local: Mistral/Llama3) → Google Gemini fallback |
| **AI (Sentiment)** | Anthropic Claude Haiku (news re-scoring) |
| **Analytics** | Python 3.10+: pandas, pandas-ta, scikit-learn, yfinance, transformers (FinBERT) |
| **Auth** | Firebase Google OAuth |

---

## Project Structure

```
src/
  App.tsx                        # Main app layout + routing (2000+ lines)
  components/                    # 27 React components
    SmartMoneyFlowPage.tsx        # Institutional flow visualization
    TradeDecisionCockpit.tsx      # Unified trade decision view
    FnOIntelligenceCenter.tsx     # Options chain + F&O signals
    SentimentIntelligence.tsx     # News sentiment dashboard
    NSEStockDiscovery.tsx         # 2000+ stock discovery
    StrategyIntelligence.tsx      # Backtesting + ML performance
    ... (22 more)
  services/
    marketService.ts              # Live stock hook, 5s price polling
    aiService.ts                  # Ollama integration
    geminiService.ts              # Gemini fallback
  data/
    stocklist.ts                  # 180 stocks with multi-provider mappings
    nseStocks.ts                  # 2000+ NSE master list

src/server/
  router.ts                      # 100+ tRPC procedures
  db.ts                          # SQLite schema (25+ tables)
  cacheService.ts                # Redis + in-memory fallback
  liveStockData.ts               # Yahoo Finance batch fetching
  queues.ts                      # BullMQ: stock-refresh, ai-signals, daily-learning-loop, weekly-backtest-optimizer
  newsSentimentService.ts        # News ingestion + Claude AI scoring
  technicalSignalsService.ts     # Technical signal generation + win_probability gating
  quantScoringService.ts         # Quant factor scoring (momentum, quality, value)
  smartMoneyService.ts           # Smart money flow analysis
  optionsMath.ts                 # Options pricing / Greeks
  networkService.ts              # Network resilience utilities
  fnoService.ts                  # F&O signal generation
  optionChainService.ts          # NiftyTrader options chain
  technicalScanner.ts            # 30-min cached scan results
  scoringService.ts              # Python engine invocation
  signalOutcomesService.ts       # Signal accuracy tracking
  ... (20+ more services)

  # Python Engines
  backfill_ohlcv.py              # Historical OHLCV backfill (yfinance)
  technical_analysis_engine.py   # Technical signals generation
  scoring_engine.py              # Multi-factor composite scoring
  finbert_scorer.py              # FinBERT news sentiment
  fii_dii_fetcher.py             # FII/DII daily institutional flow
  pcr_fetcher.py                 # Put/Call ratio from NSE
  institutional_quant_engine.py  # Institutional quant scoring
  performance_tracker.py         # Signal outcome tracking
  outcome_resolver.py            # Stop-loss detection + outcome labeling
  reward_engine.py               # EMA reward/penalty propagation
  rl_agent.py                    # Q-learning meta-controller
  ml_ensemble.py                 # Stacking ensemble (GB+RF+ET+LR)
  online_learner.py              # Incremental SGD online learning
  strategy_optimizer.py          # Differential evolution weight optimizer
  backtester.py                  # Historical signal backtesting
  backtest_optimizer.py          # Grid search for optimal backtest params
  ml_signal_scorer.py            # ML signal scoring utility
```

---

## Database Schema (25+ Tables)

| Table | Purpose |
|---|---|
| `users` | Firebase auth users |
| `watchlist` | Per-user watchlists |
| `nse_stocks` | 2000+ NSE master list |
| `stock_scores` | AI composite scores by timeframe |
| `stock_factor_breakdown` | Domain scores |
| `technical_scans` | 30-min cached scan results |
| `technical_analysis_signals` | RSI, MACD, Bollinger signals |
| `technical_signals` | Daily signals with win_probability (ML gated) |
| `signal_outcomes` | Win/loss outcome tracking |
| `signal_type_stats` | Per-signal-type historical accuracy |
| `signals` | Trading signals (entry/target/SL) |
| `quant_scores` | Quantitative strategy scores (momentum/quality/value) |
| `stock_fundamentals` | Yahoo Finance fundamentals (PE, ROE, D/E, Piotroski) |
| `stock_ohlcv` | Historical OHLC + volume |
| `intraday_ohlcv` | 15-minute intraday bars |
| `fii_dii_flow` | Daily institutional flow |
| `stock_options_oi` | Options OI for PCR |
| `news_articles` | Basic news (legacy) |
| `news_sentiment_items` | Enriched news with FinBERT/Claude scoring |
| `market_sentiment_snapshots` | 15-min market sentiment aggregates |
| `trendlyne_screeners` + `_stocks` | Trendlyne screener data |
| `moneycontrol_screeners` + `_stocks` | MoneyControl screener data |
| `etnow_screeners` + `_stocks` | ETnow screener data |
| `screener_master` | Unified screener metadata + weight overrides |
| `backtest_strategies` | Saved backtest configs |
| `backtesting_runs` | Full backtest results (equity curve, Sharpe, alpha) |
| `recommendation_log` | Full audit trail of every recommendation |
| `strategy_performance` | Segmented win rates by signal_type/sector/regime |
| `screener_weight_history` | Weight optimization history |
| `model_registry` | ML model versioning (AUC, accuracy, features) |
| `feature_importance_log` | Per-model feature importances |
| `signal_type_weights` | EMA-smoothed RL reward weights |
| `rl_q_table` | Q-learning Q(state, action) values |
| `rl_episodes` | RL episode audit trail |
| `app_settings` | Key-value config store |
| `todos` | Implementation ideas / TODOs |

---

## Setup & Installation

### Prerequisites
- **Node.js** v18+
- **Python** 3.10+
- **Redis** (local or remote — optional, falls back to in-memory)
- **Ollama** (optional, for local LLM analysis)

### 1. Clone & Install

```bash
# Node.js dependencies
npm install

# Python analytical libraries
pip install -r requirements.txt
```

### 2. Environment Configuration

Copy `.env` and fill in the required values (see [Environment Variables](#environment-variables)):

```bash
cp .env .env.local
```

### 3. Initialize Database

```bash
npx tsx scratch/init_db.js
```

### 4. Pull Ollama Model (Optional)

```bash
ollama pull mistral
```

---

## Running the Application

### Start Core Services

```bash
# Terminal 1: Redis (if running locally on Windows)
.\redis-server.exe

# Terminal 2: Web app + tRPC server
npm run dev
```

App runs at `http://localhost:3000`.

### Intelligence Pipeline (Run after market close)

```bash
# Daily — run in order after 3:30 PM IST
python src/server/fii_dii_fetcher.py
python src/server/pcr_fetcher.py
python src/server/backfill_ohlcv.py
python src/server/technical_analysis_engine.py
python src/server/finbert_scorer.py --days 1
python src/server/institutional_quant_engine.py
python src/server/scoring_engine.py
python src/server/performance_tracker.py --horizon 15
python src/server/outcome_resolver.py
python src/server/reward_engine.py
python src/server/rl_agent.py
python src/server/online_learner.py --window 180
```

```bash
# Weekly — retrain ML ensemble
python src/server/ml_ensemble.py --train
```

```bash
# Monthly — reoptimize weights and full backtest
python src/server/strategy_optimizer.py
python src/server/backtester.py --start 2023-01-01
python src/server/backtest_optimizer.py
```

### Seed Initial Data (Optional)

```bash
node src/server/seed_news.cjs
```

---

## Environment Variables

Create a `.env` file in the project root:

```env
# ── Server ────────────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development
APP_URL=http://localhost:3000

# ── Database ──────────────────────────────────────────────────────────────────
# SQLite file path (relative to project root)
DATABASE_URL=database.sqlite

# ── Redis (BullMQ + Cache) ────────────────────────────────────────────────────
# Falls back to in-memory cache if Redis is unavailable
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# ── AI — Local LLM (Ollama) ───────────────────────────────────────────────────
OLLAMA_API_URL=http://localhost:11434
OLLAMA_MODEL=mistral                   # Any model pulled via 'ollama pull <model>'

# ── AI — Google Gemini (Ollama fallback) ──────────────────────────────────────
GEMINI_API_KEY=

# ── AI — Anthropic Claude (news sentiment + technical signal insights) ────────
# Used for high-impact news re-scoring and top-N technical signal AI insights
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001   # Default; override for higher quality

# ── Live Price Fallback ───────────────────────────────────────────────────────
FINNHUB_API_KEY=

# ── Alerts (optional) ────────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ── Python Runtime ────────────────────────────────────────────────────────────
# Override if python3 is not on PATH (e.g., Windows: 'python' or full path)
PYTHON_BIN=python3

# ── Trendlyne Screener Polling ────────────────────────────────────────────────
TRENDLYNE_FETCH_INTERVAL_MS=43200000        # 12 hours (default)
TRENDLYNE_SCREENER_NAMES_INTERVAL_MS=86400000  # 24 hours (default)
TRENDLYNE_BASE_DELAY_MS=500
TRENDLYNE_JITTER_PERCENT=15
TRENDLYNE_REQUEST_TIMEOUT_MS=30000
```

---

## tRPC API Reference (Key Endpoints)

| Category | Procedures |
|---|---|
| **Market Data** | `getLiveStocks`, `getLiveStockQuote`, `getLiveQuotesBatch`, `getMarketOverview`, `getAllIndices`, `getGlobalIndices`, `getTopMovers`, `getBreakouts` |
| **Technical** | `getTechnicalDetails`, `getTechnicalScan`, `getTechnicalPredictions`, `getTechnicalTrends`, `getTechnicalSignalsForDate` |
| **Signals** | `getSignals`, `saveSignal`, `getSignalHistory`, `getAccuracyMetrics`, `getSignalTypeWeights` |
| **Scoring** | `getTopRatedStocks`, `enqueueSignals`, `getQueueStats`, `getSignalQualityReport` |
| **Fundamentals** | `getTrendlyneFundamentals`, `getInsights`, `getRatios`, `getShareholding`, `getCorporateActions` |
| **F&O** | `getFnOSignals`, `getOptionChain`, `getFnoSymbols`, `getTrendlyneFnoScanners`, `getMCFnoOverview` |
| **Screeners** | `getMarketScanners`, `getTrendlyneScreenerData`, `getMCScreener`, `getScreenerResults` |
| **News/Sentiment** | `getNewsSentiment`, `getMarketSentimentSnapshot` |
| **Indices** | `getIndexFullDetails`, `getIndexTechnicals`, `getIndexGraph`, `getIndexConstituents`, `getAdvanceDecline` |
| **ML / Backtesting** | `runFullBacktest`, `optimizeScreenerWeights`, `getStrategyPerformance`, `getPerformanceDashboard`, `getMLModelRegistry`, `getFeatureImportance`, `getScreenerWeightHistory` |
| **RL / Rewards** | `getSignalTypeWeights`, `getRLPolicy`, `getRLEpisodeHistory`, `getBacktestOptimization` |
| **User / Watchlist** | `syncUser`, `getWatchlist`, `addToWatchlist`, `removeFromWatchlist` |
| **AI** | `getAIAnalysis`, `getGlobalMarketData` |

---

## ML Model Files

```
src/server/ml_models/
  ensemble.pkl      # Stacking ensemble (GB + RF + ET + LR)
  online_sgd.pkl    # Incremental SGD online model
```

These are generated by `ml_ensemble.py --train` and `online_learner.py`. The model registry in SQLite tracks all versions with AUC, accuracy, and feature importances.

---

*Built for high-conviction Indian equity traders.*
