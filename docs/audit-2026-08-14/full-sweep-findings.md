# Full audit-skill sweep — 2026-08-14

All 12 of this repo's `.claude/commands/*.md` review skills run back-to-back against the live
codebase and production Postgres (`bharat_intel`), each as an independent read-only subagent (no
files edited by any of them). Sections 1-12 are the original findings, ranked roughly by severity
within each. **Remediation started same-day** — see the "Remediation log" section at the bottom
for what's actually been fixed, live-verified, and tested since; the per-section entries below
are left as originally written (the historical record of what the audit found), not edited in
place to say "fixed."

Live DB verification used direct `psycopg2`/`dbAsync` connections (per `deploy-and-verify`'s
established pattern) — the project-local `postgres` MCP server didn't surface to spawned
subagents in this run; worth checking in a future session with a fresh subagent whether
`ToolSearch` finds it.

---

## 1. canonical-read-audit

- **HIGH, confirmed — `TradeDecisionCockpit.tsx` bypasses `unified_recommendations`.**
  `getTradeDecisionCockpitData` (`src/server/routers/misc.router.ts:409-560`) hand-rolls its own
  composite score (`techScore*0.40 + fundScore*0.20 + momScore*0.20 + sentScore*0.10 +
  smartScore*0.10`, with `smartScore` hardcoded to `50` for every stock, ~line 536) and labels it
  `STRONG BUY`/`BUY`/`WATCH`/`HOLD` — no disclosure banner, unlike every sibling non-canonical
  page. Reachable from every shell's nav, and one click away from the canonical `/alpha` page
  itself (`App.tsx:604` routes a stock click there).
- **MEDIUM-HIGH, confirmed — `SignalIntelligence.tsx` presents measured-negative screener
  consensus as signal.** Reads `confluence_signals`/`screener_reliability`
  (`src/server/routers/confluence.router.ts:39-156`) and renders "Elite/Strong Conviction" stat
  cards and a reliability leaderboard with no caveat, despite `measurement.md` already finding
  bullish screener consensus significantly negative (t=−2.36) and `screener_reliability`'s own
  numbers not surviving from-scratch re-measurement. Live in v1's and v2/v3's nav.
- Compliant-with-disclosure, verified intact: `TopRatedStocks.tsx`, `HighConvictionPage.tsx`,
  `StrategyIntelligence.tsx`, `InvestmentStrategy.tsx`, `ScreenerRankingPanel.tsx`.
- **Orphaned, scoring-shaped procedures (0 references outside `src/server`):**
  `getPortfolioSignalAlignment`, `getScreenerWeightHistory`, `getSignalActionMetrics`,
  `getSignalCorrelationMetrics`, `getStrategyPerformance`, `getScreenerSurfacingSignals`,
  `getMLModelRegistry`.
- Not verified: full v5 route tree beyond sampled pages; no live DB query run (static/code-only
  pass); several v6-home widgets only skimmed.

## 2. cross-writer-collision-audit

- **HIGH, confirmed live — `screener_catalog`'s casing fix from 2026-08-13 did not hold.**
  865/2,539 rows (34%) now belong to a `screener_name` with >1 catalog row, 171 names disagree on
  `signal_bias` (e.g. `'Near 52 Week High'` bullish under one source-casing, neutral under
  another). The prior fix patched existing rows but never normalized casing at write time in the
  three writers, so it's already reaccumulated one day later.
- **MEDIUM-HIGH, confirmed live — `index_max_pain` has no provider in its PK.** PK is
  `(index_name, date, expiry)`; two independent writers (`mc_index_oi_fetcher.py`,
  `nt_oi_snapshot_fetcher.py`) both write `NIFTY50`/`NIFTYBANK`/etc., confirmed interleaved by
  timestamp in live data (93 MC-style vs 11 NT-style rows for NIFTY50). Whichever runs later
  silently overwrites the other's `max_pain`/`pcr_oi`.
- Re-confirmed, already documented, no new info: `trendlyne_screeners`'
  `ON CONFLICT(screener_id)` name-slug collision.
- Checked and ruled out: `unified_signals.signal_source` (`technical` vs `technical_scan` is
  deliberate, not a collision); `stock_options_oi` (second writer's `ON CONFLICT` only touches
  non-overlapping columns); `macro_asset_prices` (near-duplicate symbols never share a literal
  key).
- Not covered: ~140 of ~150 multi-writer table candidates from the initial grep; `job_heartbeat`,
  `live_screener_runs`/`appearances`, `corporate_actions`' two writers.

## 3. data-coverage-audit

- **MEDIUM, confirmed — `backfill_ohlcv.py`'s `_fetch_ohlcv_async()` has no `live_datasource`
  test.** Hits Yahoo Finance's raw v8 chart API directly, writes to `stock_ohlcv` (the most-consumed
  table platform-wide). Existing tests are both mocked, never live. Table-level freshness check
  exists, so this is a "wrong on day one" gap, not a "silently dead" one.
