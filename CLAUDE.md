# Bharat Stock Intelligence — Claude Instructions

Real-time Indian stock market intelligence platform (NSE/BSE). Express + tRPC backend, React 19 + Vite frontend, PostgreSQL/TimescaleDB, BullMQ jobs, ~210 Python modules in `src/server/` (81 fetchers + ML engines/jobs/helpers).

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
| a model, a promotion gate, a measurement harness | `.claude/rules/ml-model-bugs.md` |
| **anything** — skim before writing Python or SQL | `.claude/rules/recurring-bugs.md` |

`docs/session-log.md` is the historical changelog (~7,600 lines — never load it whole). Not loaded automatically; grep or read a specific dated entry when you need the history behind a decision.

**`docs/audit-findings.md` is the one and only open/pending-items tracker.** Any new bug, gap, or
follow-up you find and don't fix immediately gets a row there (stable `AF-YYYYMMDD-NN` ID, never
delete a row — close it in place with a date and evidence). Don't create a new markdown file for
"things to do later" — this repo already did that three times (`ACTION_ITEMS.md`,
`docs/FETCHER_HEALTH_TRACKER.md`, `docs/DATA_GAP_MANIFEST.md`) and the trackers drifted out of
sync with each other and with the code, which is exactly what caused a 2026-09-02 consolidation
pass to be needed. All three are now retired stubs pointing here.

## Definition of done

A task is **not** done until the relevant check has actually run and passed. Claiming "done" without one is the single most repeated failure in this repo's history.

```bash
npx tsc --noEmit                                    # any .ts change
npx vitest run                                      # any .ts logic change
python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/  # any .py change (identical to CI)
npm run schema:drift                                # any migration
```

`/verify-gate-runner` runs the first three in sequence.

Plus, for anything touching signal/scoring/model logic:

- **Negative-control your tests.** Revert the fix, confirm the new test fails, restore. A green suite that never failed against the bug protects nothing.
- **Run it against live production data and query the result back.** `tsc --noEmit` and a green suite do not tell you a fetcher wrote the right rows. See `.claude/rules/measurement.md`.
- **Committed ≠ deployed.** `.ts` needs `pm2 restart bharat-server`; a migration needs `npm run migrate:up` against the real `POSTGRES_URL`; a package needs `npm install` / the right venv. (`/deploy-and-verify` does this end to end.)

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

Five processes run concurrently (`npm start`, or pm2 in production). A change to one is not live
in the others — and `.ts` is not hot-reloaded, so the Node server needs `pm2 restart bharat-server`.

| pm2 name | Entry point | Port (env var) | Purpose |
|---|---|---|---|
| `bharat-server` | `server.ts` | 3000 (`PORT`) | tRPC API, React frontend, WebSocket at `/signals` |
| `ml-api` | `src/server/python_api.py` | 8000 (`PYTHON_API_PORT`) | DL training/inference, outcome resolution |
| `chatbot` | `src/server/chatbot/app.py` | 8001 (`CHATBOT_PORT`) | LangGraph RAG agent, ChromaDB |
| `alphaquant-api` | `backend-python/main.py` | 8002 (`PYTHON_PORT`) | Backtesting, scoring, TV bridge, optimisation |
| `engine-worker` | `src/server/worker_service.py` | 8005 | MCP tool dispatch (`mcp/market_intelligence_mcp.py`) + ingestion health/risk-analysis endpoints — added 2026-08-29 |

`ecosystem.config.cjs` registers **17** pm2 apps, not 5: these five long-running services plus a `cron_restart` tier (`gf-*` greenfield jobs, `pg-backup-nightly`). `deploy-drift-check`/`port-drift-check` were deliberately removed 2026-08-28 (`b27e588`) — don't re-add them from an old memory of this file. A `cron_restart` app sitting at `stopped`/`pid 0` looks identical whether it is healthily idle or dormant after a failed first launch — see `recurring-bugs.md`.

**`greenfield/` (~105 `.ts` files) is a parallel rebuild that nothing in the live app imports.** Changing it changes nothing a user sees, and vice versa. Check which tree you are in before editing.

