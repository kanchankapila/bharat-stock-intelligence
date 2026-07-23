# Bharat Stock Intelligence — Claude Instructions

## Reasoning Discipline (MANDATORY — read first)

**Read and follow `fable-brain.md` (project root) on every task.** It defines the standing operating procedures for reading intent, problem decomposition, effort placement, verification, known-vs-guessed labeling, self-attack, completeness, refusing to guess, delivery format, and the fake-competence patterns to avoid — plus a final gate checklist that must pass before sending any answer.

## Knowledge Graph (use this before reading files)

A persistent graphify knowledge graph lives at `graphify-out/graph.json`. **Before reading any source file to answer a question about the codebase, query the graph first:**

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -m graphify query "<your question here>"
```

Or for targeted lookups:
```powershell
& $PY -m graphify path "ComponentA" "ServiceB"   # shortest path between two concepts
& $PY -m graphify explain "SymbolName"            # plain-language explanation of a node
```

The graph has **2,418 nodes** and **4,269 edges** across 159 labelled communities (TradingView Widgets, Cache Service, NSE Stocks Data Layer, ML Ensemble, RL Agent, Screener Intelligence, etc.). God nodes: `cn()` (121 edges), `trpc` (60), `mcFetchJson()` (57), `db` (52), `getStockMapping()` (39).

**Update the graph when files change significantly:**
```powershell
& $PY -m graphify update .   # re-extracts only changed files
```

## Memory

At the start of every session, read the memory index before doing any work:

**`C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\MEMORY.md`**

Then load any memory files that are relevant to the current task. This prevents re-exploring the codebase from scratch and reduces token consumption.

Key memory files:
- `project_architecture.md` — full system overview, tech stack, API strategies, file layout, DB schema, tRPC procedures. Read this before touching any backend or frontend code.
- `nse_stocks_implementation.md` — NSE stock database, search, and sector/industry filtering.
- `ml_feedback_framework.md` — Continuous learning loop: ML engines, RL agent, daily/weekly ops, DB tables, and tRPC endpoints.

## Project Summary (quick reference)

Real-time Indian stock market intelligence platform (NSE/BSE). Backend: Express + tRPC (`src/server/router.ts`, ~2770 lines, 130+ procedures). Frontend: React 19 + Vite (`src/App.tsx`, ~3704 lines). DB: **PostgreSQL/TimescaleDB** live (`USE_POSTGRES=true`, :5433) via the `dbAsync`→`pgClient` facade; `src/server/db.ts` is the SQLite-flavored schema-of-record + dev fallback. Cache: Redis → in-memory fallback (`src/server/cacheService.ts`). Background jobs: BullMQ (`src/server/queues.ts`). AI: Ollama primary, Gemini fallback + 15 Python engines.

## Key File Locations

```
src/
  App.tsx                      ← Main app (~3704 lines), layout + all tab routing
  main.tsx                     ← tRPC + React Query setup
  components/                  ← 36+ React components
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
  router.ts                    ← ALL 130+ tRPC procedures (~2770 lines)
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
  pcr_fetcher.py               ← Put/Call ratio fetcher (also captures ATM IV + skew → stock_options_oi)
  iv_features.py               ← IV-rank/skew feature engine (stock_options_oi → technical_signals)
  exit_labeler.py              ← Path-based exit labels: MFE/MAE/trailing-exit → signal_excursions
  fundamentals_snapshot.py     ← Daily point-in-time snapshot of stock_fundamentals → fundamentals_history
  relative_strength.py         ← Cross-sectional RS-rank engine (stock_ohlcv → technical_signals)
  ownership_relative.py        ← Cross-sectional MF-flow engine (sector-relative + universe rank → technical_signals)
  exit_policy.py               ← Exit-policy head: MFE/MAE regressors on signal_excursions → target/stop levels
  finbert_scorer.py            ← FinBERT NLP sentiment scoring
  institutional_quant_engine.py← Institutional flow quant analysis
  nlp_engine.py                ← NLP pipeline for news/events
  backfill_ohlcv.py            ← Historical OHLCV backfill
  tv_bridge.py                 ← TradingView bridge
```

## Frontend Tabs / Navigation

`App.tsx` routes to these tabs: `dashboard`, `trade-cockpit`, `top-rated`, `indices`, `market-map`, `screener`, `fno-scanners`, `smart-money`, `trendlyne`, `discover`, `backtest`, `portfolio`, `watchlist`, `signals`, `sentiment`, `economics`, `strategy`, `todo`.

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
python fundamentals_snapshot.py        # point-in-time fundamentals → fundamentals_history
python fii_dii_fetcher.py
python pcr_fetcher.py
python iv_features.py                  # ATM IV → iv_rank/iv_skew (after pcr_fetcher)
python relative_strength.py            # cross-sectional RS ranks → technical_signals
python ownership_relative.py           # sector-relative + universe-rank of MF net flow → technical_signals
python finbert_scorer.py --days 1
python institutional_quant_engine.py
python performance_tracker.py --horizon 15
python exit_labeler.py                 # MFE/MAE/trailing-exit labels → signal_excursions
python online_learner.py --window 180
```

