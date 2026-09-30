# Project Context — Bharat Stock Intelligence

Domain orientation for agents. `CLAUDE.md` is the operating manual (rules, Definition of done,
services); this file is the "what is this system" map. Every fact below was checked against the
code on 2026-09-26 — where a number drifts, this file points at the source of truth instead of
copying it, because copied inventories are what went stale here before (the previous version
named 5 fetchers that do not exist and a GPT-4o agent file that never did).

## What it is
Indian equity (NSE/BSE) intelligence platform: 82 `*_fetcher.py` (of 290 non-test Python modules in `src/server/`;
678 `.py` files including tests — measured 2026-09-29) pull vendor data into
Postgres/TimescaleDB, engines score every stock, and `unified_ranker.py` blends them into one
canonical ranking the React UI, Telegram digests and the chatbot read.

Counts in this file are a dated snapshot. Re-derive every one with `node scripts/docNumbers.mjs`
(`--check` exits non-zero when a doc has drifted from the live filesystem/DB).

## Data flow
```
vendors (NSE, MoneyControl, Trendlyne, NiftyTrader, MarketsMojo, ET, Yahoo, ...)
  → *_fetcher.py  (scheduled by BullMQ: src/server/queues.ts + src/server/jobs/*.jobs.ts)
  → Postgres :5433 (bharat_intel)
  → feature_engineering.py → feature_store
  → engines: scoring_engine.py (stock_scores), quant scoring (quant_scores),
             ml_ensemble.py / dl_engine.py / confluence / technical  (component scores)
  → unified_ranker.py → unified_recommendations   ← THE canonical ranking
  → tRPC (src/server/routers/*.ts) → React (src/v1/V1Routes.tsx) / Telegram / chatbot
```

## Sources of truth (read these, don't trust a copy)
| Question | Where the answer lives |
|---|---|
| What jobs run, when (cron is **UTC**) | `src/server/jobRegistry.ts` (72 entries) — mirrors `queues.ts`/`jobs/*.jobs.ts` |
| Which tables are monitored for freshness | `TABLE_FRESHNESS_CHECKS` + checks in `src/server/dataQualityChecks.ts` |
| Table schemas | `db/schema.postgres.sql` (regenerated from live; `npm run schema:drift` to diff) |
| Provider id per stock | `src/data/stocklist.ts` via `src/server/stockMapping.ts` |
| Which engines feed the ranker, and weights | `REGIME_WEIGHTS` in `src/server/unified_ranker.py` |
| Does factor/engine X have edge? | `.claude/rules/measurement.md` + `factor_edge_history` table |
| Open bugs / follow-ups | `docs/audit-findings.md` (the only tracker) |
| History behind a decision | `docs/session-log.md` (grep, never load whole) |

## Schedules worth knowing (UTC crons; IST = UTC+5:30)
- `ml-weekly-data` Fri 18:00 → `ml-weekly-retrain` Sat 05:00 → `dl-retrain-weekly` **Sun** 05:00.
  ML and DL were deliberately day-separated (they jointly exhausted host memory); do not re-merge.
- Post-close daily chain and intraday jobs: see `jobRegistry.ts`; post-close jobs routinely finish
  after IST midnight, which is why writes anchor on `as_of.logical_trading_date()`, never `date.today()`.

## Measured state (don't assume edge)
The ranker reads a small positive rank IC that is still LOW-DATA and has never passed a cost-aware
backtest; most published factors are null or inverted on this data. Read `measurement.md` before
proposing any reweighting — it is usually the wrong fix.

## Endpoint discovery (before calling a vendor dead or writing a new scraper)
`market_endpoint_registry` (3,408 endpoints, Postgres) → `url_endpoints` /
`python -m url_explorer.ingest --find-alternates` (from `src/server`) → `unique_urls.txt` → repo grep →
only then ask the user, with a per-route breakdown. Caveats and overrides: `.claude/rules/data-sources.md`.

## Diagnosing against production
- Read-only SQL: `backend-python/venv/Scripts/python.exe scripts/sql.py "<SQL>"` (server-side
  timeout, read-only transaction, prints the target DB). Prefer it over a new `scratch_verify/` script.
- Health sweep: `node .claude/skills/repo-doctor/doctor.mjs`; data quality: `npm run dq:check`.
- Committed ≠ deployed: `node scripts/check_deploy_drift.mjs` (note: it also stamps a heartbeat row).

## Issue tracking
Findings/bugs: `docs/audit-findings.md` (`AF-YYYYMMDD-NN`), **not** GitHub Issues. GitHub
(`kanchankapila/bharat-stock-intelligence`) via `gh` for PRs. Triage label roles, if the triage skill
is ever installed: `.claude/skills/setup-matt-pocock-skills/triage-labels.md`.