## Layout

```
src/
  App.tsx            main app, layout + tab routing — v1 only (2026-09-01 consolidation)
  v1/V1Routes.tsx    the only route tree; renders every page, including former v2/v4/v5/v6 ones
  components/        shared React components, incl. components/v{2,4,5,6}/ — former shell-specific
                     pages/widgets folded in here, rendered through v1's AppShell, not standalone
  services/          marketService (live prices), aiService (routes to gemini/bedrockService — no local LLM since 2026-08-20)
  lib/trpc.ts        tRPC client
  data/              stocklist.ts (2,000 stocks, provider mappings 89-100% populated) · nseStocks.ts (2000+ NSE master)

src/server/
  router.ts          pure mergeRouters of routers/*.ts — procedures live in routers/
  routers/*.ts       domain-split procedure modules
                     (there is NO db.ts / db.sqlite-legacy.ts — deleted 2026-08-16, a2a20d2.
                      Schema-of-record is db/schema.postgres.sql, generated from live.)
  dbAsync.ts         → pgClient.ts   the live Postgres facade
  queues.ts          BullMQ definitions + all cron schedules
  jobs/*.jobs.ts     decomposed job registrations
  cacheService.ts    Redis → in-memory fallback
  dataQualityChecks.ts   freshness/coverage checks (factory-generated + hand-rolled), daily cron + Telegram
  *.py               81 `*_fetcher.py` + ML engines/backfills — canonical ranker is unified_ranker.py
```

Component/procedure/table inventories are deliberately **not** listed here — they rot. Grep the source.

## Frontend versions — CONSOLIDATED 2026-09-01 (`fd0cbd4`)

**v1 is now the only frontend.** The six-shell / `dashboardVersion`-switcher architecture this
section used to describe is gone: `src/v2/`, `src/v3/`, `src/v5/`, `src/v6/` (their `V2AppShell`,
`V6Shell`, `V5App`, `V3Dashboard` and ~7,300 more lines) were deleted outright. Every page now
renders through `V1Routes` inside the classic `AppShell`; `App.tsx` force-migrates any stored
`dashboardVersion` to `'v1'` on mount, so there is no shell to pick anymore.

