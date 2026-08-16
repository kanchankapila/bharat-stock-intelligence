---
name: deploy-and-verify
description: Take a finished code/migration/package change from "committed" to "actually live and producing correct rows" — restarts the right pm2 process, applies migrations against the real POSTGRES_URL, and re-runs the change against production to query the result back. Use when a change is about to be called done, when asked to deploy/restart/apply a fix, or before claiming any fix "is live."
---

# Deploy and Verify

This repo's own history is the reason this skill exists: `.claude/rules/recurring-bugs.md`'s
"Environment & deploy" section and CLAUDE.md's "Definition of done" both say committed ≠
deployed ≠ applied, and it still recurs because that's prose someone has to remember, not a
gate. Follow this end to end before calling anything done — don't stop at a green `tsc --noEmit`
or `pytest` run, both of which only prove the code runs, not that it's live or correct.

## 1. Identify what actually needs to move

| Change touches | Action required | It is NOT live until |
|---|---|---|
| `*.ts`/`*.tsx` reachable from `server.ts` | `pm2 restart bharat-server` | `pm_uptime` (below) postdates the fix commit |
| `*.py` under `src/server/python_api.py`'s surface | `pm2 restart ml-api` | same |
| `src/server/chatbot/*.py` | `pm2 restart chatbot` | same |
| `backend-python/*.py` | `pm2 restart alphaquant-api` | same |
| a new/changed migration file | `npm run migrate:up` against the **real** `POSTGRES_URL` | the column/table exists in production `information_schema`, not just a local/throwaway DB |
| a new package (`package.json`/`requirements.txt` entry) | `npm install` / install into the **correct venv** (`backend-python/venv`, not bare `python`) | the import actually resolves in the running process, not just on disk |
| BullMQ queue/cron definition (`queues.ts`, `jobs/*.jobs.ts`) | process restart AND check the job actually re-registers on the new schedule | next scheduled fire happens at the new time, confirmed via logs, not just the schedule table read back |

If the task touched more than one of these, do all of them — a session that restarts the server
but not the ML API on a change spanning both leaves half the fix undeployed with no error.

## 2. Restart and confirm identity, not just uptime

```bash
pm2 restart <name>
pm2 jlist | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(j.find(p=>p.name==='<name>').pm2_env.pm_uptime)"
```

Compare that timestamp against the fix commit's timestamp (`git log -1 --format=%cI <path>`).
If `pm_uptime` predates the commit, the restart didn't happen, hung, or crash-looped back to an
old build — check `pm2 logs <name> --lines 50 --nostream` before trusting anything downstream.

## 3. Migrations: applied, not just written

```bash
npm run migrate:up
```

Then confirm directly against Postgres — never trust the migration tool's own exit code alone,
since a `node-pg-migrate` run against the wrong `POSTGRES_URL` (or a `.env` that didn't load)
exits 0 having done nothing real:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = '<table>' AND column_name = '<new_col>';
```

Run `npm run schema:drift` after. A migration "written ≠ applied" gap is exactly the class that
silently broke a live job for days in this repo before.

## 4. The hand-run script trap

Any standalone `tsx`/`python` script used to verify the above must actually be talking to
production, not a different venv.

**Do NOT check `process.env.USE_POSTGRES` — that check is dead as of 2026-08-15 and now misleads
in the opposite direction.** `usePostgres()`/`use_postgres()` consult no environment variable for
any real process; they return Postgres unconditionally. A correct script prints `undefined` for
that variable. The SQLite fallback that made the check necessary no longer exists outside a test
runner.

What still needs verifying is the *number*, not the dialect: assert a row count in the script's
own output against a number you already know from a direct `psql`/`db_compat` query. A script that reports numbers wildly off from what you know to
be true (an order of magnitude, a different resolved id, a suspiciously round number) is talking
to the wrong database — this exact mistake reported 121,669 rows once against a real 435,700, and
resolved a *different* provider id for the same entity than production held. For Python, confirm
`which python` (or the venv path used) is `backend-python/venv/bin/python` — bare `python` on
PATH is a different install with a different sklearn/pandas and has silently produced wrong
results before.

## 5. Live-verify the actual change, not just its plumbing

Re-run the specific code path the fix touches against real production data, and query the
result back — this is `.claude/rules/measurement.md`'s reverse-engineering discipline applied to
deploys, not just to signal claims. Examples of what "query the result back" means concretely:
a fetcher fix → re-run it for one real symbol, then `SELECT` the row it just wrote and check the
columns are non-NULL/finite, not just that the script exited 0; a scoring change → confirm the
before/after `stock_scores`/`unified_recommendations` row counts moved the way expected, not
just that the job logged success; a freshness-check addition → confirm it actually fires red
against a deliberately stale table before trusting it reads green on a healthy one.

## 6. Report

State explicitly, for each moving part: committed (commit hash), deployed (`pm_uptime` check
passed / process name), applied (migration confirmed in `information_schema`, if relevant),
live-verified (the specific query/re-run and what it showed). A "done" that skips any of these
four is not done — say which step was skipped and why, rather than rounding up to "deployed."
