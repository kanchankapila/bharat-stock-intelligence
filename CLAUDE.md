# Bharat Stock Intelligence — Claude Instructions

Real-time Indian stock market (NSE/BSE) research and decision-support platform. Express + tRPC
backend, React 19 + Vite frontend, PostgreSQL/TimescaleDB, BullMQ jobs, 296 non-test Python modules
in `src/server/` (82 `*_fetcher.py` plus ML engines, jobs and helpers; 704 `.py` files including tests).

**What the product is for, and the contracts a change must preserve: `CONTEXT.md`.** This file is the
operating manual (rules, checks, workflow). `AGENTS.md` is only the inventory of skills, commands,
subagents and hooks.

> **Counts drift — treat every number in a doc as a dated snapshot.** The live inventory is the
> filesystem plus `information_schema`. `node scripts/docNumbers.mjs` re-derives every quoted figure;
> `npm run doc:numbers:check` fails on drift. Never hand-write a count into a doc or comment.

## Read first

1. **`fable-brain.md`** — standing reasoning discipline; applies to every task.
2. **Memory** (the SessionStart hook reports which it found; read the relevant entries before exploring files):
   - Claude Code project memory: `C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\MEMORY.md`.
   - This repo's: `.agents/memory/MEMORY.md` plus `.agents/memory/session_journal.md` (append a dated section per session).
3. **The rule file for what you touch** — each has `paths:` frontmatter, so it loads on first read of a
   matching file. That does **not** fire when you only *quote* a number: then read `measurement.md` yourself.

| Touching… | Read |
|---|---|
| scoring, ranking, any `*_signals` / `*_outcomes` table | `.claude/rules/scoring-authority.md` |
| a fetcher, a provider, a provider-issued id, onboarding/triaging a datasource | `.claude/rules/data-sources.md` |
| any accuracy / win-rate / IC / backtest number | `.claude/rules/measurement.md` |
| a model, a promotion gate, a measurement harness | `.claude/rules/ml-model-bugs.md` |
| **anything** — skim before writing Python or SQL | `.claude/rules/recurring-bugs.md` |

`docs/session-log.md` is the historical changelog (~7,600 lines — never load it whole; grep a dated entry).

## Resolve findings, don't just log them

A finding is not done when written down; it is done when **fixed, verified against live production,
and closed with a date and evidence** — in the same session. Report and fix are one act: an audit that
ends in a list is unfinished. Every fix ships with a regression test written first, shown to FAIL on
the unfixed code, then passing, and named in the ledger row's `Immunized` cell.
`npm run findings:check` enforces this for rows from 2026-09-30; a red result means the session is not finished.

`docs/audit-findings.md` is the **only** open/pending tracker (stable `AF-YYYYMMDD-NN` ids; never delete
a row, close it in place). Do not create another "things to do later" file — three were retired for drifting.
Findings are not GitHub issues; GitHub (`kanchankapila/bharat-stock-intelligence`, via `gh`) is for PRs.

A finding may stay **open** only for one of these reasons, stated in its row:
- **EVIDENCE** — it touches a score, weight, threshold or classification, so `measurement.md` /
  `ml-model-bugs.md` require measuring first. "Resolve now" then means run the measurement now.
- **Calendar-blocked** — needs elapsed time (e.g. ~20-30 trading dates); name the unblock condition and a date.
- **Needs a user decision** — a tradeoff only the user can make. Not a lane you may enter until you have
  exhausted what you can determine yourself. For missing data that means `data-sources.md`'s RULE ZERO:
  an `information_schema` sweep for the column across every table plus a `graphify query` for an existing
  backfill — not three plausible tables. For a vendor that stopped returning data, or a new source:
  1. Query the discovery registry first: `market_endpoint_registry` in Postgres (`bharat_intel` on `:5433`,
     3,408 endpoints: 2,864 GET / 544 POST; views `v_working_market_endpoints`, `v_stock_screeners`, `v_fno_endpoints`).
  2. The consolidated catalog `url_endpoints` (834 templates): `python -m url_explorer.ingest --find-alternates "<targets>" --exclude <failing-host>` from `src/server`.
  3. The raw corpus `unique_urls.txt` / `urls_v2.db` (3,103 URLs) in the repo root.
  4. Grep the repo for sibling endpoints and probe route by route with the MINIMUM headers (start from none — adding a token can lower access).
  5. Only then ask the user, with the per-route breakdown and alternates ruled in or out — never "this vendor is dead".
- **Depends on an earlier fix** — genuinely sequential; name the blocking row.

This applies equally to findings from a log sweep: a pm2 warning/error that means data was not written is a
defect to fix now, whatever level it was logged at, including a step that exited 0. Re-verify any open row
you touch and either close it or update why it is still blocked; an open row nobody re-checks is itself a finding.

## Definition of done

Not done until the relevant check has actually run and passed — claiming "done" without one is this repo's most repeated failure.