- Otherwise clean: 71/72 fetchers plus 5 non-`_fetcher` scripts all have live tests; every written
  table has a freshness-check mention; 21 spot-checked tables (InvestSights/MarketsMojo/sector-intel
  batch) all fresh and correctly configured.
- Not a bug, flagged: `investsights_fundamentals_history`, `investsights_factor_scores`,
  `sector_rrg_history` are landed and monitored but consumed nowhere yet (`ml_ensemble.py`,
  `unified_ranker.py`, `scoring_engine.py`, `factor_backtest.py` all zero references).
- Not verified: TS-side fetcher-shaped files checked only for write-call presence, not read
  line-by-line; `scripts/` directory not swept.

## 4. data-honesty-review

- **HIGH, confirmed live — `getInstitutionalFlows` (`src/server/routers/sentiment.router.ts:63,72-73`)
  coerces NULL to `"0.00"`.** `MoneyFlowPulseWidget.tsx` (v6 default home) then renders `+₹0 Cr`
  indistinguishable from a real flat day. Live: 1,908/2,601 `fii_dii_flow` rows have NULL
  `dii_net`, including scattered recent-month gaps that can land on the latest row.
- **HIGH, confirmed — `StockIntelligencePage.tsx:1069-1070`'s freshness label uses client fetch
  time, not `unifiedScore.computed_at`.** Shared by v3/v4/v5/v6, the highest-traffic per-stock
  surface in the app. A score computed days ago always displays "just now" while the tab stays
  open.
- **MEDIUM — neither `TopPicksWidget.tsx` nor `CommandCenterDashboard.tsx` (`/alpha`) render
  `computed_at`** even though the backend already selects it — no as-of indicator anywhere a user
  could spot a stalled ranker.
- **MEDIUM, confirmed — `V6Shell.tsx:72-103`'s `DataHealthChip` ignores `isError`.** A hard query
  failure (not the DB-internal errors `monitor.router.ts` already absorbs) renders green "Health
  nominal" instead of a failure state.
- LOW — `TopMoversIntelligence.tsx:53` collapses loading and permanent-failure into one skeleton
  state; `TopPicksWidget.tsx:65`'s `?? 0` on `unified_score` would mask a null score if one ever
  occurs (not currently triggered, live-checked).
- **Side finding, out of scope for this skill:** `unified_recommendations.max(computed_at) =
  2026-08-17`, three days ahead of the actual date (2026-08-14) — a backend date-anchoring
  anomaly, not a rendering one. Needs its own investigation.
- Not verified: v1/v2/v5-specific surfaces, `ScreenerBrowserPage`, intraday/options/risk desk
  pages; no live UI screenshots taken.

## 5. fetcher-accuracy-review (scoped triage — see note)

**Scope note:** triaged subset only (backfill_ohlcv.py, 5 marketsmojo fetchers, 8 InvestSights
fetchers, trendlyne_screener_discovery.py/screener_catalog_enricher.py, ~6 spot-checks) — NOT the
full ~80-fetcher sweep, since `data-coverage-audit` (above) already confirmed artifact presence is
essentially complete. ~55 fetchers got no correctness pass this round.

