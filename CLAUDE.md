# Bharat Stock Intelligence — Claude Instructions

Real-time Indian stock market intelligence platform (NSE/BSE). Express + tRPC backend, React 19 + Vite frontend, PostgreSQL/TimescaleDB, BullMQ jobs, ~30 Python ML engines.

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

`docs/session-log.md` is the historical changelog (743 lines). Not loaded automatically; read a specific entry when you need the history behind a decision.

## Definition of done

A task is **not** done until the relevant check has actually run and passed. Claiming "done" without one is the single most repeated failure in this repo's history.

```bash
npx tsc --noEmit                                    # any .ts change
npx vitest run                                      # any .ts logic change
python -m pytest src/server/__tests__/ src/server/tests/  # any .py change (identical to CI)
npm run schema:drift                                # any migration
```

Plus, for anything touching signal/scoring/model logic:

- **Negative-control your tests.** Revert the fix, confirm the new test fails, restore. A green suite that never failed against the bug protects nothing.
- **Run it against live production data and query the result back.** `tsc --noEmit` and a green suite do not tell you a fetcher wrote the right rows. See `.claude/rules/measurement.md`.
- **Committed ≠ deployed.** `.ts` needs `pm2 restart bharat-server`; a migration needs `npm run migrate:up` against the real `POSTGRES_URL`; a package needs `npm install` / the right venv.

## Knowledge graph

Query before reading source files:

```powershell
$PY = Get-Content "graphify-out/.graphify_python"
& $PY -m graphify query "<question>"     # or: path "A" "B" | explain "Symbol"
& $PY -m graphify update .               # after significant changes
```

~13.2k nodes / 21.3k edges over ~1029 files. Check `graphify-out/GRAPH_REPORT.md`'s freshness hash against `git rev-parse HEAD` before trusting it.

## Layout

```
src/
  App.tsx            main app, layout + tab routing
  v2/ … v6/          six dashboard experiences, all lazy-loaded, all reading the same tRPC surface
  components/        36+ shared React components
  services/          marketService (live prices), aiService (Ollama), geminiService (fallback)
  lib/trpc.ts        tRPC client
  data/              stocklist.ts (180 stocks, all provider mappings) · nseStocks.ts (2000+ NSE master)

src/server/
  router.ts          ALL tRPC procedures — check here before searching elsewhere
  routers/*.ts       domain-split procedure modules
  db.ts              SQLite schema-of-record + dev fallback (NOT the live Postgres shape)
  dbAsync.ts         → pgClient.ts   the live Postgres facade
  queues.ts          BullMQ definitions + all cron schedules
  jobs/*.jobs.ts     decomposed job registrations
  cacheService.ts    Redis → in-memory fallback
  dataQualityChecks.ts   62 freshness/coverage checks, daily cron + Telegram
  *.py               ML engines — canonical ranker is unified_ranker.py
```

Component/procedure/table inventories are deliberately **not** listed here — they rot. Grep the source.

## Frontend versions

Six dashboards coexist in one app, no separate build. `App.tsx`'s `dashboardVersion` (localStorage) selects; **fallback is `v6`** — that's what a fresh visitor lands on.

| | Shell | Notes |
|---|---|---|
| v1 | `AppShell` | classic tab list |
| v2 / v3 | `V2AppShell` | v3 = Bloomberg-terminal restyle |
| v4 | inside `V2AppShell` | `MarketCommandCenter`, `StockIntelligencePage` |
| v5 | own route tree at `/v5` | institutional workbench + desk pages |
| v6 | `V6Shell` | **default** — composed home + portfolio tracker + screener browser |

Nothing is deprecated. Before trusting any "fix applied to the nav/shell" claim, check *which shell* it landed in — a comment saying it was mirrored has been wrong before.

## Architecture facts that constrain changes

- **Canonical ranking is `unified_recommendations`** (`unified_ranker.py`). `stock_scores` and `quant_scores` are its *inputs*, not duplicates. Never write a parallel "final" score. Details: `.claude/rules/scoring-authority.md`.
- **Four signal tables, and that's the ceiling**: `unified_signals`, `technical_signals`, `signal_outcomes`, `unified_signal_outcomes`. Do not add a fifth. The merges you might consider have been investigated and rejected on their merits — see the rule file before re-proposing one.
- **NSE symbol is the only canonical identifier.** Every provider id derives from it, never the reverse, and is never constructed by convention.
- **Live DB is Postgres/TimescaleDB** (`USE_POSTGRES=true`, :5433). Several tables are compressed hypertables where a predicate-wide `UPDATE`/`ADD CONSTRAINT` will fail or destroy compression.
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
