# Signal-Model Rationalization — Design (P3 fresh-start)

**Date:** 2026-06-19
**Status:** Approved design, pre-implementation
**Owner:** prod-readiness program (Phase 3 / P3g), branch `prod-readiness-phase1`
**Related:** `docs/superpowers/specs/2026-06-18-p3f-python-postgres-design.md`, CLAUDE.md "Scoring Authority & Signal Model" section

## 1. Problem

The platform has **six overlapping signal/outcome tables** that accreted over time and
are semantically tangled:

| Table | Rows (SQLite) | Cols | What it really is |
|---|---|---|---|
| `signals` | 41,571 | 14 | Legacy AI trade signals. Has **duplicate** `createdAt`/`created_at` + `updatedAt`/`updated_at` columns. |
| `unified_signals` | 4,507 | 16 | The intended canonical trade-signal table (source + type + entry/target/SL/confidence). |
| `technical_signals` | 7,672 | 35 | A per-symbol-per-date **ML feature vector** (RSI, MACD, FII flows, PCR, sector returns, win_probability). Not a trade idea. |
| `technical_analysis_signals` | 177 | 10 | Tiny redundant trend/RSI/MACD/bollinger snapshot. |
| `signal_outcomes` | 24,989 | 12 | Forward-return **labels** keyed to `technical_signals` (symbol+signal_date+horizon). |
| `unified_signal_outcomes` | 1,945 | 18 | Richer outcomes keyed to `unified_signals.id`. |

`confluence_signals` (0 rows live; feeds `unified_recommendations`) is **not** in this set
and is out of scope.

The result: ambiguous "where do signals live", duplicated outcome-resolution logic, and a
feature table masquerading as a signal table. The CLAUDE.md Phase-3 governance target is
"collapse to `unified_signals` + one outcome table," to be done during the Postgres rewrite
so each consumer migrates once.

## 2. Constraints & goals

- **Fresh start, no data migration.** Per user direction (2026-06-19): existing signal/outcome
  rows do **not** need to be carried from SQLite to Postgres. Dropped tables simply disappear;
  ML models retrain from new data. This removes all row-parity burden for these tables.
- **Optimize for logical correctness**, not backward compatibility with legacy cruft.
- **Migrate each consumer exactly once** (this is folded into the P3 Postgres cutover).
- Do **not** touch the canonical ranking authority (`unified_recommendations` / `unified_ranker.py`)
  or `confluence_signals`.
- Do **not** add new signal tables beyond the renamed feature store.

## 3. Conceptual model (three layers, today tangled)

1. **Trade signals** — "producer *S* asserts symbol *X* is a BUY/SELL at time *T* with
   entry/target/SL/confidence." → `unified_signals`.
2. **Feature store** — per-symbol-per-date feature vectors used to *train* ML models. Not a
   trade idea. → `technical_features` (renamed from `technical_signals`).
3. **Recommendations** — the canonical *ranked* cross-source output. → `unified_recommendations`
   (already authoritative; untouched).

## 4. Target schema

### 4.1 `unified_signals` — the one trade-signal table

All trade-signal producers write here. Cleaned, standardized columns. Existing 16-column shape
is the base; finalize as:

```
id              BIGSERIAL PK
symbol          TEXT NOT NULL
signal_date     TIMESTAMPTZ NOT NULL        -- when the signal is "for"
signal_source   TEXT NOT NULL               -- 'technical' | 'quant' | 'ai' | 'confluence' | 'screener'
signal_type     TEXT NOT NULL               -- e.g. 'EMA_BULL_STACK', 'BUY', 'BREAKOUT'
entry_price     DOUBLE PRECISION
target_price    DOUBLE PRECISION
stop_loss       DOUBLE PRECISION
confidence_score DOUBLE PRECISION           -- 0..1
technical_score DOUBLE PRECISION
quant_score     DOUBLE PRECISION
reasoning       TEXT
ai_reasoning    TEXT
status          TEXT NOT NULL DEFAULT 'PENDING'   -- lifecycle: PENDING -> ACTIVE -> RESOLVED/EXPIRED
signal_generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
UNIQUE (symbol, signal_source, signal_type, signal_date)
```

Status lifecycle is explicit and single-sourced. The `UNIQUE` key gives a clean
`ON CONFLICT` upsert target for idempotent producers.

### 4.2 `unified_signal_outcomes` — the one outcome table

The sole outcome store. Outcome resolution runs **once**, here, against `unified_signals`.

```
id              BIGSERIAL PK
unified_signal_id BIGINT NOT NULL REFERENCES unified_signals(id) ON DELETE CASCADE
symbol          TEXT NOT NULL
signal_date     TIMESTAMPTZ NOT NULL
signal_source   TEXT NOT NULL
horizon_days    INTEGER NOT NULL
entry_price     DOUBLE PRECISION
entry_time      TIMESTAMPTZ
check_date      DATE
exit_price      DOUBLE PRECISION
exit_time       TIMESTAMPTZ
return_pct      DOUBLE PRECISION
intraday_max_return_pct DOUBLE PRECISION
intraday_min_return_pct DOUBLE PRECISION
outcome         TEXT                        -- 'WIN' | 'LOSS' | 'NEUTRAL' | 'STOP_LOSS' | 'PENDING'
exit_reason     TEXT
signal_score    DOUBLE PRECISION
computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
UNIQUE (unified_signal_id, horizon_days)
```