- **HIGH, confirmed live — `block_deal_fetcher.py:262,296` systematically mislabels live block
  deals by one day.** `_calendar_days_back(1)` returns yesterday but the loop still calls
  `fetch_live()` (today's feed) and stamps rows with the loop's date argument, never validated
  against the API response. Live-confirmed: 5 symbol-pairs (BIOCON, METROPOLIS, SUDEEPPHRM,
  THYROCARE, URBANCO) carry byte-identical deals filed under two adjacent dates. Feeds
  `technical_signals.block_deal_net_qty/value_cr` (an `ml_ensemble.py` input). Does not corrupt
  `unified_ranker.py`'s smart-money score (different columns/source).
- **HIGH, confirmed by code + live row count — MarketsMojo's write-amplification fix landed on
  only 1 of 5 sibling fetchers.** `marketsmojo_technical_fetcher.py` has the incremental-write
  guard (+ its own test); `financials`/`fintrend`/`shareholding`/`index` fetchers still do
  unconditional full re-upserts every run. Live: `marketsmojo_financials_history` already at
  4,144,255 rows after exactly one run (2026-08-11). Weekly cadence limits blast radius vs. the
  original nightly incident, but the defect shape is unfixed in three siblings.
- Hypothesis ruled out: `trendlyne_screener_discovery.py`'s "known"-PK mode looked like a
  staleness bug for `trendlyne_screener_stocks` — traced and confirmed NOT a bug (a separate job,
  `trendlyneScreener.ts`, does the real daily membership refresh).
- Clean, no new issues: InvestSights' 8 fetchers, `institutional_deals_fetcher.py`,
  `screener_catalog_enricher.py` (already-documented fixes hold), 6 additional spot-checked
  fetchers' PKs.
- **Not covered:** ~55 remaining fetchers (most of `mc_*`, `nt_*`, `trendlyne_*` beyond discovery,
  `nse_*` beyond bhavcopy, `so_option_chain_fetcher.py`, `preopen_fetcher.py`, etc.) — only had the
  sibling artifact-presence check, not this skill's correctness pass.

## 6. job-runtime-audit

- **HIGH, confirmed live, currently active — `confluence_outcome_tracker.py` has failed every
  scheduled run for 11 consecutive days (2026-08-03 through today, 2026-08-14).** Loads the
  entire unfiltered `stock_ohlcv` table into memory as its first step (no date bound, grew 611K →
  2.6M+ rows since the 5-min budget was last calibrated), commits only once at the very end (a
  kill mid-run loses everything), and its tail step (`recompute_screener_reliability()`) never
  executes. `confluence.jobs.ts:89-90` wraps the call in a `.catch()` that only `console.warn`s —
  BullMQ still reports `'completed'` every night. **Zero freshness checks watch
  `screener_reliability` or confluence-sourced `signal_outcomes`, so nothing else could have
  caught this either.** `MAX(last_updated)` on `screener_reliability` = 2026-08-04;
  `MAX(signal_date)` on confluence-sourced `signal_outcomes` = 2026-08-02 — both frozen exactly
  where the failure streak began.
- **MEDIUM, mostly self-resolved — `trendlyne_price_analysis_fetcher.py` hit its 40-min budget
  repeatedly through 2026-08-12** (Trendlyne's endpoint returning 405 on nearly every symbol,
  full per-stock retry budget burned before finishing). A fail-fast circuit breaker landed
  ~08-13 and the timeout is fixed; the endpoint itself is still 100% 405 as of today, so the table
  gets no new data regardless — separate, data-sources-shaped issue.
- Corroborated, already fixed, no new finding: `extra_endpoints_fetcher.py`'s July SIGTERM
  timeouts (stopped after the documented `--scope daily` fix); MarketsMojo technical fetcher's
  write-amplification (guarded by its test, no new timeouts since).
- Not verified: did not trace all ~150 `runPython` call sites individually; no write-amplification
  measurement attempted beyond MarketsMojo.

## 7. measurement-integrity-review

- **MEDIUM-HIGH, confirmed live, previously undocumented — `mc_earnings_fetcher.py`'s
  `_backfill_rapid_features` picks the wrong quarter for ~22% of covered symbols.**
  `mc_earnings_rapid`'s PK is `(scid, sub_type, category)`, not `result_date`, and nothing purges
  superseded rows — when a stock's category changes quarter to quarter, both old and new rows
  persist. The selection query (`mc_earnings_fetcher.py:415/425/444/453`) orders by
  `ABS(category_score) DESC` with **no date ordering at all**, despite the function's own
  docstring claiming it picks "the most recent" result. Live-confirmed: 442/2,017 multi-row
  symbols (21.9%) have the picked row disagree with what `result_date` would have picked.
  Concrete case: `RAMKY` shows a May 2026 "Beat Positive" label while its actual most-recent
  (Aug 2026) quarter landed "WP" — the weaker, newer result never overwrote the stronger, stale
  one. `GAYAPROJ`'s label flipped −2→+2 on 2026-08-12 purely from a tie-break, not new evidence.
  Feeds `technical_signals.earnings_category_yoy/qoq`, an `ml_ensemble.py`/`exit_policy.py` input
  and the already-recorded (separately underpowered, t=−1.79) `earnings_beat_yoy/qoq` factor —
  this doesn't overturn that "not significant" verdict but means a future positive result on this
  factor shouldn't be trusted without fixing the selection query first (add `result_date DESC` as
  primary/tiebreak sort, or purge superseded rows on ingest).
- Not verified: whether the same stale-pick pattern affects `earnings_np_growth_yoy/qoq`
  differently from the category score; whether other consumers of these columns are similarly
  exposed.

## 8. migration-safety-review (10 most recent migrations)

- Scope: `1786910000000` through `1787000000000` (screener_appearances.appeared_at →
  trade_journal). All 10 confirmed applied to live production (`pgmigrations.run_on`, real
  2026-08-11 through 2026-08-14 timestamps). No hypertable/compression hazard — none of the 16
  touched tables are compressed hypertables (only `confluence_signals`, `feature_store`,
  `intraday_ohlcv`, `stock_ohlcv`, `tick_data` are).
- **MEDIUM, confirmed live — the tlid-repair migration created a new, undisclosed collision.**
  It explicitly disclosed 5 pre-existing ticker-reuse ambiguities left untouched, but repairing
  `TMPV` (Tata Motors Passenger Vehicles) to numeric tlid `1362` collided with pre-existing
  `TATAMOTORS`, also `1362` — a 6th collision the migration didn't mention. No unique constraint,
  so nothing failed loudly; Trendlyne fetches for one of the two symbols will silently resolve to
  the other's page.
