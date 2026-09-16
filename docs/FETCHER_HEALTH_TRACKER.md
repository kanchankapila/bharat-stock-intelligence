# Fetcher Health Tracker — Retired 2026-09-02

This file (originally written 2026-07-04, last updated 2026-08-29) is retired. Fetcher health
is now tracked two ways, both live rather than a manually-updated file:

1. **`npm run dq:check`** (`src/server/dataQualityChecks.ts`, ~150 checks) — freshness/coverage/
   range/plausibility checks against the tables every fetcher writes, on a continuous cadence,
   folded into the daily Telegram digest. This file's own 2026-07-19 header note already said
   this superseded it; the content below just never caught up to that.
2. **[`docs/audit-findings.md`](audit-findings.md)** — any *new* fetcher defect found by a manual
   sweep now gets a row there, not a new section here.

**The one thing still worth knowing from this file's history**: three data sources were, as of
the last check (2026-08-29), still genuinely broken upstream with no working alternative URL —
carried forward into `docs/audit-findings.md`'s 2026-09-02 consolidation entry (see "Still
genuinely open" → P4). Two other items this file's own later updates had already marked fixed
(`mf_holdings_fetcher.py`, `working_capital_fetcher.py`'s general breakage) had gone stale in
`ACTION_ITEMS.md`'s copy — that mismatch is exactly the kind of thing scattering trackers across
files causes, and part of why this consolidation happened.

Full prior content (137 lines: fetcher-by-fetcher pass results back to 2026-07-04, the false-alarm
list, the confirmed-working roster) remains readable via `git log -- docs/FETCHER_HEALTH_TRACKER.md`.
