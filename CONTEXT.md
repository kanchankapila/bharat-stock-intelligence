# Project Context — Bharat Stock Intelligence

Orientation for engineers and AI assistants working in this repository. This file explains the
product goal, the live system shape, and the principles changes must preserve. `CLAUDE.md` and
`AGENTS.md` are the operating manuals for detailed rules, workflows, and verification gates;
follow them rather than copying their volatile inventories here.

## Product Goal
Bharat Stock Intelligence (also branded AlphaQuant Pro in the README) is an Indian equity
(NSE/BSE) research and decision-support platform. It brings fragmented market, company, derivatives,
macro, screener, and news data into one system, applies analytical and statistical models, and
surfaces stock research, signals, rankings, and portfolio/risk views through the application and
its connected services.

The product is being built to make that research more dependable and useful over time: data should
be traceable and timely, outputs should carry their horizon and evidence, and model or scoring
changes should earn trust through out-of-sample and cost-aware measurement. The platform contains
outcome tracking, backtesting, and model-training workflows; their existence is infrastructure for
learning and evaluation, not proof that recommendations are profitable or that the system improves
automatically.

Treat displayed recommendations as decision-support outputs, not guaranteed returns or evidence
that a trade was executed. Separate what the code currently does from what the product is intended
to achieve.

## Live System Shape
The main flow is:

```text
External data providers
  -> Python fetchers and TypeScript services, run directly or by BullMQ jobs
  -> PostgreSQL/TimescaleDB
  -> feature construction and domain engines (technical, fundamental, derivatives, macro,
     screeners, sentiment, ML/DL, and related research systems)
  -> component scores and signals
  -> unified_ranker.py -> unified_recommendations
  -> Express/tRPC APIs and WebSocket -> the React application, Telegram, and chatbot surfaces
```

Outcome resolution, backtests, model evaluation, and monitoring provide feedback for research and
operations. Do not assume every source follows this exact path or that a feedback loop is
autonomous; inspect the relevant writer, consumer, and job before changing one.

This checkout currently has 82 Python `*_fetcher.py` modules and 73 `JOB_REGISTRY` entries
(re-derived 2026-10-03). These are inventory snapshots, not targets or enduring truths; rerun
`npm run doc:numbers` and `npm run doc:numbers:check` before quoting or updating them.

### Main Ownership Boundaries
- `server.ts` and `src/server/routers/`: Express/tRPC API; `src/server/router.ts` merges the domain
  routers.
- `src/server/queues.ts` and `src/server/jobs/`: BullMQ queues, schedules, and job registrations.
- `src/server/`: Python data fetchers, scoring and ML/DL engines, outcome resolution, and shared
  server services.
- `src/data/` and `src/server/stockMapping.ts`: canonical stock universe and provider-symbol maps.
- `src/App.tsx`, `src/v1/V1Routes.tsx`, and `src/components/`: the live React application. There is
  one active v1 route tree; former-version components may remain under `src/components/v*/` but are
  rendered as ordinary v1 components.
- `db/schema.postgres.sql`: checked-in PostgreSQL schema reference.

`bharat_alpha/` is a from-scratch, point-in-time, self-grading rewrite the live application does not import;
its README explains the design and why it is not yet serving users, and a change there does not change the
running product. (Two earlier rebuilds, `greenfield/` and `bharatquant/`, were never wired in and were removed
2026-10-03; any reference to them is stale.)

## Measured State Of The Edge
The ranker has a small positive rank IC that is still LOW-DATA and has never passed a cost-aware
backtest; most published factors tested here are null or inverted on this data. The realistic goal is a
modest, honestly-measured cross-sectional edge (rank IC of roughly 0.05-0.10), not high accuracy, and the
system's job includes refusing to present an unproven ranking as trustworthy. Read
`.claude/rules/measurement.md` before proposing any reweighting — it is usually the wrong fix.

## Contracts To Preserve
- **One database:** PostgreSQL/TimescaleDB is the production database. Do not add a SQLite runtime
  path; Python tests use the explicit PostgreSQL test helpers described in `CLAUDE.md`.
- **One stock identity:** the NSE symbol is canonical. Provider identifiers map from it and must
  never be used to invent or reverse-engineer the canonical symbol.
