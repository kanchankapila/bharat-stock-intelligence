# Bharat Stock Intelligence — Claude Instructions

## Memory

At the start of every session, read the memory index before doing any work:

**`C:\Users\amit_\.claude\projects\c--Github-bharat-stock-intelligence\memory\MEMORY.md`**

Then load any memory files that are relevant to the current task. This prevents re-exploring the codebase from scratch and reduces token consumption.

Key memory files:
- `project_architecture.md` — full system overview, tech stack, API strategies, file layout, DB schema, tRPC procedures. Read this before touching any backend or frontend code.
- `nse_stocks_implementation.md` — NSE stock database, search, and sector/industry filtering.
- `ml_feedback_framework.md` — Continuous learning loop: ML engines, RL agent, daily/weekly ops, new DB tables and tRPC endpoints.

## Project Summary (quick reference)

Real-time Indian stock market intelligence platform (NSE/BSE). Backend: Express + tRPC (`src/server/router.ts`, ~2433 lines, 130+ procedures). Frontend: React 19 + Vite (`src/App.tsx`, ~3704 lines). DB: SQLite (`src/server/db.ts`). Cache: Redis → in-memory fallback (`src/server/cacheService.ts`). Background jobs: BullMQ (`src/server/queues.ts`). AI: Ollama primary, Gemini fallback + 15 Python engines.

## Key File Locations

```
src/
  App.tsx                      ← Main app (~3704 lines), layout + all tab routing
  main.tsx                     ← tRPC + React Query setup
  components/                  ← 36+ React components (see list below)
  services/
    marketService.ts           ← Live stock hook, 5s price polling
    aiService.ts               ← Ollama integration
    geminiService.ts           ← Gemini fallback
  lib/
    trpc.ts                    ← tRPC client (httpBatchLink)
    utils.ts                   ← exponentialBackoffWithJitter helper
    candlestickUtils.ts        ← Pattern detection
  data/
    stocklist.ts               ← 180 stocks with multi-provider mappings
    nseStocks.ts               ← 2000+ NSE master list

src/server/
  router.ts                    ← ALL 130+ tRPC procedures
  db.ts                        ← SQLite schema (20+ tables)
  cacheService.ts              ← Redis + in-memory fallback cache
  liveStockData.ts             ← Yahoo Finance batch fetching
  queues.ts                    ← BullMQ job definitions (daily-learning-loop, weekly-backtest-optimizer)
  marketData.ts                ← MoneyControl API calls
  moneycontrolService.ts       ← MC insights (1-hour cache)
  trendlyneService.ts          ← Trendlyne fundamentals
  optionChainService.ts        ← NiftyTrader options chain
  fnoService.ts                ← F&O signal generation
  technicalScanner.ts          ← Technical analysis + candlestick patterns
  scoringService.ts            ← Python engine invocation
  nseService.ts                ← NSE stock DB operations
  topMoversService.ts          ← Top gainers/losers
  globalMarketService.ts       ← Global indices
  stockMapping.ts              ← Symbol resolution across providers
  signals.ts                   ← Signal accuracy tracking

  ── Python Engines ──
  scoring_engine.py            ← Composite AI scorer; loads optimized weights from app_settings
  technical_analysis_engine.py ← Technical indicator computation
  ml_ensemble.py               ← GradientBoosting + RF + ExtraTrees + LR stacked ensemble
  online_learner.py            ← SGD incremental updates (40% SGD / 60% ensemble blend)
  performance_tracker.py       ← Signal outcome evaluation → strategy_performance table
  strategy_optimizer.py        ← scipy differential_evolution on CATEGORY/SOURCE weights
  backtester.py                ← Historical signal replay vs stock_ohlcv; Nifty benchmark
  backtest_optimizer.py        ← Grid search → optimal backtesting params
  outcome_resolver.py          ← STOP_LOSS detection; writes signal outcomes
  reward_engine.py             ← EMA reward/penalty propagation
  rl_agent.py                  ← Q-learning meta-controller (win_probability gating ≥ 0.40)
  ml_signal_scorer.py          ← Standalone signal probability scorer
  fii_dii_fetcher.py           ← FII/DII flow data fetcher
  pcr_fetcher.py               ← Put/Call ratio fetcher
  finbert_scorer.py            ← FinBERT NLP sentiment scoring
  institutional_quant_engine.py← Institutional flow quant analysis
  nlp_engine.py                ← NLP pipeline for news/events
  backfill_ohlcv.py            ← Historical OHLCV backfill
  tv_bridge.py                 ← TradingView bridge
```

## Frontend Tabs / Navigation