```bash
npx tsc --noEmit                                    # any .ts change
npx vitest run                                      # any .ts logic change
python -m pytest src/server/__tests__/ src/server/tests/ tests/chatbot/  # any .py change (identical to CI)
npm run schema:drift                                # any migration
npm run doc:numbers:check                           # any doc/comment quoting a repo inventory count
npm run findings:check                              # any session that touched docs/audit-findings.md
```

`/verify-gate-runner` runs the first three. Run pytest with `backend-python/venv` (production, Python 3.11);
CI runs 3.12, and that gap has caused a green-locally/red-on-CI bug before.

For anything touching signal, scoring or model logic, also:
- **Negative-control your tests**: revert the fix, confirm the new test fails, restore.
- **Query the result back from live production** — a green suite does not show a fetcher wrote the right rows.
  For reads use `backend-python/venv/Scripts/python.exe scripts/sql.py "<SQL>"` (read-only transaction,
  server-side timeout, prints the target DB) rather than another one-off script.
- **Committed ≠ deployed.** `.ts` needs `pm2 restart bharat-server`; a migration needs `npm run migrate:up`
  against the real `POSTGRES_URL`; a package needs `npm install` / the right venv. `/deploy-and-verify` does it end to end.

These are enforced by hooks in `.claude/settings.json`, not advisory: `verify-gate.mjs` (Stop) blocks finishing
if the diff touches `.ts`/`.py` and the matching command never ran (it reads your real Bash calls, so saying
"I ran pytest" does not count); `rules-pointer.mjs` / `env-guard.mjs` run on Edit/Write; `graphify-pointer.mjs`
enforces query-the-graph-first; `run-session-start.mjs` is the SessionStart entry. **A hook that cannot run is
indistinguishable from a pass** (exit 0, no output), so after changing one run `npx vitest run .claude/hooks`.
Any `*.sh` a hook calls must stay LF-only (`.gitattributes` pins it).

## Knowledge graph

Query before reading source files:

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -m graphify query "<question>"     # or: path "A" "B" | explain "Symbol"
& $PY -m graphify update .               # after significant changes — local AST extraction, free, run it
```

Compare `graphify-out/GRAPH_REPORT.md`'s "Built from commit" with `git rev-parse HEAD` before trusting it; it is
usually behind. `graph.html` is not emitted (over the 5,000-node cap); `query`/`path`/`explain` are the interface.

## Services

Five processes run concurrently (`npm start`, or pm2 in production). `.ts` is not hot-reloaded: a change to one
service is not live in another until that service restarts.

| pm2 name | Entry point | Port (env var) | Purpose |
|---|---|---|---|
| `bharat-server` | `server.ts` | 3000 (`PORT`) | tRPC API, React frontend, WebSocket at `/signals` |
| `ml-api` | `src/server/python_api.py` | 8000 (`PYTHON_API_PORT`) | DL training/inference, outcome resolution |
| `chatbot` | `src/server/chatbot/app.py` | 8001 (`CHATBOT_PORT`) | LangGraph RAG agent, ChromaDB |
| `alphaquant-api` | `backend-python/main.py` | 8002 (`PYTHON_PORT`) | Backtesting, scoring, TV bridge, optimisation |
| `engine-worker` | `src/server/worker_service.py` | 8005 | MCP tool dispatch + ingestion health/risk endpoints |

`ecosystem.config.cjs` registers **7** pm2 apps: these five plus the `cron_restart` jobs `pg-backup-nightly` and
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
There is one frontend (v1). A reference to "six dashboards", `dashboardVersion` or a shell name (`V2AppShell`,
`V6Shell`) is stale; a fix lands in v1 or it does not ship.

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

## Conventions

- No comments unless the WHY is non-obvious. No error handling for impossible scenarios. No refactoring beyond the task.
- Reuse an existing helper before writing a new one.
- Multiple sessions edit this repo concurrently: commit **by explicit path**, never `git add -A`, and re-check `git status` right before committing.
- Land work on `main` and close it in the ledger; do not leave open work on feature branches.
- Follow the `superpowers` workflow skills for development (enabled in `.claude/settings.json`): `brainstorming` before a
  new feature, `systematic-debugging` before proposing a bug fix, `test-driven-development` before implementation,
  `requesting-code-review` before merging. They are process discipline; this file and `.claude/rules/` are the domain rules.

## Closing a session

Make all four consistent with what actually happened (`/session-close` walks it against the real diff):

1. `docs/session-log.md` — append what changed and what was learned.
2. Memory — add or extend a file for anything durable and non-obvious; update `MEMORY.md`.
3. `.claude/rules/` — if you hit a bug class that will recur, add its signature to `recurring-bugs.md`.
4. `docs/audit-findings.md` — close what you fixed (date + evidence); anything left open states its reason above.

Run `graphify update .` if files changed significantly. Silence in any of these means a future session rediscovers it from scratch.
