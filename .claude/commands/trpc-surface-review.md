---
description: Review a tRPC procedure (new or existing) in router.ts/routers/*.ts against this repo's SQL-dialect, NaN-handling, and freshness conventions — the backend-code counterpart to fetcher-accuracy-review for procedures that don't fetch external data
---

# tRPC Surface Review

`/fetcher-accuracy-review` covers fetchers that hit external URLs. This covers the other half of
`src/server/router.ts`/`routers/*.ts` — procedures that only query the repo's own tables — which
has no dedicated review and inherits every bug class in `.claude/rules/recurring-bugs.md` without
any of them being fetcher-specific to notice.

## 1. Locate the procedure

Find its definition and its full call chain down to the SQL it issues (via `dbAsync.ts`/
`pgClient.ts`, or a raw query). Note whether it's `publicProcedure` or `protectedProcedure`, and
whether it's actually referenced from the frontend (`grep -rF "<procedureName>" src --exclude-dir=server`)
— an orphaned procedure under review is lower priority than one actively serving a dashboard;
flag it either way per `/canonical-read-audit`.

## 2. SQL dialect checks (`recurring-bugs.md`'s "SQL dialect" table)

- Raw `%s` placeholders in a Postgres branch instead of `?` through `translate()`.
- Multi-word casts (`::double precision`) — use `::float8`; `stripPgCasts` only matches
  single-token type names.
- `STDDEV`, `DISTINCT ON`, `NOW()`, `ANY(ARRAY[])` — Postgres-only. Every *real* process is on
  Postgres (`usePostgres()` reads no env var outside a test runner), so these are safe in
  production; the risk is the **vitest** path, where `dbAsync` still has a SQLite arm. Also watch
  the hazard that was always the real one: a query failure behind a `.catch(() => null)` that
  disables a gate silently instead of erroring.
- Any `ORDER BY <date_column>` — confirm that column actually exists on the queried table via
  `information_schema.columns`, **not** from `db.ts`, which describes the SQLite test schema and
  has been wrong about the tables it does describe. This has aborted whole queries (and nulled
  every sibling column in the same `SELECT`) three separate times here.

⚠ **Corrected 2026-08-16:** an earlier revision claimed `dbAsync` had no SQLite arm and `db.ts`
was retired. That described an in-flight branch that was later **discarded**. Verify against the
files before trusting either claim.

## 3. NaN/null checks (`recurring-bugs.md`'s "NaN & null" table)

- `float(x or 0)`/`int(x or 0)` on any model-output or aggregate column — `nan or 0` is `nan`, not
  `0`; should be `math.isfinite` + skip, not coerce.
- `x != x` used as a NaN test in a Postgres query — Postgres treats `NaN = NaN` as TRUE, so this
  test matches nothing. (Fine in plain Python/JS, only wrong in SQL.)
- `ORDER BY <col> DESC` on a column that can hold NaN — Postgres sorts NaN highest, so an
  unguarded sort silently ranks NaN rows #1. Needs `NULLIF(col, 'NaN'::float8)`.

## 4. Freshness and honesty of what gets returned

- Does the procedure return a bare number/score with no as-of timestamp the frontend could
  surface? If the underlying table has known staleness risk (per `dataQualityChecks.ts`), the
  procedure returning no freshness metadata pushes the problem onto the frontend, which likely
  won't handle it either — see `/data-honesty-review`.
- Does the procedure read from `stock_scores`/`quant_scores` directly where
  `unified_recommendations` is the documented canonical source? Cross-check against
  `/canonical-read-audit`'s output if it exists.

## 5. Report

Per procedure: file/line, which checks it passed/failed, and — for anything reading a
date-ordered or NaN-capable column — whether the failure mode is a loud error (safe, if annoying)
or a silent `{}`/NULL/wrong-rank result (the dangerous case, prioritize these). Don't fix inline
unless asked; this is a review, and the multi-column-`SELECT`-abort class in particular has
historically needed the exact query traced by hand before a safe fix is obvious.