App.tsx routes to these tabs: `dashboard`, `trade-cockpit`, `top-rated`, `indices`, `market-map`, `screener`, `fno-scanners`, `smart-money`, `trendlyne`, `discover`, `backtest`, `portfolio`, `watchlist`, `signals`, `sentiment`, `economics`, `strategy`, `todo`.

## React Components (`src/components/`)

`AlertsToast`, `AppShell`, `Card`, `DailySignals`, `DashboardPage`, `FnOHeatmap`, `FnOIntelligenceCenter`, `GlobalMarketCards`, `GlobalMarkets`, `IndexDetailPage`, `IndexFnoOverview`, `IndicesPage`, `IntradayBreakouts`, `InvestmentStrategy`, `MCCommon`, `MCIndexDetailPanel`, `MCStockInfoPanel`, `MarketIndices`, `MarketInsights`, `MomentumIntelligence`, `NSEStockDiscovery`, `OptionsIntelligence`, `PortfolioAnalytics`, `ScreenerDetailsModal`, `SectorIntelligence`, `SentimentIntelligence`, `StrategyBuilder`, `StrategyIntelligence`, `SuperstarPortfolio`, `ToDoPage`, `TopMoversIntelligence`, `TopRatedStocks`, `TradingViewWidgets`, `TrendlyneScreenerPanel`, `TrendlyneSectorDashboard`, `Watchlist`

## SQLite Schema (20+ Tables)

| Table | Purpose |
|---|---|
| `users` | Firebase auth users |
| `watchlist` | Per-user stock watchlists |
| `nse_stocks` | Master stock list (2000+ stocks) |
| `stock_scores` | AI composite scores by timeframe |
| `stock_factor_breakdown` | Domain scores (technical, fundamental, momentum) |
| `technical_scans` | 30-min cached scan results |
| `technical_analysis_signals` | RSI, MACD, Bollinger signals with `win_probability` |
| `signals` | Trading signals (entry/target/SL) |
| `trendlyne_screeners` + `_stocks` | Trendlyne screener data |
| `moneycontrol_screeners` + `_stocks` | MC screener data |
| `etnow_screeners` + `_stocks` | ETnow screener data |
| `screener_master` | Unified screener metadata + `weight_override` |
| `backtest_strategies` | Saved backtest configs |
| `stock_ohlcv` | Historical OHLC + volume |
| `app_settings` | Key-value config (stores `optimal_category_weights`, `optimal_source_weights`) |
| `recommendation_log` | Full audit: entry/SL/target/confidence/outcome |
| `strategy_performance` | Segmented metrics (signal_type\|sector\|regime\|score_bucket) |
| `screener_weight_history` | Snapshots of weights after each optimization run |
| `model_registry` | ML model versioning: AUC, accuracy, feature count, is_active |
| `feature_importance_log` | Per-model feature importances keyed to model_registry.id |
| `backtesting_runs` | Full backtest results: equity curve, trade log, Sharpe, alpha |
| `signal_type_weights` | Per-signal-type scoring weights |
| `rl_q_table` | Q-learning Q-values |
| `rl_episodes` | RL episode history |

## tRPC Procedure Categories (`router.ts`)

