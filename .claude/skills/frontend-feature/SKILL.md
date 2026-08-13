---
name: frontend-feature
description: Build or modify a React feature in this repo's frontend, where there are zero component tests and six coexisting dashboard shells reading the same live tRPC surface with no test-mode stub data. Use when asked to build/change a UI feature, add a component, or fix something visual/interactive in the dashboards.
---

# Frontend Feature Workflow

This frontend has **0 `.test.tsx` files** across 155 components/pages. `npx tsc --noEmit` is the
only automated signal a change compiles; nothing automated tells you it renders correctly, reads
the right data, or handles a real API response shape. That gap is why this skill exists — it
forces the manual verification loop that would otherwise get skipped under time pressure.

## 1. Place the change deliberately

Six shells coexist (`CLAUDE.md`'s "Frontend versions" table) — v1/`AppShell`, v2+v3/`V2AppShell`,
v4 (inside `V2AppShell`), v5 (own route tree), v6/`V6Shell` (**default** for a fresh visitor).
Decide explicitly which shell(s) this belongs in before writing code:

- A fix to a shared bug → the shared component in `src/components/`, verified across every shell
  that imports it (see `/shell-parity-audit`), not just the one you're looking at.
- A new feature request without a named shell → ask, or default to v6 since that's what most
  users see; don't silently build it somewhere else because that's the file you had open.

## 2. Reuse before writing

103 components already live in `src/components/`. Grep for existing patterns before adding a new
one — a stat tile, a data table, a signal badge, a loading/empty state almost certainly exists
already:

```bash
grep -rl "useQuery\|StatTile\|DataTable" src/components --include=*.tsx | head -20
```

## 3. Read the correct data source

Before wiring a new `trpc.*.useQuery` call, check `/canonical-read-audit`'s classification for
anything ranking/score-shaped — do not read `stock_scores`/`quant_scores` directly, or present a
screener-membership table as a signal, when `unified_recommendations` is the canonical source.
For anything else, check `src/server/router.ts`/`routers/*.ts` for the procedure's actual
implementation rather than assuming from its name what table it reads.

## 4. Handle the real shape of live data explicitly

There is no test-mode stub data — every screen reads live tRPC queries against a real,
imperfect, sometimes-NULL, sometimes-stale database (per `recurring-bugs.md`'s "Monitoring blind
spots" and `data-honesty-review`'s whole premise). For any new data-bound component, handle these
states as distinct, not collapsed into one silent blank:

- **Loading** (query pending) vs **empty** (query resolved, zero rows) vs **NULL/partial**
  (row exists, specific fields are null) — these are different facts and a user reading a blank
  or a `0` where a NULL belongs is being told something false.
- **Staleness** — if the component shows a score/signal/price, does it show an as-of timestamp,
  or could a user be looking at yesterday's number with no way to tell?

## 5. Verify against the real running app, not just `tsc --noEmit`

`tsc --noEmit` passing means the code compiles; it says nothing about whether the component
renders, whether the query actually returns the shape assumed, or whether it looks right. Use the
`run-bharat-stock-intelligence` skill to start the app and drive it with the Playwright
script-runner, then:

1. Load the actual shell the feature lives in (`localStorage.dashboardVersion` if not v6).
2. Screenshot the real rendered state — loading, populated, and (if reachable) an empty/NULL case.
3. If the feature reads a table known to have coverage gaps (per `measurement.md`/
   `recurring-bugs.md`), deliberately check a symbol/date likely to hit a NULL or missing row,
   not only the happy path.

## 6. Report

State plainly which shell(s) got the change, what data source backs it, and that it was
screenshotted against the live app — not just compiled. If the feature was requested for "the
dashboard" with no shell specified, say which one you chose and why.
