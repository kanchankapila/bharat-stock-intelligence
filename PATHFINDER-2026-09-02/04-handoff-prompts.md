# 04 — Handoff Prompts (copy into /make-plan)

## P1 — Delete the dead bulk-pass scaffolding

```
/make-plan Remove the 2026-08-28 bulk-edit scaffolding from src/server/*.py: every injected
`class XFetcherBaseFetcher(BaseFetcher[...])` definition (~84, zero instantiations — verified
incl. asm_gsm_fetcher.py:18, credit_rating_fetcher.py:22, delivery_trend_fetcher.py:46,
delivery_volume_fetcher.py:35, marketsmojo_stock_picks_fetcher.py:45), the ~80 unused
`from base_fetcher import ... governed_fetcher` imports, the `to_polars_df` helper present in
203 files with zero call sites, and the WorkflowDAG/TaskNode imports in the 36 files that never
construct one (live constructions only inside workflow_orchestrator.py:112,124 and its test).
Do NOT delete base_fetcher.py itself in the same pass — first present the owner a decision:
wire @governed_fetcher onto the Trendlyne WAF family (tl_fetch.py consumers) or delete the
module (its DLQ table data_ingestion_dlq is unreachable today).
Protocol: grep `\.to_polars_df\(` must be 0 before AND after; py_compile EVERY touched file;
head -1 every touched file (shebang integrity — the 2026-08-28 pass broke 17 files this way);
AST-walk rather than grep for the injected symbols; then full pytest
(src/server/__tests__/ src/server/tests/ tests/chatbot/) on backend-python/venv.
Anti-patterns: no replacement helper, no compat re-export, no "keep just in case".
```

## P2 — Shared Python stocklist loader

```
/make-plan Create src/server/stocklist_loader.py: load_provider_map(field, *, invert=False)
reading scripts/stocklist.json, caching per field, mirroring src/server/stockMapping.ts
semantics. Migrate the 9 hand-rolled loaders (file:line in PATHFINDER-2026-09-02/
02-duplication-report.md A1) to it, keeping each fetcher's missing-value behavior identical
(negative-control: diff each loader's dict against the new one for one real symbol batch
before deleting the old loader). Each touched fetcher keeps its live_datasource test passing.
Anti-patterns: no silent-default on missing ids — preserve the current per-loader behavior
exactly; do not change resolution ORDER (stocklist.ts first, autocomplete second).
```

## P3 — Measured performance pass (server reads)

```
/make-plan Implement PATHFINDER-2026-09-02/03-unified-proposal.md U4 items 1-6 with a measured
before/after for each: (1) bound the latest_price window CTE in signals.router.ts:245-252,
scoring.router.ts:165-173, ml.router.ts:325-332 (live EXPLAIN today: 42,136,925-row WindowAgg,
cost 2,545,528) — verify by diffing old vs new query output on live data before switching;
(2) Promise.all + fetchWithCache for getSignalReportCard (ml.router.ts:259-364, precedent
:234 and misc.router.ts:418-424); (3) fetchWithCache 300s for getStrategyPicks
(scoring.router.ts:144-242 — polled every 300s by InvestmentStrategy.tsx:57); (4) bounded
concurrency (chunks of 8) for the DQ sweep's per-check reads (dataQualityChecks.ts:2478-2494)
plus one batched history insert; (5) monitor:system-status cache 30s→300s
(monitor.router.ts:481); (6) bulk UPDATE for FinBERT backlog (newsSentimentService.ts:1086).
Report per item: query plan or wall-clock before → after. Anti-patterns: no semantic change to
any score/join output without a diffed A/B on real data; caches get TTLs matched to producer
cadence, never invalidate-on-write-only (trpc-surface-review 2026-08-14 precedent).
```

## P4 — Service boundary symmetry

```
/make-plan Align the four Python services and the Node gateway: shared FastAPI bootstrap
(create_service_app) giving ALL services /health (ml-api has none — python_api.py) and CORS
only where a browser needs it; chatbot binds 127.0.0.1 not 0.0.0.0 (chatbot/app.py:170 — its
only consumers are localhost: StockChatbot.tsx:64, operations.jobs.ts:111); WSS created with
path:'/signals' (websocketService.ts:104); db_compat.create_engine gets explicit
pool_size/max_overflow matching the documented "Python 10" budget (db_compat.py:90) and a
statement_timeout set above the DQ sweep's slowest measured check. Present as decisions:
saveBacktestStrategy → protectedProcedure (ml.router.ts:501-517); enqueueSignals job cap +
LLM spend behind write-gate (signals.router.ts:59-64, queues.ts:340-384); expensiveProcedure
+ cache for getTvTa/getTvScreener (technicals.router.ts:272-289). Anti-patterns: do not gate
anything with a real logged-out caller behind auth without checking callers first
(trpc.ts:41-55 precedent).
```

## P5 — Engine-layer hygiene (evidence-gated)

```
/make-plan (a) Add a test that parses ml_ensemble.full_feature_train_sql and
full_feature_score_sql and asserts identical alias column sets (the cr_upgrades 2026-08-30
drift class — currently only prose at ml_ensemble.py:1331 enforces sync). (b) Consolidate the
six champion/challenger gate copies (ml_ensemble.py:3365, cs_ranker.py:283, exit_policy.py:193,
confluence_ml_engine.py:279-374, online_learner.py:194-212, dl_engine.py:815-889) into one
harness module; thresholds stay per engine; run each engine's next retrain through the
consolidated gate and confirm identical accept/reject vs the old code before deleting the
copies. (c) Propose (with a factor_edge.py before/after, per verify-gate) stopping
unified_ranker.py:1763-1780/:2779 from averaging the writerless cs_score (scheduler removed
2026-08-31; weight already 0.0). Anti-patterns: no threshold changes ride along; gates are
load-bearing — behavior-identical refactor only, evidence-gated behavior change separate.
```

## P6 — Frontend entry chunk + data honesty

```
/make-plan (1) Remove stocklist.ts (25,658 lines) and nseStocks.ts (~19,000) from the entry
chunk: convert the two static imports (SlideOutDrawer.tsx:6, AppShell.tsx:14) to dynamic
imports; measure bundle before/after with a Vite build. (2) Data honesty: delete or explicitly
label FALLBACK_INDICES hardcoded prices (App.tsx:121-125); replace `?? 0` StatCards with
unavailable states (SignalIntelligence.tsx:323-326, V1StockDetails.tsx:674 — note stockPrice ?? 0
feeds an option-chain computation, PortfolioTrackerPage.tsx:213,495, CommandCenterDashboard.tsx:337,357,
TopRatedStocks.tsx:264,268, V1Backtest.tsx:396-400); return the computed error field from
marketService (marketService.ts:26,48-53). (3) Delete the 4 orphan components (AlphaCockpit,
BuyRecommendationsPage, ModelRocPanel, TrendlyneSectorDashboard — import-graph verified
2026-09-02) and the stale App.tsx:34-38 comment about /risk.
```
