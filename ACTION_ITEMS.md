# Action Items — Pending Only (updated 2026-07-11)

Actionable backlog only — no history/narrative. Each item has enough context to pick up
directly. Ranked by priority within each section. Verified against `main` on 2026-07-11
(the prod-readiness-phase1 program is merged; `signals` table dropped; TimescaleDB is live).

> **Closed since 2026-07-02** (see git / memory for detail, do not re-open):
> breakout classifier / Lever #4 (`breakout_classifier.py`, advisory-only, honest 5yr
> purged-OOF AUC 0.6138 — the strongest signal in the system); ATR exit geometry for AI
> signals (`atrBarriers.ts`, Lever #1); phantom-return guard (`is_plausible_return`, >100%
> moves → NEUTRAL, Lever #3); ml-daily-ops / weekly-retrain made fault-tolerant (per-step
> `.catch`, 518854f); BullMQ `lockDuration` stall fixes (a02d937); Redis consolidated to a
> single Docker broker; unified-ranker rescheduled to 07:30 IST pre-open (was building on
> stale inputs); NaN-safe `win_probability` + calibration (ba68c0f); 5 fetcher fixes + Nifty
> GEX rewired to NiftyTrader (2026-07-11 sweep); `backend-python/app/` consolidated 24→4 files
> (largely closes old P1 "app drift").

---

## P0 — Do first (prevents recurrence of a real incident)

1. **`ensemble.pkl` has no versioning, no backup, and no enforced promotion bar.**
   `register_model()` in `ml_ensemble.py` still sets `is_active=1` on every retrain and saves
   over the single unversioned `ensemble.pkl` (gitignored — no backup exists). Verified still
   open 2026-07-11 (no backup/promotion-gate code in `ml_ensemble.py`). Fix:
   - Copy the current `ensemble.pkl` to a timestamped backup before overwriting it.
   - Enforce the documented promotion bar (held-out AUC ≥ baseline + 0.005, top-decile
     precision doesn't regress) before setting `is_active=1` — don't auto-activate a worse model.
   - File: `src/server/ml_ensemble.py`, `register_model()` and `run()` save path.

2. **`technicalSignalsService.ts:1058`** — `runTechnicalSignalScan`'s core OHLCV query is still
   unbounded (`SELECT ... FROM stock_ohlcv ORDER BY symbol, date ASC`), so passing a historical
   `scanDate` still computes indicators using future bars — the surrounding feature reads
   (FII/DII, delivery, PCR, sector) ARE bounded by `scanDate`, but the price series that drives
   the indicators is not. Unsafe for backfill. Verified still open 2026-07-11. Fix: bound the
   OHLCV query by `scanDate`. This is the tool that would make the permanent
   `signal_outcomes`/`technical_signals` generation gap recoverable (see bottom of file).

---

## P1 — ML / accuracy (highest trading-relevance)

3. **Deployed `win_probability` has no live edge outside BEAR** (found 2026-07-10, the biggest
   open accuracy fact). Live per-regime AUC of the stored/rank-scaled probability: BULL ≈0.500,
   SIDEWAYS ≈0.493, BEAR 0.613. The 0.75 headline is purged-CV on the training label; it does
   NOT survive deployment in non-BEAR regimes, so:
   - Gating screener/technical emission on calibrated win-prob is **not viable now** (isotonic
     flattens SIDEWAYS to a degenerate ~0.524 — a gate would drop rows arbitrarily).
   - Per-regime calibration is built but stays dormant behind its data floor.
   - **The clean gate to add once the model has edge** (revisit in BEAR or after live
     regime-AUC improves): mirror the existing `recommendation_log` EXPIRE
     (`win_probability < regime_threshold≈0.40`) onto `unified_signals`
     (source IN TECHNICAL/screener/SCREENER_SURFACING) + add `AND us.status!='EXPIRED'` to
     `resolve_unified_outcomes`.
   - The real lever is raising the deployed probability's discrimination, not gating on it.

4. **Label redesign** (WIN/LOSS-only binary → 3-class incl. NEUTRAL, or per-horizon
   profitable-net label). Still the biggest structural accuracy lever. High blast radius
   (touches calibration/gate/sizing) — needs an explicit go/no-go before starting.

5. **Promote the breakout classifier from advisory to a live screen.** `breakout_classifier.py`
   is the one component with proven durable edge (5yr purged-OOF AUC 0.6138, top-decile 1.47×
   base breakout rate) and already writes `technical_signals.breakout_probability` daily, but
   nothing consumes it for ranking/sizing/gating yet. Next: (a) blend `breakout_probability`
   into `unified_ranker` as a component score, and/or (b) add better features (delivery /
   options / sector, where available) to lift 0.61. This partly supersedes the old
   "cross-sectional ranking model" item — the breakout model IS cross-sectional; extend it.

6. **`outcome_resolver.py` per-row OHLCV N+1** (`resolve_outcomes`, `resolve_unified_outcomes`,
   `resolve_dl_predictions.grade_for`, `resolve_recommendation_log` — 2-6 sequential queries ×
   2000-5000 rows/run). The transaction-poisoning bug was fixed; the N+1 batching was not.
   Needs its own TDD'd session given the `simulate_exit` chandelier-trailing complexity.

7. **GDELT sentiment** — backfill exists (`gdeltService.ts`), never joined into
   `ml_ensemble.build_features`. Bounded, well-scoped. Note: prior ablation showed market-LEVEL
   features don't help a per-stock classifier — treat GDELT as a **per-stock** entity-tagged
   feed (per-symbol tone), not a market-level index, or it will fail the same way.

8. **`portfolio.ts` `buildRiskParityWeights` / `getRecentCloses`** — confirmed dead code (zero
   callers). Either wire in for real covariance-aware sizing (currently superseded by
   inverse-vol sizing in `unified_ranker.py`) or delete it. Correlation-aware sizing + sector
   caps remain a genuine open accuracy item if pursued for real.

---

## P2 — Performance (N+1 batching; reference fix style in `unified_ranker.py` /
`signalOutcomesService.ts` / `correlationService.ts` git history)