- **One canonical cross-source ranking:** `unified_recommendations`, written by
  `src/server/unified_ranker.py`, is the final ranking surface. `stock_scores` and `quant_scores`
  are component inputs, not parallel final recommendations. New scoring work should feed the
  existing authority rather than create a competing final score or UI read path.
- **Keep signal storage bounded:** the signal-table design has an explicit ceiling. Read
  `.claude/rules/scoring-authority.md` before changing signal writers, outcome schemas, or consumers;
  do not add another signal table or merge existing tables based only on naming similarity.
- **Preserve time and information boundaries:** use the repository's logical trading-date helpers
  (`as_of.logical_trading_date()`, never `date.today()` — post-close jobs routinely finish after IST
  midnight), respect exchange calendars and source availability, and prevent future information from
  leaking into historical features or evaluations. A missing or stale value is not automatically zero.
  Cron expressions in `queues.ts` / `jobRegistry.ts` are **UTC** (IST = UTC+5:30).
- **Do not re-merge deliberately separated jobs:** ML and DL retrains run on different days
  (`ml-weekly-retrain` and `dl-retrain-weekly`; see the comment block above their registration in
  `queues.ts`) because together they exhausted host memory.
- **Do not promote complexity as evidence:** a model score, rank correlation, hit rate, or passing
  unit test alone does not establish a tradable edge. Check the dated measurement guidance and use
  appropriate out-of-sample, liquidity, turnover, and transaction-cost evidence before changing
  score weights or describing predictive performance.

## Working Agreement For AI Assistants
1. Establish whether a statement is **current behavior**, **product intent**, or a **dated finding**.
   Inspect the owning code and its tests for behavior; use docs and the knowledge graph to navigate,
   not as substitutes for current source or live data.
2. Trace a change through its writer, stored data, readers, and scheduled/runtime path. A successful
   function or test does not by itself prove the production workflow writes and consumes correct
   rows.
3. Preserve the contracts above, prefer the smallest change within the owning module, and add a
   focused regression test for behavior changes. Run the checks required by `CLAUDE.md`.
4. Never invent counts, live status, model accuracy, coverage, or causal explanations. Re-derive
   mutable facts from their current source, and attach a date and method to any measurement you
   report.
5. For data-source work, follow `.claude/rules/data-sources.md` before declaring a provider dead or
   adding a fetcher. For unresolved bugs and follow-ups, use `docs/audit-findings.md`, the single
   findings tracker.

## Sources Of Truth
| Question | Start here |
|---|---|
| Repository rules and definition of done | `CLAUDE.md`, `AGENTS.md` |
| Current UI routes and pages | `src/v1/V1Routes.tsx`, `src/App.tsx` |
| Current API surface | `src/server/router.ts`, `src/server/routers/` |
| Job schedules and runtime behavior | `src/server/queues.ts`, `src/server/jobs/`, `src/server/jobRegistry.ts` |
| Database schema and drift | `db/schema.postgres.sql`, `npm run schema:drift` |
| Stock identity and provider mapping | `src/data/stocklist.ts`, `src/server/stockMapping.ts` |
| Canonical scoring and signal contracts | `.claude/rules/scoring-authority.md`, `src/server/unified_ranker.py` |
| Current measurement interpretation | `.claude/rules/measurement.md`, `docs/measurement-history.md` |
| Data freshness and quality checks | `src/server/dataQualityChecks.ts` |
| Data-source onboarding and endpoint discovery | `.claude/rules/data-sources.md`, `DATA_FETCHING_GUIDE.md` (how-to call endpoints), `docs/DATA_SOURCE_INTEGRATION_GUIDE.md` (in-repo catalog), `docs/INGESTION_PIPELINE.md` (per-fetcher run/ops) |
| Open findings | `docs/audit-findings.md` |
| Historical decisions | `docs/session-log.md` (search for a specific date/topic; do not load the whole file) |

For read-only production SQL, use `scripts/sql.py` as documented in `CLAUDE.md`. For a consolidated
health check, use the `repo-doctor` skill. A code change is not deployed merely because it is
committed; deployment and live verification are described in `CLAUDE.md` and the
`deploy-and-verify` skill.
