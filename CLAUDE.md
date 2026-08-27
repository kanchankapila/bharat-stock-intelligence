# Bharat Stock Intelligence — Claude Instructions

Real-time Indian stock market intelligence platform (NSE/BSE). Express + tRPC backend, React 19 + Vite frontend, PostgreSQL/TimescaleDB, BullMQ jobs, ~200 Python modules in `src/server/` (79 fetchers + ML engines/jobs/helpers).

## Read first

1. **`fable-brain.md`** (project root) — standing reasoning discipline. Applies to every task.
2. **Memory index** — `C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\MEMORY.md`. Load the entries relevant to your task before exploring files.
3. **The rule file for what you're touching** (below). Don't read all of them.

## Rules (load on demand)

| Touching… | Read |
|---|---|
| scoring, ranking, any `*_signals` / `*_outcomes` table | `.claude/rules/scoring-authority.md` |
| a fetcher, a new provider, a provider-issued id | `.claude/rules/data-sources.md` |
| any accuracy / win-rate / IC / backtest number | `.claude/rules/measurement.md` |
| **anything** — skim before writing Python or SQL | `.claude/rules/recurring-bugs.md` |

`docs/session-log.md` is the historical changelog (~6,100 lines — never load it whole). Not loaded automatically; grep or read a specific dated entry when you need the history behind a decision.

## Definition of done

A task is **not** done until the relevant check has actually run and passed. Claiming "done" without one is the single most repeated failure in this repo's history.

```bash
npx tsc --noEmit                                    # any .ts change
npx vitest run                                      # any .ts logic change
python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/  # any .py change (identical to CI)
npm run schema:drift                                # any migration
```

Plus, for anything touching signal/scoring/model logic:

- **Negative-control your tests.** Revert the fix, confirm the new test fails, restore. A green suite that never failed against the bug protects nothing.
- **Run it against live production data and query the result back.** `tsc --noEmit` and a green suite do not tell you a fetcher wrote the right rows. See `.claude/rules/measurement.md`.
- **Committed ≠ deployed.** `.ts` needs `pm2 restart bharat-server`; a migration needs `npm run migrate:up` against the real `POSTGRES_URL`; a package needs `npm install` / the right venv.

**These are enforced, not advisory.** `.claude/hooks/verify-gate.mjs` is a `Stop` hook: it blocks the session from finishing if the diff touches `.ts`/`.py` and the matching command never ran, and demands backtest evidence for signal-surface files. It reads your actual Bash invocations — writing "I ran pytest" does not satisfy it. `.claude/hooks/{rules-pointer,env-guard}.mjs` run on every Edit/Write.

Run pytest with `backend-python/venv` (the production interpreter, Python 3.11) unless reproducing a CI-only failure — CI runs 3.12, and that gap has caused a green-locally/red-on-CI tokenizer bug before.

## Knowledge graph

Query before reading source files:

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -m graphify query "<question>"     # or: path "A" "B" | explain "Symbol"
& $PY -m graphify update .               # after significant changes
```

Check `graphify-out/GRAPH_REPORT.md`'s "Built from commit" hash against `git rev-parse HEAD` before trusting it — it drifted 330 files behind in five days once already, and it is usually behind (it was again at the time of writing). Node/edge/file counts live in that report, deliberately not here.

Updating is **free** (local AST extraction, 0 tokens) — run it, don't ration it. `graph.html` is no longer emitted: 16k+ nodes is over the 5,000-node viz cap, which is expected and exits 0. `query`/`path`/`explain` are the interface.

## Services

Four processes run concurrently (`npm start`, or pm2 in production). A change to one is not live
in the others — and `.ts` is not hot-reloaded, so the Node server needs `pm2 restart bharat-server`.

| pm2 name | Entry point | Port (env var) | Purpose |
|---|---|---|---|
| `bharat-server` | `server.ts` | 3000 (`PORT`) | tRPC API, React frontend, WebSocket at `/signals` |
| `ml-api` | `src/server/python_api.py` | 8000 (`PYTHON_API_PORT`) | DL training/inference, outcome resolution |
| `chatbot` | `src/server/chatbot/app.py` | 8001 (`CHATBOT_PORT`) | LangGraph RAG agent, ChromaDB |
| `alphaquant-api` | `backend-python/main.py` | 8002 (`PYTHON_PORT`) | Backtesting, scoring, TV bridge, optimisation |

`ecosystem.config.cjs` registers **18** pm2 apps, not 4: these four long-running services plus a `cron_restart` tier (`gf-*` greenfield jobs, `pg-backup-nightly`, `deploy-drift-check`, `port-drift-check`). A `cron_restart` app sitting at `stopped`/`pid 0` looks identical whether it is healthily idle or dormant after a failed first launch — see `recurring-bugs.md`.

**`greenfield/` (~105 `.ts` files) is a parallel rebuild that nothing in the live app imports.** Changing it changes nothing a user sees, and vice versa. Check which tree you are in before editing.

## Layout

```
src/
  App.tsx            main app, layout + tab routing
  v1/ … v6/          six dashboard experiences, all lazy-loaded, all reading the same tRPC surface
  components/        shared React components
  services/          marketService (live prices), aiService (routes to gemini/bedrockService — no local LLM since 2026-08-20)
  lib/trpc.ts        tRPC client
  data/              stocklist.ts (2,000 stocks, provider mappings 89-100% populated) · nseStocks.ts (2000+ NSE master)