The former v2/v4/v5/v6 pages and widgets weren't deleted — they were folded in as ordinary
components under `src/components/v{2,4,5,6}/` (e.g. `v5`'s desk pages, `v6`'s Screener Browser /
Portfolio Tracker, `v4`'s `MarketCommandCenter`), given v1's page chrome via `V1PageFrame`, and
routed like any other v1 page. If you're looking for a page that used to live in one of the old
shells, it's almost certainly still there, just relocated under `components/`, not gone.

**If you find an old reference to "six dashboards," `dashboardVersion` branching, or a specific
shell name (`V2AppShell`, `V6Shell`, etc.) in a skill, command, or your own memory of this repo —
it predates this consolidation and no longer reflects the live app.** There is nothing left to
check for shell-parity against; a fix now either lands in v1 or it doesn't ship.

## Architecture facts that constrain changes

- **Canonical ranking is `unified_recommendations`** (`unified_ranker.py`). `stock_scores` and `quant_scores` are its *inputs*, not duplicates. Never write a parallel "final" score. Details: `.claude/rules/scoring-authority.md`.
- **Four signal tables, and that's the ceiling**: `unified_signals`, `technical_signals`, `signal_outcomes`, `unified_signal_outcomes`. Do not add a fifth. The merges you might consider have been investigated and rejected on their merits — see the rule file before re-proposing one.
- **NSE symbol is the only canonical identifier.** Every provider id derives from it, never the reverse, and is never constructed by convention.
- **Postgres/TimescaleDB (:5433) is the ONLY database. There is no second dialect to reason about.** `usePostgres()` / `use_postgres()` take no environment variable for any real process — a missing `.env` can no longer reroute anything, it can only fail to connect, loudly. Several tables are compressed hypertables where a predicate-wide `UPDATE`/`ADD CONSTRAINT` will fail or destroy compression.
  - **TypeScript is fully migrated.** `npx vitest run`'s `unit` project runs against a private throwaway Postgres schema built from `db/schema.postgres.sql` (`vitest.globalSetup.ts`); its `live` project talks to real production on purpose. There is no SQLite path left in any `.ts`.
  - **Python runs on Postgres too, and the shim is GONE (2026-08-17).** There is no `SQLITE_SHIM_POSTGRES` flag and no monkeypatch of `sqlite3.connect` any more: 93 fixture files were converted to an explicit **`pg_memory_conn()`** (`src/server/pg_test_support.py`), which is the 1:1 replacement for a raw `sqlite3.connect(':memory:')`. `conftest.py` now lives at **`src/server/conftest.py`**, not `src/server/tests/` — it was moved up because `src/server/__tests__/` had no conftest at all, so its Python files were invisible to the old shim's own counter. Use `pg_memory_conn()`, `pg_conn` (empty schema, bring your own DDL) or `pg_db_conn` (full production schema); never add a `sqlite3.connect`. **Phase 3 Python is DONE too (2026-08-19)** — the 6 files that blocked it were converted/deleted and `sql_translate.py`'s pytest carve-out (`_in_pytest()`) was removed as dead code, so `use_postgres()` now returns True unconditionally *including inside pytest* (`docs/SQLITE_DECOMMISSION_PLAN.md`). ⚠ Do not verify this with a bare `grep -r "sqlite3.connect(':memory:')"`: it matches 8 *comments/docstrings* naming the retired pattern, and from the repo root it also descends into `.claude/worktrees/` (gitignored, 12 stale copies) and returns dozens. The verified check is the assignment form — `grep -rnE "=\s*sqlite3\.connect\(':memory:'\)" --include=*.py src/ tests/` → 0, and 21 against a stale worktree, so it is not vacuous.
  - **Test against an EMPTY database before believing a test passes.** A developer's Postgres IS production, and `pg_conn` puts `public` on the search_path, so a table the fixture forgot silently resolves to the real one. Three separate suites were green that way and red in CI. `PGTEST_DB=<empty db> pytest ...` is the check.
- **Measured state of the edge**: the ranker has no demonstrated forward-return edge, and most factors tested are null-to-negative. Read `.claude/rules/measurement.md` before proposing a reweighting — it is very likely the wrong fix.

## Conventions

- Do not add comments unless the WHY is non-obvious.
- Do not add error handling for impossible scenarios.
- Do not refactor beyond what the task requires.
- Prefer reusing an existing helper over writing a new one — check first.
- Multiple sessions edit this repo concurrently. Commit **by explicit path**, never `git add -A`, and re-check `git status` immediately before committing.
- **Follow the `superpowers` plugin's workflow skills for code development work in this repo** (enabled in `.claude/settings.json`): `superpowers:brainstorming` before designing a new feature or nontrivial change, `superpowers:systematic-debugging` before proposing a fix for a bug/test failure, `superpowers:test-driven-development` before writing implementation code, `superpowers:requesting-code-review` after completing a task or before merging. This is in addition to — not instead of — this file's own `.claude/rules/` and the `/verify-gate-runner` checks; the superpowers skills are process discipline (design-first, test-first, reviewed), this file's rules are the domain-specific ones (scoring authority, measurement discipline, recurring bug classes).

## Closing a session

Before finishing, make all four consistent with what actually happened (`/session-close` walks this against what the session actually changed):

1. **`docs/session-log.md`** — append what changed and what was learned.
2. **Memory** — add/extend a file for anything durable and non-obvious; update `MEMORY.md`'s index.
3. **`.claude/rules/`** — if you hit a bug class that will recur, add its signature to `recurring-bugs.md`. That file is what stops the next session repeating it.
4. **`docs/audit-findings.md`** — anything you found but didn't fix gets a row here (new `AF-YYYYMMDD-NN` ID), not a new file and not just a mention in the session log. If you closed a row, update it in place with today's date and evidence; never delete a row.

Run `graphify update .` if files changed significantly. Silence in any of these means a future session rediscovers the same thing from scratch.
