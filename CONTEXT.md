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

The code descriptions below are orientation, not a production readback. Inspect the current writer and gates, and query the relevant production batch before asserting what actually contributed to a live run.

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

`unified_ranker.py` stores eight engine slots. The base weights for `ml`, `confluence` and
`technical` are non-zero in every regime; the runtime edge gate can reduce an engine's actual
contribution further. `breakout`, `screener`, `cs`, `dl` and `smart_money` have weight 0.0 in every
regime (`REGIME_WEIGHTS`; `breakout` was zeroed after a realised-return replay on 2026-10-26,
and `dl` was paused by user decision 2026-09-13, then had its inference and retraining retired
2026-11-11, AF-20261111-01). Their keys and reporting columns remain for telemetry; `dl_score` is no
longer refreshed. Read the current weights and gates from the code before relying on this dated summary.

Dated readback, 2026-11-02 ranker run (HIGH_VOL): `ml` does not reach the blend. Its `ml_score` had a
standard deviation of 0.02 against the 3.0 floor in `ZERO_DISPERSION_MIN_SD_BY_ENGINE`, so
`drop_zero_dispersion_engines` removed it and no row had `engine_coverage_count` above 2. The published
score is therefore confluence plus technical only. Buy/Strong Buy counts also move with the regime
label: 278-293 rows on the three BEAR runs of 2026-10-21..23 against 52-74 on the six HIGH_VOL runs of
2026-10-26..11-02 (the `breakout` removal landed in the same window). Re-read `unified_recommendations`
for the current picture.

`position_size_pct` is not a function of the blended score. It is `max(ml_bet, bo_bet) / vol` times a
confidence multiplier that only shrinks, then cost-penalised, normalised to the gross cap and capped per
name, sector and correlation cluster (`src/server/unified_ranker.py`, "#6 position size"). `ml_bet` comes from the
edge-adjusted ML win probability, which the dispersion floor does not gate, but it was about 0.0005 on
2026-11-02. `bo_bet` is a top-quintile/decile breakout-percentile tilt from the `breakout` engine that is
weight 0.0 in the blend, and it carried 95% of the sized weight that day. Strong Buy therefore does not
size larger than Buy (1.04% vs 1.52% mean that day); do not read a size as conviction.

Outcome resolution, backtests, model evaluation, and monitoring provide feedback for research and
operations. Do not assume every source follows this exact path or that a feedback loop is
autonomous; inspect the relevant writer, consumer, and job before changing one.

This checkout currently has 89 Python `*_fetcher.py` modules and 74 `JOB_REGISTRY` entries
(re-derived 2026-11-11). These are inventory snapshots, not targets or enduring truths; rerun
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
In the dated measurements cited below, the ranker showed a small positive rank IC, but the cited `unified_recommendations` panel was LOW-DATA:
every reading in the cited `factor_edge_history` run (97 rows, 2026-10-17) sits below the eff-20 reliability floor, at
0.2-8.2 effective dates, so that panel gives no usable reading in either direction, and no cost-aware backtest pass was documented in that review. The longer-history deep-panel gradings (2021-2026, 2,431 symbols) are
separate: no tier reaches AUC 0.55, and the F&O-eligible tier is indistinguishable from zero (see
`.claude/rules/measurement.md`, 2026-10-21). Most published factors tested here are null or inverted on this data. The realistic goal is a
modest, honestly-measured cross-sectional edge (rank IC of roughly 0.05-0.10), not high accuracy, and the
system's job includes not presenting an unproven ranking as trustworthy. Read
`.claude/rules/measurement.md` before proposing any reweighting — it is usually the wrong fix.

What exists today is disclosure, not refusal: the Alpha banner (`src/components/AlphaHonesty.tsx`, `src/lib/callState.ts`),
the "Unproven ranking" badge on `src/components/HighConvictionPage.tsx` and the forward-test line in the morning brief
(`src/server/morningBrief.ts`) label the list as unvalidated while still showing it. The only suppression is the
intraday engine's emission gate, and "NO TRADE TODAY" means the ranking produced no picks, not that the
edge is unproven. An "honest refusal engine" (watch-list, no calls) appears only as an open decision in
`docs/superpowers/specs/2026-10-19-full-data-honest-recommendations-design.md`; no code implements it.

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
- **Do not re-merge deliberately separated jobs, or revive retired ones without evidence:** the DL
  retrain (`dl-retrain-weekly`) ran on a different day from `ml-weekly-retrain` because together they
  exhausted host memory. DL inference and retraining were retired on 2026-11-11 (AF-20261111-01):
  `dl_score` has no forward edge in any role, so do not reschedule them without a new measurement.
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
| Stock identity and provider mapping | `nse_stocks` and `stock_master` production readbacks alongside `src/data/stocklist.ts` and `src/server/stockMapping.ts`; verify the specific mapping |
| Canonical scoring and signal contracts | `.claude/rules/scoring-authority.md`, `src/server/unified_ranker.py` |
| Measurement interpretation | `.claude/rules/measurement.md` and `docs/measurement-history.md` for dated evidence and corrections; rerun the relevant measurement for a current claim |
| Data freshness and quality checks | `src/server/dataQualityChecks.ts` |
| Data-source onboarding and endpoint discovery | `.claude/rules/data-sources.md`, `DATA_FETCHING_GUIDE.md` (how-to call endpoints), `docs/DATA_SOURCE_INTEGRATION_GUIDE.md` (in-repo catalog), `docs/INGESTION_PIPELINE.md` (per-fetcher run/ops) |
| Open findings | `docs/audit-findings.md` |
| Historical decisions | `docs/session-log.md` (search for a specific date/topic; do not load the whole file) |

For read-only production SQL, use `scripts/sql.py` as documented in `CLAUDE.md`. For a consolidated
health check, use the `repo-doctor` skill. A code change is not deployed merely because it is
committed; deployment and live verification are described in `CLAUDE.md` and the
`deploy-and-verify` skill.
