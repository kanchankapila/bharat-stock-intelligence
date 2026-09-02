# Action Items — Retired 2026-09-02

This file is retired. All pending/open work items now live in one place:
**[`docs/audit-findings.md`](docs/audit-findings.md)** — the audit-loop skill's ledger, with a
"never delete a row, close it with a date" discipline that this file never had.

Every item this file still listed as open was re-verified against current code on 2026-09-02
and carried forward — most turned out already fixed (see `docs/audit-findings.md`'s
"2026-09-02 — Consolidation pass" section, `AF-20260902-01` through `-14`). The two genuinely
still-open, non-trivial items (extending the breakout classifier's features; the unreached
risk-parity sizing path in `portfolio.ts`) and the vendor-blocked fetchers awaiting a working
URL are carried forward there too, under "Still genuinely open."

This file's full prior history (216 lines, reconciliation passes back to 2026-07-02) remains
readable via `git log -- ACTION_ITEMS.md` if the narrative is ever needed — nothing was lost,
only consolidated.