9. `src/server/backtestRunner.ts:56-57` — up to 100 items × 2 sequential `dbGet` calls. Easy,
   low-risk first pickup.
10. `src/server/moneycontrolScreener.ts:230-235` — per-stock upsert, not even in a transaction.
    Min fix: wrap in `dbTransaction`. Better: multi-row via `dbBulk.ts`.
11. `src/server/strategySignalsService.ts` (~91/175/242) — 2-round-trip existence-check + insert
    per matched symbol.
12. `src/server/trendlyneScreener.ts:1352-1389` — nested loop, up to 3 sequential `dbGet`/stock.
13. `src/server/technical_analysis_engine.py::process_all` — one `load_ohlcv(symbol)` per symbol.
14. `src/server/screener_performance.py` — `phase_b_fill_returns` (~8 q/row) + `phase_c_bayesian`
    (3 q × 1,521 screeners).
15. `src/server/reward_engine.py::update_weights` — N+1 per-row `SELECT` with no `--days` cutoff
    over full outcomes history; a `--dry-run` hung >150s. Risks the cron silently timing out and
    leaving `signal_type_weights` stale (read by `scoring_engine.py` at startup). Batch via JOIN
    + bounded default window; verify batched result matches per-row semantics exactly.
16. `mcApiService.ts` + `moneycontrol_fetcher.py` — two independent paths hit the same 7 MC
    endpoints per stock in overlapping windows; `mcApiService.ts` uses a private local cache
    instead of shared `cacheService.ts`/Redis.

---

## P3 — Correctness flags from the 2026-06-29 health audit (need domain sign-off, not blind fix)

17. **`insightService.ts:242-260` (`getIndexData`)** — on fetch failure falls through to a
    **hardcoded fake index snapshot** (`NIFTY 50 @ 22450.30`) indistinguishable from live data.
    Decide whether callers can tolerate `null`/throw, then delete the fake data.
18. **`scoring_engine.py:444-472`** — `news_sentiment_items` load falls back to legacy
    `news_articles` on *any* exception and sets `sentiment_score=1.0`/`impact='MEDIUM'` (maximum
    bullish) for every article. Touches scoring math — decide the right fallback value + narrow
    the exception.
19. **`processMlDailyOps` / `processMlWeeklyRetrain` always report `{success:true}`** even if
    every Python sub-step failed (each is individually caught). Making it reflect partial/total
    failure changes job-monitoring/Telegram alert semantics — needs sign-off on the
    degraded-vs-failed threshold.

---

## P4 — Data / vendor-blocked (no code fix; monitor only)

20. `iv_rank`/`iv_skew` structurally empty — NSE Akamai-walled, NiftyTrader gives 0.0 IV for
    equities. `stock_options_oi` accumulates forward-only via `pcr_fetcher`. Only known unblocked
    path for real per-equity IV+greeks: paced Trendlyne per-stock option-chain
    (`smartoptions.trendlyne.com`) — not implemented, blocked by burst rate-limiting.
21. Survivorship bias — training universe is current-listed-only (0 delisted in `stock_ohlcv`).
    Vendor-blocked.
22. **Three fetchers still broken upstream, awaiting a working URL from the user** (per the
    ask-don't-research preference — see `docs/FETCHER_HEALTH_TRACKER.md`):
    `mf_sector_flow_fetcher.py` (AMFI bulk endpoint returns an HTML frameset),
    `mf_holdings_fetcher.py` (ET Markets endpoint 404s for every symbol), and the cash-flow
    params of `working_capital_fetcher.py` / `financial_ratios_fetcher.py` (Trendlyne discontinued
    those quarterly line-items). All fail gracefully; they produce no new data until replaced.
    Alternative for the last: derive CCC / FCF-yield / interest-coverage from the
    `stock_fundamentals` / `fundamentals_history` we already ingest.
23. Regime-conditional calibration — mechanism built and safe but dormant (each regime has only
    ~1 short episode of resolved-outcome data). Auto-activates once time passes and the floor
    clears. No action.
24. `technical_analysis_signals` elimination (Cluster B, deferred) — redundant indicator
    write-path; needs `technical_features` extended with trend/bollinger/pattern columns first.

---

## P5 — Test hygiene

25. `test_fundamentals_pit.py` (3 failures) — leak-free by construction; a Postgres-`LATERAL`-vs-
    SQLite syntax gap in the harness. Fix: `@pytest.mark.skipif(not use_postgres())` so they stop
    reporting false negatives (don't rewrite the canonical training query's `LATERAL` join just
    for a test).

---

## Permanent, accepted limitation (no action item — context only)

`signal_outcomes` / `technical_signals` had an unrecoverable ~3.5-week generation gap
(2026-06-04 → 06-29). Exhaustively checked: SQLite fallback (same gap), a June-20 Postgres
backup (same gap), the live scanner (unsafe for backfill until item #2 lands). Nothing to do
except item #2, which would make future gaps recoverable. Note: the MC deep-history OHLCV
backfill (2021+, 2.57M rows) heals the *price* history, not the derived signal/outcome gap.
