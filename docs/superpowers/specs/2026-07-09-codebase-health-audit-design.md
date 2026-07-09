# Codebase Health Audit — Design

**Sub-project 1 of 4** in a larger effort requested by the user: (1) codebase health audit, (2) quant/ML verification & wiring audit, (3) hit-vs-miss analysis audit, (4) live paper-trading mode. This spec covers sub-project 1 only; the other three get their own specs later.

## Goal

Proactive, general error sweep across the backend (no specific incidents reported by the user) — find and fix crashes, silent failures, and obvious logic bugs before building the quant-verification work (sub-project 2) on top of it.

## Scope

**In scope:** `router.ts`, `src/server/*.ts` (services, `queues.ts`, `cacheService.ts`, `db.ts`, `pgClient.ts`, `routers/*.ts`), and the ~30 Python engines in `src/server/*.py`.

**Out of scope:** frontend (`src/App.tsx`, `src/components/`, `src/v2/`, `src/v3/`) — explicitly deferred per user decision.

## Architecture

Three parallel audit agents (foreground, run concurrently — results are needed before the fix pass can start):

- **Agent A — TS server layer.** `router.ts` + `src/server/*.ts` + `routers/`. Runs `tsc --noEmit`, greps for swallowed-error patterns (`catch {}`, `.catch(() => {})`, bare `catch(e)` with no rethrow/log), unhandled promise rejections, and specifically rechecks for recurrence of the known pattern where a BullMQ job handler returns `{success:false}` instead of throwing (causing jobs to be silently marked "completed" — this exact bug caused weeks of stale `stock_scores` per project memory).
- **Agent B — Python engines.** Smoke-imports each of the ~30 files in `src/server/*.py`, runs `--dry-run` where the script supports it, checks for raw `sqlite3`/`psycopg2` calls bypassing `db_compat` (anti-pattern per CLAUDE.md), and greps for bare `except: pass`.
- **Agent C — DB/schema consistency.** Compares `db.ts` schema-of-record against actual Postgres usage; checks for schema-drift bugs (pattern: a column exists in one DB flavor's code path but not the other, like the `fcf_yield_approx` incident in project memory); rechecks for recurrence of the "AlphaQuant split-brain" pattern (a Python engine silently writing SQLite while the app reads Postgres because it didn't load `.env`/`USE_POSTGRES=true`) across the other engines, not just AlphaQuant.

Each agent returns structured findings: file, line, severity, one-sentence description, proposed fix.

## Fix Policy

After synthesizing all three reports:
- **Auto-fix inline:** compile/type errors, unhandled exceptions, swallowed-error anti-patterns, obvious logic bugs (wrong variable reference, off-by-one, null-deref, dead/broken imports).
- **Flag for user review, do not touch:** anything that changes scoring math, trading thresholds, DB writes/schema, or requires a behavioral judgment call rather than a clear-cut correctness fix.

## Verification

After fixes are applied:
- `tsc --noEmit` passes clean.
- All touched Python engines re-smoke-import without error.
- Any touched engine with a `--dry-run` flag is re-run and confirmed non-crashing.

No commit happens until verification passes.

## Deliverable

Not a written doc — this is investigative/bug-fix work. Output is:
1. A findings + fixes summary reported in chat (what was found, what was auto-fixed, what's flagged for review).
2. The actual code fixes, committed separately from the flagged-items discussion (so risky items don't block landing the safe fixes).

## Self-Review

- No placeholders/TBDs — scope, agents, fix policy, and verification are all concrete.
- No internal contradictions — frontend exclusion stated once and consistent throughout.
- Scoped to a single implementation pass (3 parallel agents + 1 synthesis/fix pass); not decomposed further because the pieces (A/B/C) are audit slices, not separable deliverables.
- No ambiguity: "straightforward" vs "risky" fix criteria are stated explicitly in Fix Policy.
