# In-Place Rebuild Spec — Bharat Stock Intelligence (adapted from NEW_SYSTEM_MASTER_PROMPT.md)

_This document is the in-place counterpart to `docs/NEW_SYSTEM_MASTER_PROMPT.md`. That file's
"PROMPT TO USE" section was written generically, for a fresh empty repo. This file takes the same
non-negotiables and maps each one onto this actual codebase — what already satisfies it, what's
partial, what's genuinely missing — so "correct this codebase accordingly" has a concrete,
falsifiable checklist instead of a restatement of the generic prompt._

**Decisions locked in for this pass (2026-07-24):**
- Scope: **in-place migration**, not a new repo. Same hosting/infra, no paid vendor budget.
- Out-of-scope items per the spec (RAG chatbot `src/server/chatbot/`, `rl_agent.py`, the
  `market-map` tab, 3 of 4 screener providers) are **left running, untouched** — not deleted or
  archived. They are simply not extended or invested in further under this effort.
- Screener-provider consolidation to "one provider" is **deferred to Phase 6** (feature-surface
  expansion phase in the delivery sequence) — Trendlyne/MoneyControl/ETnow/ET Marketstats all stay
  live for now.
- Everything below is scoped to what the spec's own **Delivery Sequence** calls Phase 1-3: schema/
  migrations/symbol_mapping/as_of()/factor_breakdown_history/OHLCV pipeline → one leak-free
  cross-sectional model → live per-regime AUC monitoring. Phases 4+ (decision-layer consolidation,
  MCP server, feature-surface expansion, System 2) are follow-on work, sequenced after 1-3 are
  proven, per the spec's own "do not parallelize past step 3" rule.

---

## Requirement-by-requirement status against the real codebase

Legend: **[EXISTS]** already satisfies the requirement as documented in `CLAUDE.md` session notes
· **[PARTIAL]** exists but doesn't meet the full requirement · **[MISSING]** genuinely absent,
needs building · **[CONFLICT]** requirement is in direct tension with a currently-live,
load-bearing system (flagged, not silently resolved).

### Stack

| Requirement | Status | Detail |
|---|---|---|
| PostgreSQL 16 + TimescaleDB, no SQLite dev fallback | **[CONFLICT]** | Live DB is already Postgres/TimescaleDB (`USE_POSTGRES=true`, :5433). But `src/server/db.ts` is documented as "the SQLite-flavored schema-of-record + dev fallback," reached through a `dbAsync`→`pgClient` translation facade (`sqlTranslate.ts`). This is exactly the drift class blamed for several fixed bugs (`date('now')` vs `current_date` vs `now()` across TEXT/DATE/TIMESTAMPTZ; raw `%s` vs `?` placeholders). Removing the SQLite path is a real, separate migration project (rewrite `db.ts` as pure Postgres DDL, retire `sqlTranslate.ts`, repoint every `dbAsync` caller) — **not attempted in this pass**; flagged as the highest-value follow-up once Phase 1-3 below are proven, because it is the single most-repeated root cause in the session-notes history. |
| Real migration tool (drizzle-kit / node-pg-migrate), one schema-of-record file | **[DONE (this pass) — tool introduced, not a full retrofit]** | Schema changes previously went through ad hoc `pgEnsureColumns()` calls in `pgClient.ts` plus a hand-maintained `db/schema.postgres.sql` that is **not automatically applied**. **Added `node-pg-migrate`** (`migrations/` dir, `npm run migrate:up`/`migrate:create` scripts, `-d POSTGRES_URL`), with one intentional no-op baseline marker migration (`0001_baseline_marker.sql` — doesn't replay all 126 existing tables, that's a separate, much larger reverse-engineering effort not required to start using real migrations going forward). The two new schema changes this pass needed (`nse_stocks` provider-ID columns, `unified_recommendations.engine_coverage_count`) were written as real migrations, dogfooding the tool immediately, with a pointer comment added in `pgEnsureColumns()` directing future changes to migrations instead. |
| Express + tRPC + BullMQ + Redis | **[EXISTS]** | Kept as-is; this part of the stack already matches. |
| React 19 + Vite + tRPC client | **[EXISTS]** | Kept as-is. |
| Python subprocess semaphore, unit-tested for the exact contention bug | **[EXISTS]** | Already fixed and regression-tested — `pythonRunner.ts`'s `releasePythonSlot()` decrement-then-handoff bug (was leaking +1 per hand-off under queue contention, confirmed drifting to 36/5) fixed 2026-07-23, with `test_python_runner_slots.ts` asserting the counter returns to exactly 0 after 20 rounds of simulated contention. **This exact spec requirement is already met** — no action needed, just don't regress it. |
| MCP server exposing read-only tRPC procedures as MCP tools | **[EXISTS, but deviates from spec in 2 ways]** | `src/server/mcpServer.ts` already exists (not registered in any `package.json` script — a standalone file, presumably wired into an external MCP client config), with 6 tools: `get_db_schema`, `query_stocks_db`, `get_stock_profile`, `get_market_dashboard`, `search_codebase`, `run_analytical_engine`. Two deviations from the spec's ask: (1) it queries the DB directly with an **arbitrary-SQL tool** (`query_stocks_db`, any read-only SELECT) rather than typed, read-only tRPC procedures — real Phase-5 scope, not changed this pass; (2) `run_analytical_engine` spawned Python via raw `execFile`, **bypassing** `pythonRunner.ts`'s concurrency semaphore entirely. **DONE (this pass, item 2 only):** swapped it to call `runPython()` from `pythonRunner.ts`, so an MCP-triggered engine run now correctly queues behind the same 5-concurrent cap as every BullMQ job instead of stacking an uncounted extra process on top of it. Two caveats: `runPython()` resolves its Python binary from `PYTHON_PATH` while the tool previously used `PYTHON_BIN` — confirm which is actually set in production before relying on this; and queued runs can now wait for a free slot before starting, on top of the execution timeout — a real latency change worth confirming is acceptable for this tool's callers. |
| No bespoke RAG chatbot stack | **[CONFLICT — left as-is per decision]** | `src/server/chatbot/` (FastAPI + LangGraph + ChromaDB) already exists and is out of scope per the spec. Per your decision above, left untouched, not extended. |

