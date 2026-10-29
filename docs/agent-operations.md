# Agent operations reference

Moved verbatim from CLAUDE.md on 2026-10-28 (CLAUDE.md keeps the rules most tasks need and points here).

## Hook enforcement

These are enforced by hooks in `.claude/settings.json`, not advisory: `verify-gate.mjs` (Stop) blocks finishing
if the diff touches `.ts`/`.py` and the matching command never ran (it reads your real Bash calls, so saying
"I ran pytest" does not count); `rules-pointer.mjs` / `env-guard.mjs` run on Edit/Write; `graphify-pointer.mjs`
enforces query-the-graph-first; `run-session-start.mjs` is the SessionStart entry. **A hook that cannot run is
indistinguishable from a pass** (exit 0, no output), so after changing one run `npx vitest run .claude/hooks`.
Any `*.sh` a hook calls must stay LF-only (`.gitattributes` pins it).

## Knowledge graph notes

Compare `graphify-out/GRAPH_REPORT.md`'s "Built from commit" with `git rev-parse HEAD` before trusting it; it is
usually behind. `graph.html` is not emitted (over the 5,000-node cap); `query`/`path`/`explain` are the interface.

## Services

Production pm2 runs six long-lived processes (the main five are also started by `npm start`). `.ts` is not hot-reloaded: a change to one
service is not live in another until that service restarts.

| pm2 name | Entry point | Port (env var) | Purpose |
|---|---|---|---|
| `bharat-server` | `server.ts` | 3000 (`PORT`) | tRPC API, React frontend, WebSocket at `/signals` |
| `ml-api` | `src/server/python_api.py` | 8000 (`PYTHON_API_PORT`) | DL training/inference, outcome resolution |
| `chatbot` | `src/server/chatbot/app.py` | 8001 (`CHATBOT_PORT`) | LangGraph RAG agent, ChromaDB |
| `alphaquant-api` | `backend-python/main.py` | 8002 (`PYTHON_PORT`) | Backtesting, scoring, TV bridge, optimisation |
| `engine-worker` | `src/server/worker_service.py` | 8005 | MCP tool dispatch + ingestion health/risk endpoints |
| `bqa-scheduler` | `bharat_alpha/src/bharat_alpha/cli.py preopen-scheduler` | none | Persistent Bharat Alpha pre-open scheduler |

`ecosystem.config.cjs` registers **8** pm2 apps: these six plus the `cron_restart` jobs `pg-backup-nightly` and
`bqa-daily` (the `bharat_alpha` daily run). A `cron_restart` app at `stopped`/`pid 0` looks identical whether idle
or dormant after a failed first launch — see `recurring-bugs.md`. `bharat_alpha/` is a from-scratch, self-grading
rewrite with its own README; the live app does not import it and it is not yet serving users, so editing it
changes nothing a user sees. The earlier `greenfield/` and `bharatquant/` rebuilds were removed 2026-10-03
(never wired in); a reference to either is stale and the code is in git history.

## Layout

```
src/
  App.tsx            main app, layout + tab routing
  v1/V1Routes.tsx    the only route tree; renders every page
  components/        shared React components (components/v{2,4,5,6}/ are folded-in former-shell pages)
  services/          marketService (live prices), aiService (routes to gemini/bedrockService)
  lib/trpc.ts        tRPC client
  data/              stocklist.ts (2,000 stocks, provider mappings) · nseStocks.ts (2000+ NSE master)
src/server/
  router.ts          pure mergeRouters of routers/*.ts — procedures live in routers/
  dbAsync.ts         → pgClient.ts   the Postgres facade
  queues.ts          BullMQ definitions + cron schedules (jobs/*.jobs.ts, jobRegistry.ts)
  cacheService.ts    Redis → in-memory fallback
  dataQualityChecks.ts   freshness/coverage checks, daily cron + Telegram
  *.py               fetchers + ML engines/backfills — canonical ranker is unified_ranker.py
db/schema.postgres.sql   schema of record, generated from live (`npm run schema:drift`)
```

Component, procedure and table inventories are deliberately **not** listed — they rot. Grep the source.
v1 (`src/v1/V1Routes.tsx`) is the only legacy route tree. A reference to "six dashboards", `dashboardVersion` or a shell
name (`V2AppShell`, `V6Shell`) is stale; a fix lands in v1 or it does not ship. A second, newer terminal, TALA
(`src/tala/`, mounted at `/tala/*` in `src/main.tsx`), also exists. The v7 Pro pages were retired at the user's
direction (AF-20261027-08, superseding the 2026-10-25 retention); `/v7-*` URLs only redirect to their v1 pages.
Do not add another surface. **Before editing a component, confirm a
route renders it** (grep its import): `BuyRecommendationsPage.tsx` is imported by nothing, and honesty fixes landed there on
2026-10-08 that no user could see.

## Architecture facts that constrain changes

- **Canonical ranking is `unified_recommendations`** (`unified_ranker.py`). `stock_scores` and `quant_scores`
  are its *inputs*. Never write a parallel "final" score. Details: `scoring-authority.md`.
- **Four signal tables, and that is the ceiling**: `unified_signals`, `technical_signals`, `signal_outcomes`,
  `unified_signal_outcomes`. Do not add a fifth; the merges you might consider were investigated and rejected.
- **NSE symbol is the only canonical identifier.** Every provider id derives from it, never the reverse, and is never constructed by convention.
- **Postgres/TimescaleDB (`:5433`) is the ONLY database** — no SQLite path exists in any `.ts` or `.py`.
  Several tables are compressed hypertables where a predicate-wide `UPDATE`/`ADD CONSTRAINT` fails or destroys compression.
  - TypeScript: `vitest`'s `unit` project runs against a private throwaway schema built from `db/schema.postgres.sql`;
    its `live` project talks to real production on purpose.
  - Python tests use `pg_memory_conn()` (`src/server/pg_test_support.py`) as the 1:1 replacement for an in-memory
    connection, `pg_conn` (empty schema) or `pg_db_conn` (full production schema); `conftest.py` is at `src/server/conftest.py`.
    Never add a `sqlite3.connect`.
  - **Test against an EMPTY database before believing a test passes**: a developer's Postgres IS production, and a table a
    fixture forgot silently resolves to the real one. `PGTEST_DB=<empty db> pytest ...` is the check.
- **Measured state of the edge**: the ranker has no demonstrated forward-return edge and most factors tested are
  null-to-negative. Read `measurement.md` before proposing any reweighting — it is very likely the wrong fix.
- **Restart-orphaned jobs are auto-requeued**: `reclaimStaleActiveJobs` → `requeueOrphanedJob` fails a job left `active`
  by a dead worker and queues a guarded make-up (skipped if the regular slot fires within 90 min or one is pending; orphans
  older than 48h are alert-only). On boot look for `orphanRequeue: true` / `isCatchup: true` before assuming a long `active` job is lost.

