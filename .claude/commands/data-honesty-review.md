---
description: Check whether a frontend surface renders missing/stale/NULL backend data as if it were a real, current value — the UI-facing instance of this repo's dominant "looks healthy, is actually broken" bug class
---

# Data Honesty Review

Every incident in `.claude/rules/recurring-bugs.md`'s "Monitoring blind spots" section is the
same shape: something reports healthy while quietly not delivering what it exists to deliver
(21 of `ml_ensemble.py`'s 254 inputs 100%-NULL while the monitor read 86 pass/1 fail;
`entry_price` NULL on 100% of a day's `recommendation_log` rows behind a query that silently
aborted). None of those incidents checked what a human actually saw on screen. This review is
that missing layer — one component/page at a time, or swept across the app.

## 1. Trace data to render, not just data to query

For the component under review, follow the tRPC call to its result, then follow the result through
to what actually renders for each of these states — do not assume from the component's structure;
check each state produces visibly different output:

- **NULL/undefined field on an otherwise-present row.** Does it render blank, `0`, `N/A`,
  `--`, or does it silently coerce (`{value || 0}`, `{value ?? 0}`) into a real-looking number?
  A coerced `0` presented next to real numeric values is a lie a user can't detect — same failure
  as `float(x or 0)` in `recurring-bugs.md`, one layer up the stack.
- **Empty result set** (query resolved, zero rows) vs **loading** (query pending). Collapsed into
  the same UI state, a user can't tell "nothing to show" from "still fetching" from "broken."
- **Stale data.** If the component shows a score, signal, price, or ranking, is there an as-of
  timestamp anywhere in the render, or could this be showing a value from a job that silently
  stopped running days ago with no visual difference from a fresh one?
- **Partial/degraded data** — e.g. a composite score built from several inputs where some are
  NULL. Does the UI show the same confidence/emphasis regardless of how many inputs actually
  fed it, or does missing-input-derived output look identical to fully-supported output?

## 2. Cross-check against known-bad columns

If reviewing a surface that reads any table flagged elsewhere as having NULL/staleness issues —
`technical_signals` (21+ historically-NULL inputs), `recommendation_log` (its enrichment columns
have aborted silently before), any table without a freshness check per `/data-coverage-audit` —
deliberately query a real row with a NULL in the field the component displays, and check what
renders for it, rather than only checking the happy-path row.

```sql
-- example: find a row this component would render badly
SELECT * FROM <table> WHERE <field_the_component_shows> IS NULL LIMIT 1;
```

Then load that specific symbol/date in the running app (via `run-bharat-stock-intelligence`) and
screenshot what actually shows.

## 3. Check for a false sense of confidence in derived UI (badges, colors, conviction labels)

A "Strong Buy"/"Strong Sell" badge, a green/red color, or a conviction tier rendered from a score
that could itself be corrupted (per the neutral-tag-as-bearish and quant_scores-column-doesn't-exist
incidents in `recurring-bugs.md`) presents high visual confidence regardless of input quality. This
review does not re-derive whether the *score* is correct (that's `/measurement-integrity-review`'s
job) — it checks whether the *UI* communicates uncertainty at all when the score's own inputs are
degraded, or presents every score with identical visual conviction.

## 4. Report

Per surface reviewed: the specific NULL/stale/empty state tested, what actually rendered
(screenshot if driven live), and whether it's indistinguishable from a healthy state. Rank by
how many users would see it — the default v6 shell's surfaces outrank a v1-only legacy view.
