# Action Items — Pending Only (updated 2026-07-02)

Actionable backlog only — no history/narrative. Each item has enough context to pick up
directly. Ranked by priority within each section.

---

## P0 — Do first (prevents recurrence of a real incident)

1. **`ensemble.pkl` has no versioning, no backup, and no enforced promotion bar.**
   `register_model()` in `ml_ensemble.py` auto-activates every retrain regardless of quality,
   and saves over the single unversioned `ensemble.pkl` (gitignored — no backup exists).
   This is exactly what turned a missing-dependency mistake into a live model-quality
   incident this session. Fix:
   - Copy the current `ensemble.pkl` to a timestamped backup before overwriting it.
   - Enforce the already-documented promotion bar (held-out AUC ≥ baseline + 0.005, top-decile
     precision doesn't regress) before setting `is_active=1` — don't auto-activate a worse model.
   - File: `src/server/ml_ensemble.py`, `register_model()` (~line 1592) and `run()` save path.

2. **`technicalSignalsService.ts:1056`** — `runTechnicalSignalScan`'s core OHLCV query has no
   `date <=` bound (`SELECT ... FROM stock_ohlcv ORDER BY symbol, date ASC`), so passing a
   historical `date` still computes indicators using future data — unsafe for backfill despite
   accepting a `date` param. Fix: bound the query by the passed `scanDate` throughout. Needed
   before any historical technical-signal gap can be safely backfilled (see the permanent gap
   noted below — this is the tool that would fix it, once safe).

---

## P1 — ML/accuracy (highest trading-relevance)

3. **Label redesign** (WIN/LOSS-only binary → 3-class incl. NEUTRAL, or per-horizon
   profitable-net label). Biggest remaining accuracy lever per last review. High blast radius
   (touches calibration/gate/sizing) — needs an explicit go/no-go decision before starting,
   not a routine change.
4. **`outcome_resolver.py` per-row OHLCV N+1** (`resolve_outcomes`, `resolve_unified_outcomes`,
   `resolve_dl_predictions.grade_for`, `resolve_recommendation_log` — 2-6 sequential queries ×
   2000-5000 rows/run). The transaction-poisoning bug in this file was fixed 2026-07-02, but
   the underlying N+1 batching was not. Needs its own dedicated, TDD'd session given the
   ATR chandelier-trailing-stop simulation complexity (`simulate_exit`).
5. **Cross-sectional ranking model** vs. current per-stock binary classifier — next lever
   after label redesign.
6. **GDELT sentiment** — backfill exists (`gdeltService.ts`), never joined into
   `ml_ensemble.build_features`. Bounded, well-scoped next step.
7. **`portfolio.ts` `buildRiskParityWeights`/`getRecentCloses`** — confirmed dead code (zero
   callers anywhere). Either wire in for real covariance-aware position sizing (currently
   superseded by simpler inverse-vol sizing in `unified_ranker.py`) or delete it.
8. **`backend-python/app/*.py`** (24 files) drifting from `src/server/*.py` — confirmed
   `app/db_compat.py` is missing helpers added to the `src/server/` copy this session. Live
   correctness risk if AlphaQuant (:8002) ever calls the stale copy. Needs consolidation to
   one source.

---

## P2 — Performance (N+1 batching, established pattern — see `unified_ranker.py`/
`signalOutcomesService.ts`/`correlationService.ts` in git history for the reference fix style)

9. `src/server/backtestRunner.ts:56-57` — up to 100 items × 2 sequential `dbGet` calls
   (entry/exit OHLCV lookup). Easy, low-risk, good first pickup.
10. `src/server/moneycontrolScreener.ts:230-235` — per-stock upsert, not even wrapped in a
    transaction. Minimum fix: wrap in `dbTransaction`. Better: multi-row upsert via `dbBulk.ts`.
11. `src/server/strategySignalsService.ts` (3 call sites, ~lines 91/175/242) —
    `persistStrategySignal()` does a 2-round-trip existence-check + insert per matched symbol.
12. `src/server/trendlyneScreener.ts:1352-1389` — nested loop, up to 3 sequential `dbGet`
    calls per stock per screener.
13. `src/server/technical_analysis_engine.py::process_all` — one `load_ohlcv(symbol)` query
    per symbol across the full universe.
14. `src/server/screener_performance.py` — `phase_b_fill_returns` (~8 queries/row ×
    thousands of rows), `phase_c_bayesian` (3 queries × 1,521 screeners).
15. `mcApiService.ts` + `moneycontrol_fetcher.py` — two independent fetch paths hit the same
    7 MoneyControl endpoints per stock in overlapping windows; `mcApiService.ts` uses a
    private local cache instead of the shared `cacheService.ts`/Redis TTL.

---

## P3 — Data/vendor-blocked (no code fix available, monitor only)

16. `iv_rank`/`iv_skew` structurally empty — NSE Akamai-walled, NiftyTrader gives 0.0 IV for
    equities. Only known unblocked path: paced Trendlyne per-stock option-chain fetcher
    (`smartoptions.trendlyne.com`, confirmed to carry real IV+greeks) — not implemented,
    blocked by bot-rate-limiting on burst probing.
17. Survivorship bias — training universe is current-listed-only (0 delisted symbols in
    `stock_ohlcv`). Vendor-blocked.
18. `technical_analysis_signals` elimination (Cluster B, deferred) — redundant indicator
    write-path; needs `technical_features` extended with trend/bollinger/pattern columns first.
19. Regime-conditional calibration — mechanism is built and safe but dormant (each regime has
    only 1 short episode of resolved-outcome data). No action — activates automatically once
    enough time passes and the data floor clears.

---

## P4 — Test hygiene

20. `test_fundamentals_pit.py` (3 failures) — confirmed leak-free by construction (verified by
    reading the AS-OF join logic), purely a Postgres-`LATERAL`-vs-SQLite syntax gap in the test
    harness. Recommended fix: mark `@pytest.mark.skipif(not use_postgres())` so they stop
    reporting false negatives, rather than rewriting the canonical training query's `LATERAL`
    join to be dual-mode (real risk to touch for a test-only benefit).

---

## Permanent, accepted limitation (no action item — documented for context only)

`signal_outcomes`/`technical_signals` have an unrecoverable ~3.5-week generation gap
(2026-06-04 → 06-29). Exhaustively checked: SQLite fallback (same gap), a June 20 Postgres
backup (same gap), the live scanner (unsafe to use for backfill until item #2 above is done).
Nothing to do here except item #2, which would make future gaps like this recoverable.