**Weekly/Monthly:**
```
python ml_ensemble.py --train         # retrain stacking ensemble
python exit_policy.py --train         # retrain MFE/MAE exit-policy regressors (signal_excursions)
python strategy_optimizer.py          # reoptimize CATEGORY/SOURCE weights
python backtester.py --start 2023-01-01
```

**RL Agent:** `rl_agent.py` is a Q-learning meta-controller. `scoring_engine.py` gates signal output to `win_probability >= 0.40`. Weights learned by `strategy_optimizer.py` are persisted in `app_settings` (`optimal_category_weights`, `optimal_source_weights`) and loaded at scoring engine startup.

**ML model artifacts:** `src/server/ml_models/ensemble.pkl`, `src/server/ml_models/online_sgd.pkl` — generated at runtime by `ml_ensemble.py` and `online_learner.py`; directory is created on first training run.

## Scoring Authority & Signal Model (canonical — Phase 2 governance)

**Scoring authority.** There are three score producers; do not invent a fourth. The canonical
cross-source ranking is `unified_recommendations`, produced by `unified_ranker.py` (scheduled via
`QUEUE_UNIFIED_RANKER`). It sits *downstream* of the component producers and is what new
ranking/UI surfaces should read:

| Producer | Writes | Role |
|---|---|---|
| `scoring_engine.py` | `stock_scores` + `stock_factor_breakdown` | screener/news composite (per timeframe) |
| `quantScoringService` / quant engines | `quant_scores` | momentum/quality/value/composite ranks |
| `unified_ranker.py` | **`unified_recommendations`** | **canonical** — merges the above + screener confluence |

Legacy direct reads still exist (`getTopRatedStocks`→`stock_scores`, `getStrategyStocks`→`quant_scores`);
**rerouting those UI reads onto `unified_recommendations` is deferred to Phase 3** (behavioral change,
done with the frontend during the Postgres migration). Until then, treat `unified_recommendations`
as authoritative and have any new engine write a *component* score that the ranker ingests — never a
parallel "final" score.

**Signal model.** Six overlapping signal tables exist today (`signals`, `unified_signals`,
`technical_signals`, `technical_analysis_signals`, + outcomes `signal_outcomes` /
`unified_signal_outcomes`). All are load-bearing (many consumers across `router.ts` + Python).
**Phase 3 target:** collapse to `unified_signals` + one outcome table, performed *during* the
Postgres/Timescale rewrite so each consumer is migrated exactly once. Do not add new signal tables.

## Ticker Resolution Strategy

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
- **Polling**: Live stock prices refresh every 5 min via a `setInterval` in `liveStockData.ts` (not a BullMQ job — the BullMQ `stock-refresh` queue is the once-daily 4 PM IST OHLCV persist, confusingly named). Intraday-cadence BullMQ jobs (regime/breadth/screener scans) run every 15-30 min, market-hours-gated. MC/ETNow screener syncs run once/day (post-close). See [job_frequency_audit_2026_07_17.md] memory for the full cadence audit.
- **Resilience**: `AbortSignal.timeout(10000)`, exponential backoff+jitter, Gemini fallback, setInterval fallback if Redis down.
- **Symbol resolution**: See **Ticker Resolution Strategy** section above. `stocklist.ts` (180 stocks) takes precedence over `nseStocks.ts` (2000+ stocks).

## General Rules

