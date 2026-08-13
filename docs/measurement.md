# Greenfield DB — Measurement Notes

Distinct from `.claude/rules/measurement.md`, which covers the old/live platform. This file
tracks measurement facts specific to the rebuilt (`greenfield/`) database.

## Provenance boundary date

```
provenance_boundary_date: 2026-08-12
meaning: rows with session_date < this date have provenance_quality='inferred' in any
         Stage-3-and-later table. Point-in-time research spanning this boundary must state it.
recorded_via: audit_metric (run_id=958f67ab-8824-494d-a94c-431e2aa76629, metric_name='provenance_boundary_date',
              code_commit=6db84bd)
```

This is the last date with a complete `market_bar` panel from the real Stage 2 NSE bhavcopy
backfill (zero `trading_session` dates ≤ this date lack a `market_bar` row). Stage 3's Class Q
transfer (screener membership, fundamentals, FII/DII, corporate actions) writes rows stamped
`provenance_quality='inferred'` because they come from vendor point-in-time data that cannot be
re-fetched from a provider archive the way Stage 2's bhavcopy can — the boundary date is not a
data quality problem, it is the dividing line between "rebuilt from source" and "carried over".