- **Market data**: `getLiveStocks`, `getLiveStockQuote`, `getLiveQuotesBatch`, `getMarketOverview`, `getAllIndices`, `getGlobalIndices`, `getGlobalMarketData`, `getTopMovers`, `getBreakouts`
- **Technical**: `getTechnicalDetails`, `getTechnicalScan`, `getTechnicalPredictions`, `getTechnicalTrends`, `getTechnicalSignals`, `getTechnicalSignalsStatus`, `runTechnicalSignalScan`, `getSectorSignalStats`, `getSignalWinRates`, `getSignalDates`, `getSignalTypeStats`, `computeSignalOutcomes`, `computeSignalTypeStats`, `getTvTa`, `getTvScreener`
- **Scoring/Signals**: `getTopRatedStocks`, `getStockScoreDetail`, `triggerStockScoring`, `recalculateScoresOnly`, `runQuantScoring`, `getQuantScoringStatus`, `getQuantScore`, `getStrategyStocks`, `getSignals`, `saveSignal`, `getSignalHistory`, `getAccuracyMetrics`, `enqueueSignals`, `getQueueStats`
- **ML / Feedback Loop**: `getStrategyPerformance`, `getPerformanceDashboard`, `getMLModelRegistry`, `getFeatureImportance`, `getScreenerWeightHistory`, `getSignalQualityReport`, `runFullBacktest`, `optimizeScreenerWeights`, `getSignalTypeWeights`, `getRLPolicy`, `getRLEpisodeHistory`, `getBacktestOptimization`
- **Fundamentals**: `getTrendlyneFundamentals`, `getInsights`, `getStockInsights`, `getRatios`, `getShareholding`, `getCorporateActions`, `getStockFundamentals`, `getMFInvestments`, `getFundamentalsStatus`, `triggerFundamentalsSync`
- **MoneyControl deep-dive**: `getMcConsolidated`, `getMcTechnical`, `getMcEquityCash`, `getMcSwot`, `getMcEssentials`, `getMcInsights`, `getMcDetailedInsights`, `getMcPriceVolume`, `getMcAnalystRating`, `getMcEarningsForecast`, `getMcPriceForecast`, `getMcConsensus`
- **Trendlyne**: `getTrendlyneSwot`, `getTrendlyneChecklist`, `getTrendlyneDVM`, `getTrendlyneStockMetrics`, `getTrendlyneAdvTechnicalAnalysis`, `getTrendlyneOverview`, `getTrendlyneSectorRotation`, `getTrendlyneIndexRotation`, `getTrendlyneScreener`, `getTrendlyneCategories`, `getTrendlyneScreenerNames`, `getTrendlyneFnoScanners`, `getTrendlyneFnoHeatmap`, `getTrendingScreeners`, `fetchTrendlyneScreenerNames`, `refreshTrendlyneScreenersDB`, `recategorizeTrendlyneScreeners`, `configTrendlyneFetchInterval`, `testTrendlyneApi`
- **F&O**: `getFnOSignals`, `getOptionChain`, `getFnoSymbols`, `getMCFnoOverview`, `getTrendlyneFnoScanners`, `getTrendlyneFnoHeatmap`
- **Screeners**: `getMarketScanners`, `fetchMarketData`, `getScreenerResults`, `getStockScreeners`, `getETStats`, `getETPennyStocks`
- **Indices**: `getIndexFullDetails`, `getIndexFullData`, `getIndexDetails`, `getIndexTechnicals`, `getIndexGraph`, `getIndexConstituents`, `getIndexPriceFeed`, `getAdvanceDecline`, `getIndexPeChart`, `getIndexPbChart`, `getIndexStocksList`, `getIndicesList`, `getIndexMapping`
- **Stock discovery / NSE**: `getStockList`, `getStockDetailsMap`, `getStocks`, `getSectorPerformance`, `getAllNSEStocks`, `searchNSEStocks`, `getNSEStockBySymbol`, `getNSEStocksBySector`, `getNSEStocksByIndustry`, `getAllSectors`, `getAllIndustries`, `getNSEStockCount`, `syncNSEStocks`, `getAlphaQuantDetail`
- **Sentiment / News**: `getMarketSentiment`, `getNewsItems`, `getSectorNewsSentiment`, `getCorporateEventNews`, `getInstitutionalFlows`, `refreshNewsSentiment`, `getFiiDiiFlow`, `generateTrendReport`
- **Backtesting**: `saveBacktestStrategy`, `getBacktestStrategies`, `runBacktest`, `runFullBacktest`, `getBacktestOptimization`
- **User / Watchlist**: `syncUser`, `getWatchlist`, `getWatchlistDetails`, `addToWatchlist`, `removeFromWatchlist`
- **AI**: `getAIAnalysis`, `getGlobalMarketData`
- **ToDo**: `getTodos`, `addTodo`, `updateTodo`, `deleteTodo`
- **Market map**: `getMarketMapData`
- **Other**: `getOHLCData`, `getMcConsolidated`, `getIndexFullData`

## ML Continuous Learning System

The platform has a full self-improving feedback loop:

**Daily ops** (run after market close):
```
python fii_dii_fetcher.py
python pcr_fetcher.py
python finbert_scorer.py --days 1
python institutional_quant_engine.py
python performance_tracker.py --horizon 15
python online_learner.py --window 180
```

**Weekly/Monthly:**
```
python ml_ensemble.py --train         # retrain stacking ensemble
python strategy_optimizer.py          # reoptimize CATEGORY/SOURCE weights
python backtester.py --start 2023-01-01
```

**RL Agent:** `rl_agent.py` is a Q-learning meta-controller. `scoring_engine.py` gates signal output to `win_probability >= 0.40`. Weights learned by `strategy_optimizer.py` are persisted in `app_settings` (`optimal_category_weights`, `optimal_source_weights`) and loaded at scoring engine startup.

**ML model artifacts:** `src/server/ml_models/ensemble.pkl`, `src/server/ml_models/online_sgd.pkl` — generated at runtime by `ml_ensemble.py` and `online_learner.py`; directory is created on first training run.

