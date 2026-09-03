# 00 — Feature Inventory & Boundaries (2026-09-02)

Repo: bharat-stock-intelligence @ `04d20db`. Counts verified this session:
213 Python modules in `src/server/` (81 `*_fetcher.py`), 28 tRPC router modules
(7,912 lines, 376 procedures: 278 public / 55 admin / 34 protected / 9 expensive),
`queues.ts` 3,327 lines, `dataQualityChecks.ts` 2,534, greenfield 105 `.ts`.

| # | Feature | Entry points | Core files | Purpose |
|---|---|---|---|---|
| 1 | api-gateway | `server.ts` | `src/server/trpc.ts`, `router.ts` (64 ln, merge point), `routers/*.ts` | Express + tRPC + WS `/signals`, auth/rate-limit, static frontend |
| 2 | frontend | `src/main.tsx` | `src/App.tsx`, `src/v1/V1Routes.tsx`, `src/components/**`, `src/services/**`, `src/lib/trpc.ts` | v1-only UI (shells consolidated 2026-09-01) |
| 3 | scheduler | `queues.ts` workers | `src/server/queues.ts`, `jobs/*.jobs.ts` (9), `pythonRunner.ts`, `jobHeartbeat.ts` | BullMQ crons, ~120-step nightly chain, subprocess pool |
| 4 | data-layer | `pgClient.ts` | `pgClient.ts` (675), `cacheService.ts`, `db/schema.postgres.sql` (212 tables), migrations | Postgres/TimescaleDB :5433 only DB; Redis→in-memory cache |
| 5 | python-ingestion | per-fetcher `main()` | 81 `*_fetcher.py` + `db_compat.py`, `tl_fetch.py`, `as_of.py` | Provider fetch → parse → upsert, id resolution |
| 6 | py-engines | `runPython()` invocations | `unified_ranker.py` (2,929), `ml_ensemble.py` (4,252), `scoring_engine.py`, `cs_ranker.py`, `dl_engine.py`, `exit_policy.py`, resolvers | Scoring/ML: engines → blend → `unified_recommendations` (canonical) |
| 7 | alphaquant+worker | `backend-python/main.py` :8002, `worker_service.py` :8005 | backend-python/, `mcp/market_intelligence_mcp.py`, `python_api.py` :8000 | Backtesting/optimization; MCP dispatch; overlaps ml-api endpoints |
| 8 | chatbot | `src/server/chatbot/app.py` :8001 | LangGraph graph, tools, ChromaDB ingest | RAG agent |
| 9 | greenfield (shadow) | `ecosystem.config.cjs` `gf-*` | `greenfield/**` (105 .ts, own pnpm monorepo, 34 normalized tables) | Deliberate parallel rebuild; stage-5 ranker emits `null` unvalidated ranker |

Shared data: `src/data/stocklist.ts` (25,658 ln), `src/data/nseStocks.ts`, `src/server/stockMapping.ts`, `scripts/stocklist.json` (read by Python fetchers).

## Pre-adjudicated non-problems (do not re-flag)
Four-signal-table ceiling; `stock_scores`/`quant_scores` as deliberate ranker inputs;
no `technical_signals` rename (141-file cosmetic churn rejected); `greenfield/` is an
active shadow track, not dead code; Postgres is the only DB (SQLite fully decommissioned).