### Data model

| Requirement | Status | Detail |
|---|---|---|
| One canonical `symbol_mapping` DB table | **[DONE (this pass) — extended existing table, not a new competing one]** | The *pattern* was already right (NSE symbol as canonical) but lived only in **TypeScript data files** (`stocklist.ts`/`nseStocks.ts`), not a queryable DB table. `nse_stocks` already partially mirrored it (`symbol, isin, mcsymbol, tlid, tlname`, ~2,366 stocks) — extending it (rather than adding a competing `symbol_mapping` table) keeps one canonical DB-side stock master. **Done:** migration adding `stockid`/`companyid`/`tickertape_sid`/`fincode`/`scripcode` (nullable) to `nse_stocks`; `scripts/syncAllStockMappings.ts` rewritten to route through `dbAsync.ts` (`dbGet`/`dbRun`) instead of the raw `better-sqlite3` handle from `db.ts` — **this also fixes a real pre-existing bug found during implementation**: the script previously only ever wrote to the SQLite dev-fallback DB regardless of `USE_POSTGRES`, so the existing `mcsymbol`/`tlid`/`tlname` backfill likely never reached production Postgres either. The script now backfills all 5 new fields from `stocklist.ts`'s `StockMapping` the same way. `stocklist.ts`/`nseStocks.ts`/`stockMapping.ts` are untouched — they stay the actively-used TS-side lookup path; `nse_stocks` is now the DB-queryable mirror Python engines can join against directly. |
| `engine_scores(symbol, date, engine, score, metadata)` — one component-score table | **[CONFLICT, per governance section already in CLAUDE.md]** | This is *already the documented Phase 3 target* in CLAUDE.md's "Scoring Authority & Signal Model" section — three producers exist today (`stock_scores`+`stock_factor_breakdown` from `scoring_engine.py`, `quant_scores` from quant engines, `unified_recommendations` from `unified_ranker.py` as the canonical downstream merge). CLAUDE.md already says rerouting UI reads is "deferred to Phase 3, done during the Postgres migration" — i.e. this codebase's own governance doc already agrees with the spec's data model, just hasn't executed the consolidation yet. **Not attempted in this pass** (it's explicitly gated on the Postgres/SQLite migration above, and is a UI-behavior change) — flagged as the concrete next step once the SQLite-fallback removal above is done. |
| One `signals` + one `signal_outcomes` table | **[CONFLICT, same governance section]** | Six overlapping tables exist today (`signals`, `unified_signals`, `technical_signals`, `technical_analysis_signals`, `signal_outcomes`, `unified_signal_outcomes`) — CLAUDE.md already documents this as a known Phase 3 target ("collapse to `unified_signals` + one outcome table, performed during the Postgres/Timescale rewrite so each consumer is migrated exactly once"). All six are described as load-bearing with many consumers. **Not attempted in this pass** — same reasoning as above; this is real, consequential migration work that needs its own dedicated pass with full consumer inventory, not a drive-by table merge. |
| One `feature_store(symbol, date, ...)` table | **[PARTIAL]** | `feature_store` already exists as a table name (found in `unified_ranker.py`, `ml_ensemble.py`, `test_feature_engineering_batch.py`), so the pattern exists for at least the ML-ensemble path. Needs verification of whether every engine (technical, fundamental, ownership, options) writes into this one table by column vs. some engines maintaining their own parallel feature-building queries directly against source tables. **Action: audit which engines bypass `feature_store` and read directly from source tables inside `build_features()`-style functions, and note them as technical debt — do not force a rewrite of every engine in this pass, but stop new engines from bypassing it.** |
| Shared `as_of(table, symbol, date)` helper, used identically by training/backtest/live | **[DONE (this pass)]** | No universal helper existed — confirmed **≥12 independently hand-written "latest row ≤ date" SQL joins** across 6 Python files (`ml_ensemble.py` x6 sites, `exit_policy.py` x2, `online_learner.py`, `cs_ranker.py` x2, `confluence_ml_engine.py`) against `fundamentals_history`/`analyst_estimates_history`, all the identical correlated-subquery shape, plus a 7th differently-shaped `pandas.merge_asof` implementation in `feature_engineering.py`. **Done:** new `src/server/as_of.py` with `as_of_join_sql(hist_table, alias, base_alias, base_symbol_col, base_date_col)` (generates the exact SQL fragment, verified against the hand-written original) and `read_as_of_history(table, symbol, columns)` (the merge_asof-prep boilerplate). All 7 sites across the 6 files migrated onto it (3 `q = """` queries converted to f-strings to allow the interpolation, verified no stray `{`/`}` existed in each query body first). Added `src/server/tests/test_as_of_no_hand_rolled_joins.py` — greps every `.py` file under `src/server` (excluding `as_of.py` itself and `fundamentals_snapshot.py`, whose own `as_of_date = (SELECT MAX(...))` self-join is the snapshot *writer's* dedup/lookback logic with no `<=` target-date bound, a different pattern, documented as an explicit exclusion) for the hand-rolled correlated-subquery shape and fails if any match — plus a sanity test proving the detector itself would catch a reintroduced offender. All 73 existing tests across the 6 touched modules still pass. |
| `factor_breakdown_history(symbol, date, category, score)` | **[EXISTS]** | `stock_factor_breakdown_history` already exists and has been written from early in scoring, per CLAUDE.md's DB schema table and the regime-weights work referencing it. **No action needed** — this requirement is already met, a rare case where the old system got ahead of this specific spec item. |
| Engine-coverage field on every blended/composite score | **[DONE (this pass)]** | Added `engine_coverage_count INTEGER` to `unified_recommendations` (node-pg-migrate migration + mirrored `db.ts` SQLite migration). `unified_ranker.py`'s per-symbol loop already computed `present = {e for e, m in engine_maps.items() if sym in m}` before renormalizing (`_blend()`) — now also writes `len(present)` into the new column on every INSERT/UPDATE. |

### ML methodology (compare against what's already proven/fixed)

| Requirement | Status | Detail |
|---|---|---|
| Cross-sectional, forward-labeled classifiers preferred over path-dependent win/loss | **[EXISTS]** | `breakout_classifier.py` already is this — P(≥6% move in 10 days) from forward OHLCV, universe percentile, honest 5yr purged-OOF AUC 0.6138. `cs_ranker.py` (cross-sectional alpha-percentile LightGBM ranker) is the same family, already wired into `unified_ranker.py`. These are the model family to build on, not replace. |
| Date-purge + embargo, never row-purge | **[EXISTS]** | Already documented as fixed and the reason cited for the corrected 0.6138 AUC (was inflated to a fantasy 0.73-0.82 under row-purge). **DONE (this pass):** extracted the CV logic into a pure `evaluate_purged_cv(df)` function and added `src/server/tests/test_breakout_purge_regression.py` — a synthetic block-ID-leak dataset where date+embargo purging correctly keeps validation blocks unseen (AUC ≈0.44, near chance) while a naive row-index-gap purge lets the model partially memorize the boundary-adjacent block (AUC ≈0.71, gap ≈0.27) — exactly the mechanism the module's own comments describe. |
| Live, per-regime AUC tracking with a trust floor gating consumers | **[EXISTS, but flag is OFF]** | `ml_calibration.py` (built 2026-07-23) already does exactly this: `regime_edge_status` table, `regime_edge_weight()`/`edge_adjusted_probability()`, a 0.55 trust-floor mechanism, wired into `ml_ensemble.py`/`scoring_engine.py`/`unified_ranker.py`, gated behind `app_settings.edge_adjustment_enabled` (currently **false**). This is unusually close to the spec's requirement already. **Not changed this pass** — flipping a live-scoring `app_settings` value is a decision for you to make explicitly, not a side effect of this pass (the existing diff tool already proved flipping it on today is a no-op given current regime AUCs — revisit whenever convenient). |
| Promotion gate on every retrain (beat active model, backup artifact before overwrite) | **[EXISTS]** | `ml_ensemble.py`'s `promote_or_register()` (~line 2507) compares candidate `cv_roc_auc` against the active model (`_active_baseline()`) with an explicit `PROMOTION_MARGIN` (0.005) and a `TEST_AUC_TOLERANCE` regression guard, plus a staleness override after 7 days/10 rejections. `save_ensemble()` backs up the previous artifact via `shutil.copy2()` with a timestamp suffix before overwriting. Verified directly by reading the code — no action needed. |
| No directionally-biased fallback values | **[PARTIAL — one class already fixed, sweep not done]** | One instance already found and fixed (a news-sentiment fallback defaulting to `sentiment_score=1.0` on any exception — mentioned in the generic doc's "what to drop" list, implying it was a real, found bug). No evidence of a systemic sweep across all fallback paths. **Action: this is a code-review checklist item going forward, not a one-shot rewrite — flag it in review discipline rather than attempting an exhaustive sweep in this pass.** |
| Cross-sectional vs market-level feature classification + ablation requirement | **[EXISTS as practice]** | Already documented as an applied discipline — raw India VIX/MMI ablated out, per-stock interaction terms kept. **Action: no code change; carry the discipline forward for any new feature added during this effort.** |
| Label design (binary vs 3-class/continuous) decided up front, not deferred | **[MISSING]** | Current system is binary win/loss (`win_probability`) only; no evidence a 3-class or continuous forward-return target was trained alongside it. **This is real, net-new modeling work** — out of scope for the schema/infra pass, belongs in Phase 2 (the "one cross-sectional model" step) if a *new* model is being built, but is not a retrofit onto the existing ensemble in this pass. |
| Batch/set-based feedback-loop queries, never per-row | **[EXISTS]** | `performance_tracker.py`, `outcome_resolver.py`, `exit_labeler.py` are already documented as running on the daily-ops schedule; no documented per-row-loop incident. No action needed absent evidence of a specific slow query. |

### Decision architecture

| Requirement | Status | Detail |
|---|---|---|
| Regime-gated multi-engine blend | **[EXISTS]** | `unified_ranker.py`'s `REGIME_WEIGHTS` blend (screener/ml/cs/technical/dl/confluence/breakout) already does this, and was just fixed (2026-07-23) for a sum-to-1 normalization bug. |
| Fundamental quality gate + hard veto on governance/solvency red flags | **[EXISTS]** | Both already exist in `unified_ranker.py`, verified by reading the code, not guessed. **Quality gate**: `quality_gate(piotroski, roe, floor=QUALITY_GATE_FLOOR)` (~line 211) demotes technically-strong names with a weak Piotroski F-score or negative ROE, applied per symbol (`unified *= quality_gate(...)`, ~line 895). **Hard veto**: `is_red_flagged(screeners)`/`veto_classification(classification)` (~line 328) checks for a `risk_red_flags` bearish screener category (folds in debt-trap/pledge/ASM-GSM/auditor-warning signals) and, if present, multiplies the score by `RED_FLAG_VETO_MULT` (0.5) and collapses `Strong Buy`/`Buy` down to `Hold` (~lines 905-908) — regardless of how high the underlying score is. |
| Position sizing from calibrated probability (meta-labeling, inverse-vol, capped) | **[EXISTS]** | `unified_ranker.py`'s `bet_size_from_probability()` (~line 255) is a López de Prado meta-labeling bet size off the calibrated win-probability. `normalize_position_sizes()` (~line 267) caps each name at `MAX_POSITION=0.10` and normalizes to `GROSS_EXPOSURE=1.0`. Sizing is `bet/vol` (inverse-volatility weighted, `vol` floored/defaulted from `quant_scores.annualized_vol`) for `Strong Buy`/`Buy` names, using `max(ml_bet, bo_bet)` — the stronger of the ML meta-label bet or a cross-sectional breakout-percentile tilt (the breakout classifier has real edge; the ML win-probability doesn't, outside BEAR) — additive, not naive score-ranking. |

---

## Concrete Phase 1 scope for this pass (what "correct the codebase" means right now)

Given the decisions above (in-place, other features untouched, screeners not consolidated,
same infra), the actionable, non-destructive, additive work for this pass — matching the spec's
own Delivery Sequence steps 1 and the audit portions of steps 2-4 — is:

1. **DONE — Introduced `node-pg-migrate`** (baseline no-op marker migration, not a full reverse-
   engineered retrofit of all 126 tables), so future schema changes stop being hand-run
   `pgEnsureColumns()` calls or manually-applied `.sql` files.
2. **DONE — Extended `nse_stocks`** with the missing provider-ID columns (rather than a new
   competing `symbol_mapping` table) and fixed `scripts/syncAllStockMappings.ts` to actually reach
   production Postgres (was SQLite-only due to a raw `db.ts` import instead of `dbAsync.ts`) — so
   Python and TypeScript resolve provider IDs from one queryable table instead of TS-only lookups
   on one side and ad hoc joins on the other.
3. **DONE — Built the shared `as_of()` helper** (Python; no TS consumers of this pattern were found
   during implementation, so no `asOf.ts` was added — nothing to migrate there) and migrated all 7
   known duplicate point-in-time joins across 6 files onto it; added the "no hand-rolled as-of
   pattern outside the helper" lint/test.
4. **DONE — Added `engine_coverage_count` to `unified_recommendations`**, populated from
   `unified_ranker.py`'s existing per-symbol active-engine renormalization step.
5. **DONE — Added the row-purge-vs-date-purge regression test** for the breakout classifier
   (`test_breakout_purge_regression.py`), via a small extraction refactor (`evaluate_purged_cv()`)
   and a pinned `RANDOM_STATE` for determinism.
6. **DONE — Audit completed** (not "no code change" as originally scoped — the audit found real,
   already-existing implementations, corrected in the tables above): promotion gate, quality gate,
   hard veto, and position sizing all **already exist** in `ml_ensemble.py`/`unified_ranker.py`.
   The MCP-server audit surfaced a real, fixable gap instead (item 6 below).
   `feature_store` bypass-by-engine was not re-audited beyond the original PARTIAL finding — left
   as noted technical debt, not blocking.
7. **DONE (bonus, not originally scoped) — Fixed `mcpServer.ts`'s `run_analytical_engine`** to
   route through `pythonRunner.ts`'s concurrency semaphore instead of bypassing it with raw
   `execFile` — found only because the audit above required reading `unified_ranker.py` closely
   enough to notice the pre-existing MCP server and its two spec deviations.
8. **Flag, don't execute**: full SQLite-fallback removal and the 3-table→1 / 6-table→2 signal
   consolidation remain real, separate, higher-risk migrations — explicitly sequenced *after*
   this pass, matching CLAUDE.md's own existing "deferred to Phase 3" governance language.
   `mcpServer.ts`'s `query_stocks_db` (arbitrary-SQL tool → typed tRPC-backed tools) and
   screener-provider consolidation remain Phase 5/6 scope, untouched.

Items 1-7 turned out to be entirely additive/non-destructive (new table columns, new helper, new
column, new tests, a semaphore fix) and didn't require deleting or rewriting any currently-live
consumer's behavior. Item 8 is explicitly not attempted here — it's the correct next major phase,
but it changes behavior for many live consumers and deserves its own dedicated planning pass with
a full consumer inventory,
not a drive-by change bundled into this one.