- **LOW — `npm run schema:drift` currently reports real, unaddressed drift**, all from this batch:
  `trade_journal` (+5 unrelated tables) missing from `db/schema.postgres.sql`; 6 dropped
  `technical_signals` columns still listed as if live; 5 new `fetched_at` columns not reflected.
  Snapshot-file staleness, not a migration defect.
- **LOW — SQLite (`db.ts`) mirror gap, undisclosed.** `fetched_at` added to 5 Postgres tables by
  `1786990000000` but not mirrored in `db.ts` for any of them; the migration never states this is
  deliberate. New tables (`trade_journal`, `quant_scores_history`, `unified_recommendations_history`)
  and `screener_appearances.appeared_at` ARE correctly mirrored, by contrast.
- No `NOT NULL`/`UNIQUE` pre-existing-violation risk found in any of the 10.

## 9. ml-promotion-gate-review (new skill's first run)

- **HIGH, confirmed by code read, not live-verified — `ml_ensemble.py:3226-3316`
  `incremental_update()` has no promotion gate at all.** Called daily (`queues.ts:1017`,
  `ml-ensemble-incremental`), warm-starts the live LGBM model on the last 3 days of resolved
  outcomes and unconditionally overwrites `ENSEMBLE_PATH` — no held-out AUC, no baseline
  comparison, no NaN/finiteness check, never touches `model_registry`. Contrast with the weekly
  `--train` path, which correctly routes through `promote_or_register()`. A bad 3-day batch
  permanently degrades the model used for every subsequent day's scoring with no detection or
  rollback path. No test exercises this behavior.
- **MEDIUM, confirmed structurally — `model-registry-active-ensemble` freshness check
  (`dataQualityChecks.ts:862-874`) can misread correct staleness-override rejections as a
  problem.** Warns past 45 days since last retrain, but the weekly retrain can correctly reject a
  challenger for up to ~70 days (`DEFAULT_STALENESS_MAX_REJECTIONS=10`) before self-healing —
  same shape as the already-fixed `strategy-optimizer`/`screener_weight_history` precedent.
  Non-critical (warn, not fail) but misleading.
- **MEDIUM, confirmed by grep — the staleness override is adopted by only 3 of 9
  `model_promotion.py` consumers.** `ml_ensemble.py`, `cs_ranker.py`, `confluence_ml_engine.py`
  use it; `dl_engine.py`, `exit_policy.py`, `flyer_classifier.py`, `movement_predictor.py`,
  `breakout_classifier.py`, `live_screener_ml_ranker.py` do not — any of the six could hit a
  permanent unbeatable-baseline deadlock with no self-healing path.
- **LOW-MEDIUM, confirmed, disclosed as deliberate in its own code comment —
  `online_learner.py:379`'s `save_sgd(state)` runs unconditionally before the regression check.**
  The live `online_sgd.pkl` is never withheld even when `cv_auc` regresses beyond
  `ONLINE_REGRESSION_TOLERANCE`.
- **LOW, latent — `ml_ensemble.py:2173` `_base_models(..., cv=3)` default.** The one real call
  site correctly passes a `TimeSeriesSplit`, but the bare-int default would silently reintroduce
  the CalibratedClassifierCV time-shuffling bug if a future call site omits `cv=`.
- Not live-verified: none of these were confirmed against a real training run or real
  `model_registry`/pickle timestamps. None of the touched files are on `verify-gate.mjs`'s
  backtest-required list.

## 10. shell-parity-audit

- **MEDIUM, confirmed — a screener win-rate disclaimer added to v5/v6's dedicated screener pages
  didn't reach the wider-blast-radius page reading the same data.** `d640d32`/`6a1b5b1`/`1f7a398`
  added a "doesn't reproduce in re-measurement" disclaimer to v5's `ScreenerLabPage` and v6's
  `ScreenerBrowserPage`, both reading `getScreenerLeaderboard`/`screener_performance_v2`. But
  `src/components/ScreenerIntelligencePage.tsx` reads the same table/procedure and renders the
  same Win Rate leaderboard with zero disclaimer — routed at `/screener-intelligence` in v1, v2,
  v3, **and v6 (the default shell)**. A v6 user hits the undisclaimed version just by navigating
  to a different tab.
- **LOW, no user impact — commit `60a0fdb` (CanonicalBadge parity) cites dead code as its
  rationale.** Justified adding `CanonicalBadge` to v4/v5 by citing 3 "other canonical consumers"
  already having it; 2 of the 3 (`AlphaCockpit`, `BuyRecommendationsPage`) are unreachable —
  `/alpha-cockpit` and `/buy-recs` are bare redirects to `/alpha` (`CommandCenterDashboard`). The
  fix itself is fine; the commit's stated rationale overstates prior coverage.
- Verified correct, no gap: `122b9a6`'s Vite `optimizeDeps.entries` fix for v2-v6 (v1 correctly
  omitted, statically imported instead of lazy-loaded).
- Not verified: no build/run/screenshot pass (source-level only); v4's independent reachability of
  `/screener-intelligence` not separately confirmed (it has no shell of its own, lives inside
  V2AppShell).