### 4.3 `technical_features` — ML feature store (renamed from `technical_signals`)

Same 35-column shape, **renamed** so its role is unambiguous (this rename is the central
clarity fix — the misleading name is *why* these tables got conflated). Retains the
model-prediction write-back columns (`win_probability`, etc.) that `ml_ensemble` /
`ml_signal_scorer` / `online_learner` currently UPDATE — re-architecting prediction storage
(and any train/serve leakage concerns) is **out of scope** here; this change is rename +
repoint only.

ML training reads labels by **joining** `technical_features ⋈ unified_signal_outcomes` on
`symbol` + date (replacing the dropped `signal_outcomes`).

### 4.4 Dropped

- `signals` — legacy; producers rewired to `unified_signals`.
- `technical_analysis_signals` — redundant; its sole writer `technical_analysis_engine.py` is
  rewired to `unified_signals` (it already carries `entry_price`/`target_price`/`stop_loss`,
  i.e. a trade signal), mapping `trend`/`rsi`/`macd`/`bollinger`/`patterns` into `signal_type`
  + `reasoning`.
- `signal_outcomes` — ML label store; ML repointed to `technical_features ⋈ unified_signal_outcomes`.

### 4.5 Untouched

- `unified_recommendations`, `unified_ranker.py`, `confluence_signals`.

## 5. Producer / consumer rewiring (verified writer map)

**Trade-signal producers → write `unified_signals`:**
- `signals.ts`, `routers/signals.router.ts`, `queues.ts`, `trendlyneScreener.ts` (currently
  write legacy `signals`).
- `technicalSignalsService.ts` — **already** dual-writes `unified_signals` (and `technical_signals`
  + `signal_outcomes`); simplify to: feature row → `technical_features`, actionable signal →
  `unified_signals`, drop its `signal_outcomes` write.
- `technical_analysis_engine.py` (currently writes `technical_analysis_signals`).

**Feature producers → write `technical_features`:**
- `technicalSignalsService.ts`, `strategySignalsService.ts`.
- Prediction write-back: `ml_ensemble.py`, `ml_signal_scorer.py`, `online_learner.py` (UPDATE
  `technical_features`).

**Outcome resolution → single path into `unified_signal_outcomes`:**
- `outcome_resolver.py` (today writes both `signal_outcomes` and `unified_signal_outcomes`),
  `signalOutcomesService.ts`, `confluence_outcome_tracker.py`. Collapse to one resolver path
  keyed on `unified_signals`.

**Read/report consumers to repoint** (accuracy, performance, RL, backtest): `signals.ts`
(accuracy), `performance_tracker.py`, `strategy_optimizer.py`, `rl_agent.py`, `backtester.py`,
`reward_engine.py`, `mcpServer.ts`, `router.ts` signal/accuracy procedures, ML training readers.

## 6. Phasing (for the implementation plan)

The work decomposes into two loosely-coupled clusters sharing the outcome-table decision:

- **Cluster A — Trade-signal consolidation:** finalize `unified_signals` +
  `unified_signal_outcomes` schema in `db/schema.postgres.sql`; rewire trade-signal producers;
  drop `signals` + `technical_analysis_signals`; repoint accuracy/reporting reads; single
  outcome-resolver path.
- **Cluster B — Feature-store rationalization:** rename `technical_signals` → `technical_features`
  (schema + all SQL refs across ~70 ML files); drop `signal_outcomes`; repoint ML training to the
  `technical_features ⋈ unified_signal_outcomes` join; update prediction write-backs.

Plan sequences **A before B**. Each step verified with: `npx tsc --noEmit`, `npx vitest run`,
Python import + SQLite-regression + live-PG (`USE_POSTGRES=true`) smoke, per the established P3
batch protocol. Because no data is migrated, validation is "writes land correctly and
reads/joins return coherent rows on a freshly-seeded PG," not row-count parity.

## 7. Risks

- **Largest blast radius is Cluster B** (~70 files referencing `technical_signals`/`signal_outcomes`).
  Mitigated by mechanical rename + the no-migration constraint.
- **Outcome-resolver collapse** must preserve the Phase-1 fixes (PENDING-stranding dedup,
  STOP_LOSS detection, stale-pending expiry). Re-verify those behaviors on `unified_signals`.
- **ML label semantics change** (join vs dedicated `signal_outcomes`): confirm the join yields the
  same label set the trainer expects (horizon, symbol/date keying) before dropping `signal_outcomes`.
- **Tests** under `src/server/tests/` and `__tests__/` seed `technical_signals` / `signal_outcomes`
  directly — update fixtures to the new tables.

## 8. Out of scope

- `unified_recommendations` / ranker changes; `confluence_signals`.
- The P3g UI reroute of `getTopRatedStocks` / `getStrategyStocks` onto `unified_recommendations`
  (separate P3g item).
- Re-architecting ML prediction storage / train-serve leakage (rename + repoint only here).
- Permanent `USE_POSTGRES=true` go-live flip (separate P3g step; gated on a fresh ETL of the
  *non-signal* tables).