- **Active Skills**: Enforce [claude-mem](file:///.agents/skills/claude-mem/SKILL.md) for persistent state, [headroom](file:///.agents/skills/headroom/SKILL.md) for token budgeting, and [codebase](file:///.agents/skills/codebase/SKILL.md) for repo navigation.
- Read memory before exploring files — it already maps the codebase.
- All backend endpoints are in `src/server/router.ts`. Check there before searching elsewhere.
- Symbol mappings live in `src/data/stocklist.ts` (180 stocks) and `src/data/nseStocks.ts` (2000+ stocks).
- Do not add comments unless the WHY is non-obvious.
- Do not add error handling for impossible scenarios.
- **Every change and every lesson learned from a mistake must be captured in this file before the session ends.** Append it to "Recent session notes" below — a bug fix, a corrected wrong assumption, a new framework/mechanism added, a root cause found. If it changed the codebase or changed what a future session should know, it goes here; do not let this doc drift from what actually happened. Silence here means a future session re-discovers the same thing from scratch or repeats the same mistake.

## Recent session notes

- Fixed a tRPC router merge conflict by renaming `agentsRouter.getStrategyPicks` to `agentsRouter.getAgentStrategyPicks` and updating `src/components/AgentStrategistPage.tsx`.
- Enhanced custom screener filtering in `src/server/routers/screeners.router.ts` to honor `minMktCap`, `sector`, and normalized market cap parsing.
- Verified the dev server starts successfully on `http://localhost:3000` after freeing a stale `node.exe` process using port 3000.
- Do not refactor beyond what the task requires.
- Built full RAG chatbot: `src/server/chatbot/` (FastAPI port 8001) with LangGraph 3-node agent (classify_intent→execute_tools→synthesize_answer), ChromaDB vector store (2366 stock profiles + 1521 screeners + 1000 news articles), 6 tools (sql, price, news, screener, web), Ollama auto-detect + Gemini fallback. React UI at `src/components/StockChatbot.tsx` routed at `/chat`. Nav item "AI Chat" in AppShell Tools group. Start with `npm run chatbot` (uvicorn on port 8001).
- stock_scores staleness root cause: processStockScoring in queues.ts returned {success:false} instead of throwing, so BullMQ silently marked scoring as 'completed' for weeks. Fixed to throw on failure. Primary cause: backend-python/main.py (AlphaQuant service) not running on port 8002 — start it with PYTHON_PORT=8002 (or ensure npm start loads .env before spawning the Python process).
- **ML Ensemble Accuracy Upgrades**: Upgraded `ml_ensemble.py` by integrating `CatBoostClassifier` into the stacking base, introducing Bayesian hyperparameter tuning via `optuna` (--tune flag), and adding daily cross-sectional rank-scaling. Improved purged-OOF AUC from `0.7013` to `0.7568` (+5.5% lift!) and accuracy from `68.3%` to `72.0%` (+3.7% lift!).
- **Option Expiries & Greeks Sync**: Fixed empty `nt_fno_expiry` issue by adding `sync_fno_expiries()` to `sync_nt_fno_symbols.py`, allowing the options scraper to correctly resolve monthly/weekly expiry dates. Resolved PostgreSQL schema issue in `stock_option_features` by adding the missing `atm_iv` column.
- **Broker Recommendations Timeout**: Resolved MC network timeout by paging the broker recommendations endpoint with a limit of 100 up to 15 pages in `mc_broker_reco_fetcher.py`.
- **Insider Promoter Transactions**: Fixed NSE PIT filings parsing bugs in `insider_transactions_fetcher.py` (added `acqName` fallback, parsed dates containing space/time suffixes, and replaced raw `%s` parameters with `?` to let `db_compat` handle translation).
- **MoneyControl Estimates & Ratings**: Fixed analyst estimates, ratings, and forecasts scraping by parameterizing MoneyControl URLs (removing invalid `ex=N` query parameter and correcting subpaths) and updating success status checks to check for `success=1` instead of `status=200`.
- **Credit Rating Events Scraper**: Fixed 3 crash bugs in `credit_rating_fetcher.py` (resolved ISIN mapping fallback, corrected date format parsing, and bypassed BSE redirect locks).
- **Signal-quality root cause (2026-07-10)**: the prediction layer has edge (dense `signal_outcomes` h5 ≈55% WIN, CV AUC ~0.75) but the *emitted* trade-signal layer destroyed it (~76% NEUTRAL, decisive WIN ≈2.5%) because entry/target/stop geometry was wrong — AI signals stored the LLM's hallucinated levels. Fixed via `src/server/atrBarriers.ts` (2.5×ATR target / 1.5×ATR stop off the model's entry, from last 30 non-suspect bars); `processAISignal` now overrides LLM levels. Also added `is_plausible_return()` (>100% moves → NEUTRAL/`SUSPECT_DATA`) so ~48 sustained wrong-level series stop poisoning learned weights.
- **KEY FINDING — deployed `win_probability` has no live edge outside BEAR**: live per-regime AUC BULL ≈0.50 / SIDEWAYS ≈0.49 / BEAR 0.613. The 0.75 is training-CV; it doesn't survive deployment in the dominant regimes → gating emission on calibrated win-prob is not viable yet. Revisit after the deployed probability's discrimination improves.
- **Breakout classifier (Lever #4) — the one signal with real edge**: `src/server/breakout_classifier.py` learns cross-sectional P(≥6% up-move in 10 trading days) from forward OHLCV (no selection bias). Honest 5yr purged-OOF AUC 0.6138, top-decile 1.47× base. Single LightGBM, full-universe, **advisory-only** (writes `technical_signals.breakout_probability`; nothing ranks/sizes on it yet). Purge the 10-day forward label by DATE + 10-day embargo, never by row (row-purge leaked → fantasy 0.73–0.82).
- **MC deep-history OHLCV backfill**: `mc_ohlcv_backfill.py` pulled 26yr split-adjusted daily bars per raw NSE symbol; `stock_ohlcv` 654k→2.57M rows (to 2021). Enables the 5yr breakout validation + full-universe `technical_signals` grid (26→2184/day).
- **Job reliability**: `ml-daily-ops`/`weekly-retrain` made fault-tolerant (per-step `.catch`, 518854f); BullMQ `lockDuration` stall fixes (a02d937); Redis consolidated to a single Docker broker; unified-ranker moved to 07:30 IST pre-open (was building on stale inputs). Full 95-script job sweep 2026-07-11: 67 PASS, 5 fetcher bugs fixed, Nifty GEX rewired to NiftyTrader (MC OI endpoint 404s). `backend-python/app/` consolidated 24→4 files.
- **Docs refreshed 2026-07-11**: `ACTION_ITEMS.md`, `docs/FETCHER_HEALTH_TRACKER.md`, `docs/DATA_GAP_MANIFEST.md`, `README.md` (dropped `signals` table, ~126 tables now); `docs/codebase_review_report.md` is a dead Bedrock run → now a redirect to `docs/superpowers/plans/audit-findings/synthesis.md`.
- **Continuous data-quality testing framework (2026-07-19)**: added `src/server/dataQualityChecks.ts` — ~24 freshness/coverage/range/plausibility checks against the tables the fetchers above write (OHLCV, technical_signals, unified_recommendations, quant_scores, stock_options_oi, fii_dii_flow, signal_outcomes, market_regimes, fundamentals, etc.), closing the gap where a fetcher exiting 0 while writing wrong/empty/stuck data was invisible to job-run monitoring (`jobHeartbeat`/`jobWatchdog`/`MONITOR_SCRIPTS` only know a job *ran*, not that it wrote correct data). Wired into the existing Telegram watchdog (`checkAndAlertDataQuality` in `jobWatchdog.ts`, 15-min poll) and daily digest; `npm run dq:check` for on-demand runs. One check initially used a guessed `stock_scores.timeframe = 'swing'` value that appears nowhere in the codebase (real values: `long_term`/`intraday`/`short`, verified via grep) — would have permanently false-alarmed as a critical failure; corrected to `long_term`, the value `getTopRatedStocks`/`unified_ranker.py` actually read.
- **Regression-test backfill for FETCHER_HEALTH_TRACKER.md fixes (2026-07-19)**: cross-referencing that tracker's fixed-bug list against the existing test suite found 6 documented, fixed bugs with no persisted regression test — each was verified once by hand during its fix session and never locked in, so a regression there would only resurface via the next manual audit. Added `src/server/tests/test_{asm_gsm_fetcher,mc_corporate_calendar_fetcher,credit_rating_fetcher,insider_transactions_fetcher,eps_surprise_fetcher,market_regime_fetcher}.py` (51 tests, all verified against actual runtime behavior, not just source reading), each asserting the exact previously-fixed failure mode — e.g. `upsert_flags(None, None)` must never touch the DB (None ≠ a real empty result); NSE's `NOTLISTED`/`NOT APPLICABLE`/`NA` sentinels must all resolve via the ISIN fallback map; a malformed `ex_date` must be skipped per-symbol, not crash the whole run; the NiftyTrader basis fallback must read `resultData.indices`/`last_trade_price`, not the old `resultData.data`/`futPrice` shape.
- **Documentation-discipline rule added (2026-07-19)**: added a General Rules bullet mandating that every change and every lesson learned from a mistake gets appended here before a session ends — this file must never drift from what actually happened, so a future session doesn't re-discover the same thing or repeat the same mistake.
- **Merged data-quality framework into main + reconciled a pre-existing test break (2026-07-21)**: PR #11 conflicted with main's independent rewrite of `buildDailyDigest` (jobWatchdog.ts) into an incremental "needs attention / changed / unchanged" digest — merged both, and fixed a real bug the conflict surfaced: `buildDailyDigest` was re-running all 24 data-quality checks (with their own DB writes) on every digest build instead of reading what `checkAndAlertDataQuality`'s 15-min poll already persisted; added `getLatestDataQualityResults()` in `dataQualityChecks.ts` so the digest reads instead of recomputes. Separately, `jobRegistryVsMonitorScripts.test.ts` was already failing on main (unrelated to this PR) — 11 `JOB_REGISTRY` entries (the `ml-daily-ops`/`ml-weekly-retrain` StepTracker sub-steps in `jobRegistry.ts`, e.g. `fii-dii-fetcher`) share an id with an existing `MONITOR_SCRIPTS` entry. Traced before touching: two independently-built, non-conflicting monitoring paths for the same script (job_heartbeat via StepTracker vs. DB-table freshness via `monitor.router.ts`, confirmed the latter never calls `recordHeartbeat`) — redundant but not corrupting, so kept both and updated the test to an explicit documented allowlist instead of renaming/removing either side.
- **CI fix post-merge (2026-07-21)**: PR #11 merged with `python-tests` red on `main` from a pre-existing, unrelated bug — `trendlyne_overview_fetcher.backfill_technical_signals()` gained a `today: str` positional param (between `symbol` and `profile`) as part of the look-ahead-bias fixes, but `test_trendlyne_overview_fetcher.py`'s call site was never updated to pass it. Confirmed the source change was correct (real call site in `run()` already passes `today = date.today().isoformat()`) and only the test was stale; fixed the test call rather than the function.
- **`date('now')` → `::text` fix was column-type-blind and broke 4 more call sites (2026-07-22/23)**: an in-progress fix made `sqlTranslate.ts`'s `date('now'[,'mod'])` mapping emit `::text` (needed because most `date`/`as_of_date`/`signal_date` columns are TEXT, migrated from SQLite — compared against unenclosed `current_date` they threw `operator does not exist: text >= date`). But `stock_ohlcv.date` and `feature_store.date` are native Postgres `DATE` (not TEXT — check `db/schema.postgres.sql` or `information_schema.columns` per table, never assume from `db.ts`'s SQLite-schema-of-record, which shows everything as TEXT), so the same fix flipped their `operator does not exist` error from `text >= date` to `date >= text`. Fixed 3 checks in [dataQualityChecks.ts](src/server/dataQualityChecks.ts) by casting the DATE column side to `::text` too (`date::text >= date('now',...)`). Also found (via `pm2 logs`, not the digest) the identical class of bug against `TIMESTAMPTZ` columns: `confluence_signals.computed_at` ([ml.router.ts](src/server/routers/ml.router.ts) `getSignalReportCard`), `deep_learning_predictions.created_at` ([monitor.router.ts](src/server/routers/monitor.router.ts) `getScriptStats` — this was the live `[MONITOR] getScriptStats failed: operator does not exist: date = text` recurring every ~15min in prod logs), and `agent_strategy_picks.run_date` (TEXT, but doubly-cast via `date(run_date)::text` for consistency) in `processAgentStrategist` ([queues.ts:1209](src/server/queues.ts:1209)) — same `date(col)::text` pattern applied to all. Also caught (via diff review, not yet an observed error) a second latent bug from the same in-progress fix: `technicalSignalsService.ts`'s `unified_signals` upsert had been changed from `date('now')` to raw `now()` to dodge the TEXT-into-TIMESTAMPTZ insert error — but `now()` is full-precision, and the table's `UNIQUE(symbol, signal_source, signal_type, signal_date)` + every other caller of `upsertUnifiedSignal` (`signals.ts`, `trendlyneScreener.ts`, `queues.ts`, `signals.router.ts`) all assume day-grain `signal_date` for the ON CONFLICT upsert to dedupe correctly; `now()` would have made every 30-min technical-scan cycle insert a fresh row instead of updating the day's row. Fixed to `current_date` (day-grain, implicitly assignment-casts into TIMESTAMPTZ, and is a valid bare keyword in SQLite too — unlike the PG-only `::type` cast syntax, which only survives on the SQLite fallback path via `stripPgCasts`/`sqSql` in `dbAsync.ts`). Lesson: a blanket regex-based SQL translation fix keyed only on the literal-side syntax (`date('now')`) can't be correct for every callsite when the *column* side's type varies (TEXT vs DATE vs TIMESTAMPTZ) across tables that all use the same "SQLite-compatible source, translated for Postgres" pattern — each callsite needs its column type checked (`information_schema.columns`, since `db/schema.postgres.sql` can also drift from what's actually live) rather than trusting the translator to be universally correct. Verified all fixes directly against the live Postgres DB (temp `tsx -r dotenv/config` scripts importing the real service functions, not just `tsc`/`vitest`) before restarting `pm2 bharat-server` (which does NOT hot-reload `.ts` — see `pm2_restart_required.md` memory) to deploy.
- **Python subprocess slot-leak (root cause of the 2026-07-22 cascade of "late"/"stale" jobs in the daily digest)**: already root-caused and fixed in commit `42fb988` (process-tree kill via `taskkill /T /F` + hard grace-period force-settle) plus further uncommitted work found in-progress this session: a `pythonRunner.ts` watchdog that force-resets the `_runningPython` counter if it's stuck over the concurrency cap for >100min (self-heals without a manual restart), and DEVNULL-redirecting stdio in `daily_ml_update.py`/`dl_trainer.py`/`feature_engineering.py`'s subprocess/ProcessPoolExecutor spawns (grandchildren otherwise inherit Node's pipe handles and keep them open after a `taskkill /T /F`, so the pipe's `close` event never fires and the slot never releases). Confirmed via live `pm2 logs`: `ohlcv_quality`/`relative_strength`/`ownership_relative`/`CONFLUENCE-ML` were all timing out on `Timed out after 180000ms waiting for a Python subprocess slot (7/5 running...)` every ~15-30min for hours before the fix took effect, and the watchdog log line `_runningPython=7 has exceeded MAX_PYTHON_CONCURRENT=5 for >100min — slot leak confirmed` fired and self-healed mid-session. This single leak explains nearly every "late"/"stale" digest entry that session (Preopen Snapshot, Agent: Strategist, ML Daily Ops + all its sub-steps, DL Feature Refresh, DL Engine Inference, FinBERT, Trendlyne Midweek) since they all call `runPython()` and silently queue/timeout behind the leaked slot count while still being able to report a misleading "success" on the BullMQ side (the `.catch()` swallow-and-continue pattern in several workers, e.g. `trendlyne-midweek`, means a worker can mark itself `success` even when every `runPython()` call inside it failed — DB-freshness checks are what actually catch this, not job-success heartbeats; see also `job_monitoring_gotchas_2026_07_11` memory on the same monitor-state-vs-real-outcome gap). `ohlcv_quality`/`relative_strength`/`ownership_relative`/confluence-ML's Python scripts are NOT among the 3 patched for DEVNULL stdio — if slot-leak timeouts recur specifically for those, they likely spawn their own subprocess/multiprocessing too and need the same fix.
- **The real Python subprocess slot-leak was a counting bug in `releasePythonSlot()`, not the stdio-inheritance issue commits `42fb988`/`0111e77` targeted (2026-07-23)**: those two same-morning commits (00:44 IST) predated the running server by ~1min, so they WERE live, yet the leak (`X/5 running`) kept recurring every ~3min through 07:09 IST — far too fast for a fresh subprocess leak, and hitting exactly the scripts the prior note flagged as unpatched (`ohlcv_quality`, `relative_strength`, `ownership_relative`, `CONFLUENCE-ML`) plus many others. Root cause in [pythonRunner.ts:110](src/server/pythonRunner.ts:110): `releasePythonSlot()` only decremented `_runningPython` when the wait queue was empty; when a waiter was queued, it called `entry()` (which does `_runningPython++` for the new holder) *without ever decrementing for the finishing holder* — every hand-off under contention leaked +1 permanently. With `MAX_PYTHON_CONCURRENT=5` and 40+ Python jobs firing every few minutes in `queues.ts`, the queue is rarely empty, so the counter drifted past 5 within minutes of every watchdog reset (confirmed in logs: counter hit **36/5** at one point on 2026-07-22T15:21:20) instead of only after a genuine leaked-pipe subprocess. Fixed by always decrementing first, then handing off to a queued waiter (net zero transfer) — see the fix commit for the full diff. Regression test [test_python_runner_slots.ts](src/server/tests/test_python_runner_slots.ts) simulates queue contention and asserts the counter returns to exactly 0 (proven to fail with +132 drift after 20 rounds against the pre-fix code). Verified live: `pm2 restart bharat-server` at 07:17:21 IST, zero slot-leak errors since, and jobs that were previously stuck (`backfill_technical_features`, `mc_techscanner`) completed within seconds of restart. Lesson: when a "confirmed" leak keeps recurring minutes after a targeted fix lands, re-derive the mechanism from the counter arithmetic itself rather than assuming the same root cause — the prior stdio-inheritance diagnosis was real but was not the dominant cause.
- **`asm_gsm_fetcher.py`'s Postgres backfill never succeeded — raw `%s` placeholders instead of `?` (2026-07-23)**: same bug class previously fixed in `insider_transactions_fetcher.py`. [asm_gsm_fetcher.py:180](src/server/asm_gsm_fetcher.py:180)'s Postgres branch of `backfill_technical_signals()` passed psycopg2-style `%s` placeholders straight to `db_compat.py`'s `cur.execute()`, which routes through SQLAlchemy `text()` + `sql_translate.translate()` — a pipeline that expects `?` (SQLite-style) and converts per-dialect; the raw `%s` bypassed translation and psycopg2 threw `SyntaxError: syntax error at or near "%"` on every single run (confirmed live in `pm2` logs). No existing test exercised this function's SQL at all (`test_asm_gsm_fetcher.py` only covered `_parse_stage`/`upsert_flags`), which is why it shipped and ran broken indefinitely. Fixed to `?` (matching the sqlite branch immediately below it in the same function); verified by running `backfill_technical_signals()` directly against the live DB (35,685 rows updated cleanly). Added `TestBackfillTechnicalSignalsPlaceholders` regression test asserting no literal `%s` survives in the executed SQL.
- **`pythonRunner.ts` exit-code-1 failures could log a blank reason (2026-07-23)**: `mc_broker_reco_fetcher.py` intentionally `sys.exit(1)`s when it fetches 0 recos (by design, so an upstream MC API blip doesn't look like a silent no-op) but prints the reason to stdout, not stderr — `runPython()`'s non-zero-exit path only used `stderr`, so the job log showed a bare `Command failed with exit code 1` with the actual reason lost. Fixed generically in [pythonRunner.ts](src/server/pythonRunner.ts) to fall back to the stdout tail (last 500 chars) when stderr is empty, so any script's `print()`-then-`sys.exit(1)` pattern surfaces its reason in job logs going forward.
- **Regime-aware edge adjustment for `win_probability` (2026-07-23), flag-gated off by default.** Audited the accuracy backlog and found two claimed gaps were already done and undocumented: `cs_ranker.py` (cross-sectional alpha-percentile LightGBM ranker, wired into `unified_ranker.py`'s `engine_maps['cs']`, cron-wired daily, held-out Spearman rho climbing 0.075→0.237 across retrains) — no memory or session note ever mentioned it, so document it here now; and the three "Still open (top)" P0 items in an older session note (ensemble promotion bar, `technicalSignalsService.ts` scanDate bounding, breakout_probability-in-ranker) were already live — that note was stale and has been removed. The real remaining gap: `win_probability` has real live discrimination only in some regimes (BEAR/SIDEWAYS today; historically BULL≈0.50) but three consumers (`ml_ensemble.py`'s hard expiry gate, `scoring_engine.py`'s ML bonus/discount, `unified_ranker.py`'s position sizing) treated every regime the same. Added: `ml_calibration.py` — new `regime_edge_status` table persisting `per_regime_auc()`/`regime_readiness()` (previously print-only) + a pooled `__GLOBAL__` fallback, refreshed inside the existing `ml-daily-ops` cron; `regime_edge_weight()`/`edge_adjusted_probability()` (pure functions, shrink a probability toward neutral 0.5 in proportion to how far a regime's live AUC sits below a 0.55 trust floor, `HIGH_VOL`/`CRASH` route through `BEAR` via `collapse_regime5()` mirroring `backfill_technical_features.py`'s existing closure); `is_edge_adjustment_enabled()` reading `app_settings.edge_adjustment_enabled` (default **off**). Also fixed a real bug found along the way: `ml_ensemble.py`'s `recommendation_log` propagation UPDATE (now `_propagate_and_gate_recommendation_log`) was reading raw `win_probability` instead of `COALESCE(calibrated_win_probability, win_probability)` — the hard expiry gate was acting on the known-overconfident raw value while every other consumer already preferred calibrated. Consumer wiring (`_apply_regime_expiry_gate` in ml_ensemble.py, `apply_edge_adjustment_to_win_probs`/`apply_ml_score_adjustment`/`ml_alignment_points` pure functions in scoring_engine.py — first test file for that module, `_get_win_probabilities()` per-row adjustment in unified_ranker.py) all gated behind the flag; the existing `max(ml_bet, bo_bet)` breakout hedge in `unified_ranker.run()` is untouched by design (locked in by a regression test). 62 new/updated tests, all passing; full suite 543 passed (2 pre-existing unrelated failures, see below). **Live-verified via `scripts/diff_edge_adjustment.py` (new, read-only) that flipping the flag on TODAY is a complete no-op**: BEAR AUC=0.643, SIDEWAYS AUC=0.618 (both clear the trust floor), zero `recommendation_log` gate flips, zero `scoring_engine` adjustments, zero `unified_ranker` sizing changes across live data — the mechanism only activates once a regime's live edge actually decays, which is the intended behavior, not a bug. Flag currently OFF; flip via `UPDATE app_settings SET value='true' WHERE key='edge_adjustment_enabled'` (insert if missing) whenever ready — safe to do now given the no-op verification, or wait and re-verify closer to when a regime's AUC is expected to move.
- **`REGIME_WEIGHTS` sum-to-1 bug — actually fixed 2026-07-23 (a prior note claiming session `task_d4dc5bc5` had already fixed this in-tree was false; the bug was still live in `unified_ranker.py` when this fix started, and `git diff` confirmed no prior uncommitted change had touched `REGIME_WEIGHTS` — corrected here rather than left to drift).** All 5 regimes were over 1.0, not just BULL: BULL 1.15, BEAR 1.05, HIGH_VOL 1.10, CRASH 1.05, SIDEWAYS 1.13 — `cs_ranker`'s `'cs': 0.05` and the `breakout` classifier's weight were both bolted onto every regime dict without rebalancing the pre-existing engines down. Because `_blend()` always renormalizes over whichever engines have data for a symbol (dividing by the sum of *active* weights), a sum-drift like this is a no-op for symbols missing any engine — it only bites when every engine has data for a symbol, silently diluting each engine's real share below its documented value (e.g. BULL's `screener: 0.30` was actually only contributing 0.30/1.15=26.1%, not the intended 30%). Fixed by pinning `screener`/`cs`/`breakout` at their existing documented per-regime values (satisfies `test_regime_weights_sum_to_one`'s hard-coded `BULL.screener==0.30` / `CRASH.screener==0.40`) and proportionally shrinking `ml`/`confluence`/`technical`/`dl` to absorb the room `cs`+`breakout` need, per regime. Also fixed `test_sideways_present` in `test_unified_ranker_regime.py`: its expected key-set literal predated `breakout` being added to `SIDEWAYS` and was never updated — added `"breakout"` to the expected set rather than removing the key (SIDEWAYS deliberately carries breakout per the code's own regime-momentum rationale). `python -m pytest src/server/__tests__/test_unified_ranker.py src/server/__tests__/test_unified_ranker_regime.py` — 56 passed, 0 failures. Live-verified read-only (no DB writes) against the real Postgres DB with a temp diff script blending real engine scores under old vs. new weights for the day's live SIDEWAYS regime: ~2005 symbols with full engine coverage saw a modest, expected shift (median delta -0.14, mean -0.20, range -3.5..+3.0) with top-20 rank order 19/20 stable — consistent with a rebalance, not a blowup.
- **`ml_ensemble.py` expiry-gate temporal regime mismatch fixed (2026-07-23).** Found while looking for other small unrelated issues alongside the REGIME_WEIGHTS fix above: `regime_threshold(conn)` reads the single CURRENT `app_settings.current_nifty_regime` and was applied uniformly to every `ACTIVE` `recommendation_log` row regardless of the regime that was active when each row was actually created — a row created during BEAR (threshold 0.36) could later be judged against today's BULL threshold (0.40) once the regime moved on, even though `recommendation_log.nifty_regime` already stores the row's own regime and was sitting unused for this purpose. Fixed with a new `_row_threshold(regime, default_threshold)` (direct dict lookup against `_REGIME_THRESHOLDS` — no HIGH_VOL/CRASH collapsing needed since `nifty_regime` is already 3-class) used by both the legacy path (extracted into a new `_apply_plain_expiry_gate`) and the edge-adjusted path (`_apply_regime_expiry_gate`), falling back to the current-regime threshold only for rows with no stamped regime. Orthogonal to the edge-adjustment feature — applies unconditionally, not behind the flag. 4 new tests; live-verified via a one-off read-only check against the real DB: 0 of 45 live ACTIVE rows flip today (all currently confirmed consistent with the fallback), confirming no live disruption while closing the gap for whenever regime and row-regime diverge next.
- **`job_heartbeat` false-"never succeeded" spam for data-quality check ids (2026-07-23)**: `pm2 logs` showed `[HEARTBEAT] STALE: 'ohlcv-freshness-coverage' has never succeeded` (+5 other `DATA_QUALITY_CHECKS` ids) firing every hour indefinitely. Root cause: `checkAndAlertDataQuality()` in [jobWatchdog.ts](src/server/jobWatchdog.ts) calls `markAlerted(r.id, ...)` for failing DQ checks to dedupe Telegram alerts by day — but `markAlerted()` does an upsert into the *`job_heartbeat`* table (shared with real BullMQ job heartbeats), inserting a row keyed by the DQ check's id. `recordHeartbeat()` (the only thing that ever sets `last_success_at`) is never called with a DQ check id, so that row's `last_success_at` stays NULL forever, and `getStaleJobs()`'s exclusion set only knew about `JOB_REGISTRY`/`MONITOR_SCRIPTS` ids — not `DATA_QUALITY_CHECKS` ids — so it permanently flagged "never succeeded", duplicating (and outliving) the check's own real freshness signal already tracked in `data_quality_results`/`getLatestDataQualityResults()`. Fixed by adding a `DATA_QUALITY_CHECKS` id exclusion to `getStaleJobs()` in [jobHeartbeat.ts](src/server/jobHeartbeat.ts) (mirroring the existing `JOB_REGISTRY`/`MONITOR_SCRIPTS` exclusions) — this table is being reused purely as an alert-dedup keystore for 3 different id namespaces, not exclusively for job runs, so any future 4th namespace using `markAlerted` needs the same exclusion added here or it will silently reproduce this bug. 2 new regression tests in `jobHeartbeat.test.ts`; `pm2 restart bharat-server` done to deploy (existing rows with the old NULL `last_success_at` are harmless now — they're excluded regardless of value).