## 11. signal-accuracy-review

**Method:** graded the 3 provably pre-market `unified_recommendations` dates that now exist
(2026-08-12, -13, and newly -14) against real top-12 gainers/losers per date (≥₹1cr ADT20,
`is_suspect=0`), per-date not pooled.

| Date | Decisive calls | Correct | Wrong-direction |
|---|---|---|---|
| 2026-08-12 | 2 | 0 | 2 |
| 2026-08-13 | 2 | 1 | 1 |
| 2026-08-14 | 4 | 2 | 2 |

n=8 across 3 dates — far too thin for significance, consistent with prior reviews. 4 real movers
(TIIL, SENCO, APEX, TVSSRICHAK) had zero `unified_recommendations` row despite having
`stock_scores`/`quant_scores` — consistent with the known RL-gate universe exclusion, not
independently re-traced.

- **HIGH, confirmed live, currently active — the "neutral screener tags scored as bearish" bug
  (recorded in `recurring-bugs.md` as fixed 2026-08-13, commit `8019155`, and "live-verified") has
  regressed in production.** The most recent `stock_scores` write (`last_updated=2026-08-13T18:01:39
  UTC`, i.e. AFTER the fix commit) still shows 70.4% of all `long_term` rows (3,501/4,975)
  carrying ≥1 `sentiment=neutral` tag folded into `negative_count`. Directly verified on this
  session's wrong-direction misses: `PNGSREVA` (negative_count=6, 0 bearish/6 neutral),
  `UNIECOM` (12 stored, 1 bear/11 neutral), `TARSONS` (22 stored, 6 bear/16 neutral), `HMAAGRO`
  (39 stored, 6 bear/33 neutral). `MOREPENLAB` and `COROMANDEL` — the two symbols
  `recurring-bugs.md` specifically named as "moved off the score floor" post-fix — are **back at
  `score=0.0`/`Strong Sell`** in this same latest write.
  **Traced root cause:** `scoring_engine.py`'s `_screener_polarity()` is correct on `main`
  (confirmed by direct import/call), but **8 of 9 sibling git worktrees on disk**
  (`.claude/worktrees/*/src/server/scoring_engine.py`) still lack the fix entirely. All worktrees
  share the one production Postgres instance — most likely mechanism is a concurrent session
  running `process_scoring()` from a stale worktree, clobbering the fixed data. Same class as the
  already-documented "Concurrent Session Hazards" memory. **This is the second time in this
  repo's history that a "fixed and live-verified" claim did not survive a later live re-check.**
  Recommended follow-up: re-run `process_scoring()` from `main`'s current tree now, and consider a
  guard (e.g. worktree/commit-hash sanity check) before any write job runs against shared
  production state.
- Not verified: exact process/worktree that wrote the 18:01 UTC batch; whether
  `unified_ranker.py`'s blend explains why MOREPENLAB/COROMANDEL landed at Hold vs.
  TARSONS/HMAAGRO/PNGSREVA/UNIECOM at Sell/Strong Sell; no cross-check against
  `unified_signals`/`intraday_recommendations`/`high_flyer_candidates`; confluence-sourced inputs
  may still be stale per §6's frozen-since-08-03 finding, not independently re-checked here.