## Ticker Resolution Strategy

> **Read this before onboarding any new data provider or URL.**

### Canonical Identifier

The **NSE symbol** (e.g., `HDFCBANK`, `INFY`, `BAJAJ-AUTO`) is the single source of truth across the entire platform. All provider-specific IDs are derived from it, never the reverse.

### Provider ID Map

| Provider | ID field in `StockMapping` | Format | Example |
|---|---|---|---|
| NSE / internal | `symbol` | Uppercase ticker | `HDFCBANK` |
| Yahoo Finance | _(derived)_ | `symbol + ".NS"` | `HDFCBANK.NS` |
| MoneyControl | `mcsymbol` | Opaque short code | `HDF01` |
| Trendlyne | `tlid` / `tlname` | Numeric string / kebab slug | `533` / `hdfc-bank-ltd` |
| ET / ETnow | `companyid` | Numeric string | `9195` |
| ISIN (universal) | `isin` | 12-char alphanumeric | `INE040A01034` |
| MoneyControl stockid | `stockid` | Numeric string | `592009` |

### Resolution Files

- **`src/data/stocklist.ts`** — authoritative mapping table for 180 liquid stocks; holds all provider fields. Always preferred.
- **`src/data/nseStocks.ts`** — master list of 2000+ NSE stocks; NSE symbol + basic info only, no provider mappings.
- **`src/server/stockMapping.ts`** — lookup functions; `stocklist.ts` takes precedence over `nseStocks.ts`.

### Resolution Order (for any new provider)

1. **`stocklist.ts` first** — call `getStockMapping(nseTicker)` to get the full `StockMapping` object and read the provider's field directly.
2. **Provider autocomplete API second** — if the stock is not in the 180-stock list, call the provider's search/autocomplete endpoint with the NSE symbol and cache the result in the `scIdCache` pattern already used for MoneyControl.
3. **ISIN as fallback** — if the provider accepts ISIN, it is universally available from `StockMapping.isin` for all 180 stocks.
4. **Never guess** — do not construct provider IDs by convention. Each provider's ID scheme is opaque and must be resolved explicitly.

### Adding a New Provider

When integrating a new data source (new URL, new API endpoint):

1. **Identify the provider's ID type** — look at its API docs/response to find what it uses to identify a stock (symbol, ISIN, internal ID, slug).
2. **Add a field to `StockMapping`** in `src/data/stocklist.ts` if the provider has its own opaque ID not derivable from existing fields.
3. **Populate mappings for the 180 stocks** in `stocklist.ts` before writing any fetch logic.
4. **Add a resolver function** in `src/server/stockMapping.ts` following the `resolveMoneycontrolSymbol` pattern: hardcoded map first → in-memory cache → provider autocomplete API fallback.
5. **For Yahoo Finance-style providers** — if the provider accepts `symbol.NS` or `symbol.BO` suffix conventions, derive it inline without adding a new field.
6. **Cache the resolved ID** — use `Map<string, string>` keyed on the uppercase NSE symbol, populated on first resolution.

### Index Resolution

Indices use a separate `indexData` array in `src/server/stockMapping.ts` with `{ symbol, name, id }` tuples. Provider IDs for indices (e.g., MoneyControl `id` field) are stored there, not in `StockMapping`. Follow the same lookup-first pattern via `getIndexMapping(query)` before calling any index API.

## API Calling Strategies

- **Cache**: Redis first → in-memory Map fallback. TTLs: live stocks 5 min, insights 1 hr, technical 30 min.
- **Batching**: Yahoo Finance 50 symbols/batch, 8 concurrent batches. tRPC `httpBatchLink` groups frontend calls.
- **Polling**: BullMQ repeatable job every 5 min. Accuracy tracking every 30 s. Screener sync every 12 hr.
- **Resilience**: `AbortSignal.timeout(10000)`, exponential backoff+jitter, Gemini fallback, setInterval fallback if Redis down.
- **Symbol resolution**: See **Ticker Resolution Strategy** section above. `stocklist.ts` (180 stocks) takes precedence over `nseStocks.ts` (2000+ stocks).

## General Rules

- Read memory before exploring files — it already maps the codebase.
- All backend endpoints are in `src/server/router.ts`. Check there before searching elsewhere.
- Symbol mappings live in `src/data/stocklist.ts` (180 stocks) and `src/data/nseStocks.ts` (2000+ stocks).
- Do not add comments unless the WHY is non-obvious.
- Do not add error handling for impossible scenarios.
- Do not refactor beyond what the task requires.
