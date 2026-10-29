# Bharat Stock Intelligence — Claude Instructions

Real-time Indian stock market (NSE/BSE) research and decision-support platform. Express + tRPC
backend, React 19 + Vite frontend, PostgreSQL/TimescaleDB, BullMQ jobs, 322 non-test Python modules
in `src/server/` (89 `*_fetcher.py` plus ML engines, jobs and helpers; 807 `.py` files including tests).

What the product is for and the contracts a change must preserve: `CONTEXT.md`. Skills, commands,
subagents and hooks: `AGENTS.md`. Services, layout, hook enforcement and full architecture notes:
`docs/agent-operations.md`.

> **Counts drift.** Every number in a doc is a dated snapshot; `npm run doc:numbers:check` fails on
> drift. Never hand-write a count into a doc or comment.

## Read first

1. **`fable-brain.md`** — standing reasoning discipline; applies to every task.
2. **Memory** — `C:\Users\amitk\.claude\projects\d--Github-bharat-stock-intelligence\memory\MEMORY.md`, plus
   `.agents/memory/MEMORY.md` and `.agents/memory/session_journal.md` (append a dated section per session).
3. **The rule file for what you touch** — it loads on first read of a matching file (`paths:` frontmatter),
   but NOT when you only *quote* a number: then read `measurement.md` yourself.

| Touching… | Read |
|---|---|
| scoring, ranking, any `*_signals` / `*_outcomes` table | `.claude/rules/scoring-authority.md` |
| a fetcher, a provider, a provider-issued id, onboarding/triaging a datasource | `.claude/rules/data-sources.md` |
| any accuracy / win-rate / IC / backtest number | `.claude/rules/measurement.md` |
| a model, a promotion gate, a measurement harness | `.claude/rules/ml-model-bugs.md` |
| `docs/audit-findings.md` — opening, updating or closing any finding | `.claude/rules/findings-ledger.md` |
| **anything** — skim before writing Python or SQL | `.claude/rules/recurring-bugs.md` |

`docs/session-log.md` is the historical changelog (~7,600 lines — never load it whole; grep a dated entry).

## Resolve findings, don't just log them

A finding is done only when **fixed, verified against live production, and closed with a date and
evidence** — in the same session. Every fix ships with a regression test shown to FAIL on the unfixed
code, named in the ledger row's `Immunized` cell. `docs/audit-findings.md` is the **only** open/pending
tracker for every agent (stable `AF-YYYYMMDD-NN` ids; never delete a row; re-read a row before updating it).
A row may stay open only for EVIDENCE, calendar-blocked, needs-a-user-decision or depends-on-another-row;
the full rules, the dead-vendor lookup order and the shared-backlog contract are in
`.claude/rules/findings-ledger.md`. Run `npm run backlog:check` and `npm run findings:check` before handing off.

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
CI runs 3.12. For anything touching signal, scoring or model logic, also: **negative-control your tests**
(revert the fix, confirm the test fails, restore); **query the result back from live production** with
`backend-python/venv/Scripts/python.exe scripts/sql.py "<SQL>"`; and remember **committed ≠ deployed**
(`.ts` needs `pm2 restart bharat-server`, a migration `npm run migrate:up` against the real `POSTGRES_URL`).
`/deploy-and-verify` does it end to end. Hooks enforce this (`verify-gate.mjs` reads your real Bash calls);
details in `docs/agent-operations.md`.

## Knowledge graph

Query before reading source files: `& (Get-Content graphify-out/.graphify_python) -m graphify query "<question>"`
(or `path "A" "B"` / `explain "Symbol"`); run `graphify update .` after significant changes.

## Architecture facts that constrain changes

- **Canonical ranking is `unified_recommendations`** (`unified_ranker.py`); never write a parallel "final" score.
- **Four signal tables, and that is the ceiling**: `unified_signals`, `technical_signals`, `signal_outcomes`,
  `unified_signal_outcomes`.
- **NSE symbol is the only canonical identifier**; provider ids derive from it, never by convention.
- **Postgres/TimescaleDB (`:5433`) is the only database** — and a developer's Postgres IS production. Python
  tests use `pg_memory_conn()` / `pg_conn` / `pg_db_conn`, never `sqlite3.connect`; test against an EMPTY
  database (`PGTEST_DB=<empty db> pytest ...`) before believing a pass. Several tables are compressed
  hypertables where a predicate-wide `UPDATE` / `ADD CONSTRAINT` fails or destroys compression.
- **The ranker has no demonstrated forward-return edge**; read `measurement.md` before proposing any reweighting.
- **v1 (`src/v1/V1Routes.tsx`) is the only route tree** (TALA at `/tala/*` aside); a fix lands there or it does
  not ship. **Before editing a component, confirm a route renders it** (grep its import). Do not add another surface.
- **`.ts` is not hot-reloaded and Python services import modules at start** — restart the service you changed.

## Conventions

- No comments unless the WHY is non-obvious. No error handling for impossible scenarios. No refactoring beyond the task.
- Reuse an existing helper before writing a new one.
- Multiple sessions edit this repo concurrently: commit **by explicit path**, never `git add -A`, and re-check `git status` right before committing.
- Land work on `main` and close it in the ledger; do not leave open work on feature branches.
- Test first: write the failing test, see it fail for the right reason, then fix (see Definition of done). Use the
  `superpowers` skills when a task needs them (`systematic-debugging` for a live bug, `brainstorming` for a new
  feature), not on every change.

## Closing a session

`/session-close` walks it against the real diff: append `docs/session-log.md`; add or extend memory for anything
durable (update `MEMORY.md`); add a recurring bug class to `recurring-bugs.md`; close what you fixed in
`docs/audit-findings.md` (date + evidence) and state why anything left open is still open. Run `graphify update .`
if files changed significantly.