src/server/
  router.ts          ALL tRPC procedures — check here before searching elsewhere
  routers/*.ts       domain-split procedure modules
                     (there is NO db.ts / db.sqlite-legacy.ts — deleted 2026-08-16, a2a20d2.
                      Schema-of-record is db/schema.postgres.sql, generated from live.)
  dbAsync.ts         → pgClient.ts   the live Postgres facade
  queues.ts          BullMQ definitions + all cron schedules
  jobs/*.jobs.ts     decomposed job registrations
  cacheService.ts    Redis → in-memory fallback
  dataQualityChecks.ts   freshness/coverage checks (factory-generated + hand-rolled), daily cron + Telegram
  *.py               79 `*_fetcher.py` + ML engines/backfills — canonical ranker is unified_ranker.py
```

Component/procedure/table inventories are deliberately **not** listed here — they rot. Grep the source.

## Frontend versions

Six dashboards coexist in one app, no separate build. `App.tsx`'s `dashboardVersion` (localStorage) picks among **v1/v2/v3/v6 only** — fallback is `v1` (that's what a fresh visitor lands on; promoted back from v6 on 2026-08-20, `App.tsx:218`). v4 and v5 aren't `dashboardVersion` values; see their rows below for how each is actually reached.

| | Shell | Notes |
|---|---|---|
| v1 | `AppShell` | **default** — classic tab list, now nav-linking every page the other shells had (v6 screener/portfolio + the v5 desk retrofits) |
| v2 / v3 | `V2AppShell` | v3 = Bloomberg-terminal restyle |
| v4 | inside `V2AppShell` | `MarketCommandCenter`, `StockIntelligencePage` |
| v5 | own route tree at `/v5` | institutional workbench + desk pages |
| v6 | `V6Shell` | composed home + portfolio tracker + screener browser |

Nothing is deprecated. Before trusting any "fix applied to the nav/shell" claim, check *which shell* it landed in — a comment saying it was mirrored has been wrong before.

## Architecture facts that constrain changes

- **Canonical ranking is `unified_recommendations`** (`unified_ranker.py`). `stock_scores` and `quant_scores` are its *inputs*, not duplicates. Never write a parallel "final" score. Details: `.claude/rules/scoring-authority.md`.
- **Four signal tables, and that's the ceiling**: `unified_signals`, `technical_signals`, `signal_outcomes`, `unified_signal_outcomes`. Do not add a fifth. The merges you might consider have been investigated and rejected on their merits — see the rule file before re-proposing one.
- **NSE symbol is the only canonical identifier.** Every provider id derives from it, never the reverse, and is never constructed by convention.
- **Postgres/TimescaleDB (:5433) is the ONLY database. There is no second dialect to reason about.** `usePostgres()` / `use_postgres()` take no environment variable for any real process — a missing `.env` can no longer reroute anything, it can only fail to connect, loudly. Several tables are compressed hypertables where a predicate-wide `UPDATE`/`ADD CONSTRAINT` will fail or destroy compression.
  - **TypeScript is fully migrated.** `npx vitest run`'s `unit` project runs against a private throwaway Postgres schema built from `db/schema.postgres.sql` (`vitest.globalSetup.ts`); its `live` project talks to real production on purpose. There is no SQLite path left in any `.ts`.
  - **Python runs on Postgres too, and the shim is GONE (2026-08-17).** There is no `SQLITE_SHIM_POSTGRES` flag and no monkeypatch of `sqlite3.connect` any more: 93 fixture files were converted to an explicit **`pg_memory_conn()`** (`src/server/pg_test_support.py`), which is the 1:1 replacement for a raw `sqlite3.connect(':memory:')`. `conftest.py` now lives at **`src/server/conftest.py`**, not `src/server/tests/` — it was moved up because `src/server/__tests__/` had no conftest at all, so its Python files were invisible to the old shim's own counter. Use `pg_memory_conn()`, `pg_conn` (empty schema, bring your own DDL) or `pg_db_conn` (full production schema); never add a `sqlite3.connect`. **6 named files still block Phase 3** (`sql_translate.py`'s pytest branch) — they are enumerated in `docs/SQLITE_DECOMMISSION_PLAN.md`. ⚠ Do not verify this with a bare `grep -r "sqlite3.connect(':memory:')"`: it matches 8 *comments/docstrings* naming the retired pattern, and from the repo root it also descends into `.claude/worktrees/` (gitignored, 12 stale copies) and returns dozens. The verified check is the assignment form — `grep -rnE "=\s*sqlite3\.connect\(':memory:'\)" --include=*.py src/ tests/` → 0, and 21 against a stale worktree, so it is not vacuous.
  - **Test against an EMPTY database before believing a test passes.** A developer's Postgres IS production, and `pg_conn` puts `public` on the search_path, so a table the fixture forgot silently resolves to the real one. Three separate suites were green that way and red in CI. `PGTEST_DB=<empty db> pytest ...` is the check.
- **Measured state of the edge**: the ranker has no demonstrated forward-return edge, and most factors tested are null-to-negative. Read `.claude/rules/measurement.md` before proposing a reweighting — it is very likely the wrong fix.

## Conventions

- Do not add comments unless the WHY is non-obvious.
- Do not add error handling for impossible scenarios.
- Do not refactor beyond what the task requires.
- Prefer reusing an existing helper over writing a new one — check first.
- Multiple sessions edit this repo concurrently. Commit **by explicit path**, never `git add -A`, and re-check `git status` immediately before committing.

## Closing a session

Before finishing, make all three consistent with what actually happened:

1. **`docs/session-log.md`** — append what changed and what was learned.
2. **Memory** — add/extend a file for anything durable and non-obvious; update `MEMORY.md`'s index.
3. **`.claude/rules/`** — if you hit a bug class that will recur, add its signature to `recurring-bugs.md`. That file is what stops the next session repeating it.

Run `graphify update .` if files changed significantly. Silence in any of these means a future session rediscovers the same thing from scratch.