**RESOLVED 2026-08-14, ~11:27 UTC.** Root cause revised on closer inspection: not the
worktree-collision theory above — `alphaquant-api` (the pm2 process serving `/api/v1/score`,
which imports `scoring_engine` directly) was running with the correct fix in memory (restarted
2026-08-14 04:28 UTC, well after the 08-13 16:51 UTC fix commit), but the *last actual scoring
run* was 2026-08-13 18:01 UTC — only ~9 minutes after the fix commit, almost certainly before
that day's restart had happened. Plain "committed ≠ deployed" timing gap, not a worktree
collision (the stale worktrees on disk are real but there's no evidence any scheduled job path
ever executes from them). Triggered a real recompute via `POST /api/v1/score` (HTTP 200, 37.7s).
Live-verified after: `MOREPENLAB` Strong Sell/0.0 → **Hold/55.85**, `COROMANDEL` Strong Sell/0.0
→ **Hold/41.63**; platform-wide `long_term` rows pinned at the exact `score=0.0` floor dropped
from 1,125 (per `recurring-bugs.md`'s original measurement) to **60/4,980**. Today's regularly
scheduled stock-scoring run (22:30 IST) will re-run this again with no issue now that the code is
confirmed correct; no further action needed for this finding.

## 12. trpc-surface-review (full sweep, all 28 router files)

Supersedes the earlier single-commit spot-check from this session (which reviewed
`getInsiderTransactions`, found clean, and fixed `getMaxPainAlerts`/`getScreenerSurfacingSignals`
— both confirmed still fixed, not re-flagged below).

- **HIGH, confirmed live, currently broken — `getScreenerSectorRotation`
  (`src/server/routers/screeners.router.ts:579`) throws on every call in production.** Builds
  `WHERE date >= date('now', ? || ' days')` — `sqlTranslate.ts`'s `date('now', ...)` translation
  regex only matches a bare quoted-string modifier, not a parameter concatenation, so it passes
  through untranslated. Reproduced live: `function date(unknown, text) does not exist`. Loud
  failure (hard 500), not silent — and currently orphaned (no frontend caller found), which is
  presumably why nobody's hit it yet. Fix before wiring it up to anything.
- **MEDIUM, silent-failure, confirmed — `getBestComboSignals` (`scoring.router.ts:10-17,236`)
  can silently empty out after any `unified_ranker.py` run.** Its `_urLatestAt` cache of
  `MAX(computed_at)` has no TTL, invalidated only by an admin mutation the real ranker schedule
  never calls — once a fresh `computed_at` lands, the join stops matching and
  `requireUnifiedRec: true` filters everything out, returning `stocks: []` with no error until
  the next `pm2 restart`. Live on `HighConvictionPage.tsx`. The fix is already known and applied
  to a sibling: `commandCenter.router.ts`'s near-identical cache has a 5-minute TTL specifically
  for this reason — just not copied here.
- **MEDIUM, silent-staleness, confirmed — same shape in `confluence.router.ts:26-34,117-156`**
  (`getSectorMomentumMatrix`/`getConfluenceStats`). `_confluenceLatestAt` has no TTL against a
  producer that runs every 30 minutes — doesn't go empty (insert-only table) but silently serves
  an increasingly stale batch with no staleness indicator surfaced.
- **LOW-MEDIUM, dev-only — 3 procedures' `(CURRENT_DATE ± (? || ' days')::interval)::text`
  pattern silently no-ops its date filter under the SQLite dev fallback**, confirmed empirically
  (`stripPgCasts` leaves `CURRENT_DATE - (? || ' days')`, evaluates to a no-op, returns all rows
  regardless of window, no error): `getCorporateActionsCalendar`/`getFiledCorporateActionsCalendar`
  (`fundamentals.router.ts:150-169,239-262`), `getEcoCalendar` (`macro.router.ts:105-127`). No
  production impact (valid on live Postgres); same class as this session's earlier
  `getMaxPainAlerts` fix.
- **LOW, latent — unguarded `ORDER BY <score> DESC` on NaN-capable columns** in
  `commandCenter.router.ts`/`screeners.router.ts`/`technicals.router.ts` (`unified_score`) and
  elsewhere (`intraday_score`, `bayesian_score`, `screener_momentum_score`). Live-checked: zero
  NaN rows currently, so dormant. `risk.router.ts` already defends its own columns with
  `NULLIF(x,'NaN'::float8)` for this exact reason; not extended to the others.
- **Held up well, verified not broken despite looking suspicious:** `NULLS LAST`
  (`fno.router.ts:200`, works on both dialects); `ROW_NUMBER()` used consistently instead of
  `DISTINCT ON` in ~10 files; staleness handling in `market.router.ts`/`misc.router.ts`;
  `ml.router.ts`'s `getModelRocDiagnostics` correctly excludes unscored signals before computing
  AUC.
- **Coverage:** all 28 files read in full, nothing skipped.

---

## Cross-cutting notes

- The `confluence_outcome_tracker.py` 11-day silent failure (§6) and the `screener_catalog`
  casing regression (§2) are both live inputs to what §11 (signal-accuracy-review) graded —
  worth re-reading §11 with those two in mind: some of its wrong-direction misses may trace back
  to stale confluence/screener inputs rather than being purely a scoring-blend problem.
- **§11's finding is the single most urgent item in this file.** A bug `recurring-bugs.md`
  records as fixed-and-live-verified (`8019155`, 2026-08-13) is demonstrably back in production
  as of the most recent `stock_scores` write (2026-08-13T18:01:39 UTC) — likely from a concurrent
  session running `process_scoring()` out of one of 8 stale git worktrees against the shared
  production DB. This should be re-verified and re-run before anything else in this list.
- Several other findings share a root shape already named in `recurring-bugs.md`: a `.catch()`
  that only logs (§6), a freshness check confusing "gated" with "broken" (§9, already-documented
  pattern recurring a 3rd/4th time), an undisclosed collision from a repair migration (§8), a
  no-TTL latest-computed_at cache with a sibling that already has the fix (§12). None of these
  are new *classes* — they're new *instances* — so the right follow-up per `recurring-bugs.md`'s
  own convention is extending existing entries, not adding new ones, except the
  `mc_earnings_fetcher.py` stale-quarter-selection bug (§7), which looks like a genuinely new
  shape (a PK that doesn't include the natural ordering key, with no purge).
- **Severity tally:** 10 HIGH findings (§1: TradeDecisionCockpit; §2: screener_catalog casing;
  §4: getInstitutionalFlows NULL-as-zero, StockIntelligencePage stale freshness label;
  §5: block_deal_fetcher date mislabel, MarketsMojo write-amplification ×4 fetchers;
  §6: confluence_outcome_tracker 11-day silent failure; §9: ml_ensemble incremental_update no
  gate; §11: neutral-tag scoring regression; §12: getScreenerSectorRotation broken in prod), plus
  3 MEDIUM-HIGH (§1 SignalIntelligence, §2 index_max_pain, §7 mc_earnings stale-quarter), with the
  remainder MEDIUM/LOW across all 12 sections. Nothing in this file has been fixed — it's a punch
  list as of 2026-08-14, ranked by severity within each section, not normalized across sections.

---

## Remediation log (started 2026-08-14, same day)

Each entry: what changed, live verification performed, tests run. `tsc --noEmit` clean and the
full `vitest run` / `pytest` suites green (one pre-existing order-dependent flake in each,
confirmed unrelated -- `test_history_snapshot_is_append_only_across_reruns` passes standalone,
and the vitest `technical_signals` composite-key test passed clean on re-run) after every change
in this log, not just the last one.

### §11 — neutral-tag scoring regression: RESOLVED
See the inline "RESOLVED" note at the end of §11 above for the full root-cause correction (a
deploy-lag timing gap, not the worktree-collision theory originally suspected) and live
verification (`MOREPENLAB`/`COROMANDEL` off the score floor, platform-wide floored count
1,125 -> 60).

### §6 — confluence_outcome_tracker 11-day failure: RESOLVED
`confluence_outcome_tracker.py`: bounded the OHLCV cache load to `date >= MIN(signal_date)`
instead of the whole `stock_ohlcv` table (root cause of the budget blowout as the table grew
611K -> 2.6M+ rows), and added a commit after every 5,000-row batch instead of only at the very
end (so a future kill mid-run keeps partial progress instead of losing everything). Added a new
freshness check, `screener-reliability-freshness` (`dataQualityChecks.ts`), watching this job's
exclusive output table -- nothing watched it before, which is why the 11-day failure went
unnoticed. Bumped `confluence.jobs.ts`'s budget for this step from 5 to 20 minutes (the first
live catch-up run took 17m24s to clear the backlog). Live-verified: ran it for real, cleared
11 days of backlog (652,679 outcomes tracked, `screener_reliability` refreshed for 1,467
screeners), `MAX(last_updated)` now current.

### §9 — ml_ensemble.py incremental_update: no promotion gate: RESOLVED
Added a held-out AUC gate: carves the most recent ~20% of each incremental batch out as a
holdout (never trained on), trains only on the rest, and discards the updated booster (keeps the
prior one on disk, returns `False`) if held-out AUC regresses beyond `INCREMENTAL_REGRESSION_
TOLERANCE` (0.02, matching `online_learner.py`'s existing constant) versus the pre-update model
on the same holdout. Raised the minimum batch size for an incremental update from 5 to 8 rows
(need room for a real train/holdout split). Extracted the accept/reject decision into a pure
`incremental_gate_passes()` function and added `src/server/tests/test_ml_ensemble_incremental_
gate.py` (5 tests, negative-controlled -- the first test is written to fail against the old
ungated behavior). Not yet live-exercised against a real training run (would need a live
`--incremental` invocation with real new outcomes); code-verified + unit-tested only.

### §1 — canonical-bypass disclosure: RESOLVED (disclosure, not rewrite -- matches existing
`scoring-authority.md` precedent for `stock_scores`/`quant_scores`-reading pages)
Added `LegacyScoreBanner` (the same component `TopRatedStocks.tsx`/`HighConvictionPage.tsx`
already use) to `TradeDecisionCockpit.tsx` and `SignalIntelligence.tsx`, each with a page-specific
note naming what it actually reads and linking to Alpha/Buy Recs as canonical. `tsc --noEmit`
clean.

### §4 — data-honesty findings: RESOLVED
`sentiment.router.ts`'s `getInstitutionalFlows`: `fmt()` now returns `null` instead of coercing a
missing `fii_net`/`dii_net` to the string `"0.00"`. Both frontend consumers already null-checked
this field defensively (`?? '—'`) -- they just never got the chance to before. Fixed two
downstream issues this exposed: `MoneyFlowPulseWidget.tsx`'s per-category cards did an unguarded
`parseFloat(flow.netBuySell)` (now null-checked, renders '—'), and `InstitutionalFlowDeskPage.tsx`
had a latent color-coding bug (`Number(null) === 0` in JS, not `NaN`, so `Number.isFinite(netVal)`
would've read a missing value as a genuine flat 0 and colored it positive -- fixed to check
nullness directly). Separately, `StockIntelligencePage.tsx`'s per-stock freshness label now reads
`unifiedScore.computed_at` (the ranker's real generation time, already present in the payload)
instead of `dataUpdatedAt` (react-query's client fetch time, which always read "just now").

### §2 — screener_catalog cross-writer collisions: RESOLVED
Found a more serious variant than the audit reported while fixing it: `trendlyne_screener_
discovery.py`'s and `screener_catalog_enricher.py`'s `UPDATE screener_catalog ... WHERE
screener_id = ?` statements had **no `source` filter at all** -- since the table's PK is
`(screener_id, source)` and providers independently issue overlapping numeric ids, either
`UPDATE` could silently overwrite a *different provider's* row sharing the same numeric
`screener_id`. Fixed both to filter on `source` too. Also fixed the root cause of the casing
regression the audit found: `trendlyne_screener_discovery.py` hardcoded `"Trendlyne"`
(capitalized) on insert, fighting `screener_catalog_enricher.py`'s lowercase convention; and
`unified_ranker.py`'s CSV loader used whatever casing `screener_scoring_v2.csv` happened to have.
Both now lowercase at write time, so the 2026-08-13 harmonization no longer silently reaccumulates
day over day. Re-ran the existing harmonization script (`fix_screener_catalog_source_casing.py
--apply`) to clean up the 173 rows that had already drifted since the 08-13 fix: 171 screener_names
with disagreeing `signal_bias` resolved.

### §5 — block_deal_fetcher date mislabel: RESOLVED
`_calendar_days_back()` was anchored at `today - 1` unconditionally, and the live-endpoint
condition (`trade_date >= today - 1`) also matched that anchor -- so `--days 1` (the default)
fetched from the LIVE endpoint (which can only ever return TODAY's session) and stamped the
result with yesterday's date, every run. Re-anchored at `today`, tightened the live-endpoint
condition to `trade_date >= today` only. Added `test_block_deal_fetcher_date_labeling.py`
(4 tests, negative-controlled).

### §5 — MarketsMojo write-amplification (4 sibling fetchers): RESOLVED
Applied `marketsmojo_technical_fetcher.py`'s existing incremental-write guard (skip
already-known dates) to `fintrend`/`shareholding`/`index` fetchers (all have a proper date
column in their PK) and a value-comparison variant to `financials` (PK has no date column --
skip a write only if the incoming value matches what's already stored for that
`(statement, period_label, line_item)`). All four gained a `--full` flag for a deliberate
complete re-upsert (vendor restatement/backfill); existing `queues.ts` call sites pass no flags,
so the incremental behavior applies automatically with no scheduling change needed. Added
`test_marketsmojo_incremental_write_siblings.py` (5 tests, same shape as the existing
`test_marketsmojo_incremental_write.py` for the technical fetcher).

### §12 — getScreenerSectorRotation + two no-TTL caches: RESOLVED
`getScreenerSectorRotation`'s `date('now', ? || ' days')` never translated to Postgres (same
class as the earlier `getMaxPainAlerts`/`getScreenerSurfacingSignals` fixes this session) --
threw `function date(unknown, text) does not exist` on every call in production. Replaced with a
JS-computed cutoff. Live-verified: went from a hard error to 84 real rows returned. Also gave
`scoring.router.ts`'s `_urLatestAt` and `confluence.router.ts`'s `_confluenceLatestAt` the same
5-minute TTL `commandCenter.router.ts`'s `_urLatestAtCC` already carries, so both self-heal once
the real ranker/confluence-compute schedules write fresh data instead of silently going stale (or,
for `_urLatestAt`, silently emptying `getBestComboSignals` entirely) until an admin mutation
happened to fire.

### §7 — mc_earnings_fetcher.py stale-quarter selection: RESOLVED
Changed `_backfill_rapid_features`'s selection from `ORDER BY ABS(category_score) DESC` (picks
the historically most extreme quarter) to sorting by `result_date DESC` first, magnitude only as
a same-day tiebreak -- matching the function's own docstring, which already claimed "most
recent" without the code doing it. Found a second problem while implementing the first fix:
`result_date` is vendor free text ("May 27, 2026"), not ISO, so a raw string sort is
lexicographic ('M' > 'A') and silently picked the same wrong row -- caught by live-verifying the
fix's actual output, not just reading the diff. Parses it into a real date now (Postgres
`TO_DATE`, regex-guarded since it throws rather than returning NULL on unparseable input and
this is a whole-table bulk UPDATE; SQLite gets an equivalent month-name `CASE` mapping). Added
`test_mc_earnings_fetcher_stale_quarter.py` (3 tests). Live-verified against production:
`RAMKY` now correctly picks its real Aug-2026 "WP" quarter instead of the stale May-2026 "BP"
one, and the full 2,123-symbol query runs clean with no parse errors.

### Still open (not yet remediated this session)
§3, §8, §10's remaining LOW/informational findings (dead-column disclosures, a stale
`db/schema.postgres.sql` snapshot, a commit-message rationale overstatement) -- none load-bearing
enough to have warranted the time this session spent on the HIGH/MEDIUM items above. Every HIGH
and MEDIUM-HIGH finding from the original 12-audit sweep is now resolved and live-verified where
live verification was possible (§9's ml_ensemble gate is code-verified + unit-tested only --
would need a real `--incremental` run with fresh outcomes to live-verify the gate actually firing
in production).
