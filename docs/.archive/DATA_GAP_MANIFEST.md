# Data-Gap Manifest — Retired 2026-09-02

This file (written 2026-06-21, updated through 2026-07-10) is retired. It was a forward-looking
plan for closing data gaps against a held-out AUC figure (~0.71) that is itself long superseded —
the honest, current number (a completely different, cost-aware label) lives in
`.claude/rules/measurement.md`, not here.

Nearly everything this manifest proposed is now built: IV rank/skew, exit-policy head, relative
strength, point-in-time fundamentals, analyst estimates, insider trades, market breadth, India
VIX, F&O positioning, promoter/pledge data — each already had its own ✅ marker in this file by
the time it stopped being updated, and the rest have since shipped too (`stock_futures_oi_history`,
`credit_rating_events`, `dalalos_financial_trends_history`, etc.).

**Where this content lives now:**
- **Which factors actually measure out as real edge** (not just "shipped") — `.claude/rules/
  measurement.md`. This is the important shift: shipping a feature and it *helping* turned out to
  be two different questions almost every time on this platform, and this manifest only ever
  answered the first one.
- **New-vendor onboarding discipline** (what to check before adding another feed) — `.claude/
  rules/data-sources.md`'s vendor-onboarding-freeze section, written specifically because more
  data kept not helping.
- **Available data source discovery (3,000+ endpoints)** — `.claude/rules/data-sources.md` §"Endpoint discovery registry" and `DATA_FETCHING_GUIDE.md`: query `market_endpoint_registry` in Postgres :5433 (3,408 endpoints), `url_endpoints` (830 templates via `--find-alternates`), and `unique_urls.txt` (3,103 raw URLs) before proposing new data sources or scrapers.
- **Open work items** — `docs/audit-findings.md`.

Full prior content (255 lines: the B1–B4/C1–C3/D/E1–E6 gap catalog, the sprint plan, the quant
priority ordering) remains readable via `git log -- docs/DATA_GAP_MANIFEST.md`.
