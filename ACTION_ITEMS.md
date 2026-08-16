# Action Items — Pending Only (reconciled 2026-08-16 against `4edf84a`)

Actionable backlog only — no history/narrative. Each item has enough context to pick up
directly. Ranked by priority within each section.

> **How to read the verification tags.** The 2026-07-11 pass let rows sit for five weeks while
> the code moved underneath them: **one P0 had already been fixed and still read "verified still
> open"**. So every row now carries what was actually checked and when. `[verified 08-16]` means
> the source was read this pass. `[unverified]` means the row is carried forward as previously
> written and must be re-checked before anyone starts on it — it is a claim, not a task.

> **Closed at the 2026-08-16 reconciliation** (do not re-open; evidence in each line):
> **#2** OHLCV scan bound — fixed 2026-07-30 (Finding #34), `technicalSignalsService.ts:1229`
> now bounds both sides, in-code comment dates it. **#5** breakout classifier — is a live
> weighted component in `unified_ranker.py` (`'breakout'`, 0.0792, regime-tilted; see its
> comment block at L82-88). **#7** GDELT — wired into `ml_ensemble.build_features` as
> `COALESCE(ts.news_sentiment_score, gdelt.tone_scaled)` via a LATERAL join (L1062, L1212-1221),
> and correctly as a per-stock feed, not a market-level index. **#3** superseded by
> `.claude/rules/measurement.md`'s 2026-08-15 `win_probability` grading (which flipped twice in
> one session — read it there, not here). **#24** superseded by `scoring-authority.md`: Cluster
> B-lite folded `technical_analysis_signals` into `unified_signals` in 2026-08, and the full
> merge was **rejected on its merits**, not deferred. **#25** superseded — the test substrate
> moved to Postgres, full pytest is green, and the prescribed `skipif(not use_postgres())` is now
> a no-op since that returns true unconditionally.

> **Earlier closures (2026-07-02 → 07-11), retained for context:** breakout classifier built
> (advisory, 5yr purged-OOF AUC 0.6138); ATR exit geometry; phantom-return guard; ml-daily-ops
> fault tolerance; BullMQ `lockDuration`; Redis consolidation; unified-ranker moved to 07:30 IST;
> NaN-safe `win_probability` + calibration; `backend-python/app/` 24→4 files.

---

## P0 — Do first

1. **`ensemble.pkl` promotion bar — confirm it gates activation, then close.** `[verified 08-16,
   partially closed]` The original row claimed no versioning, no backup and no promotion bar. Two
   thirds are now done: backup-before-overwrite exists in `promote_or_register()`
   (`ml_ensemble.py:2755`, `shutil.copy2` to a timestamped `.bak`) and was added to
   `incremental_update()` as well; `src/server/model_promotion.py` exists and exports
   `clears_promotion_bar()` / `decide_promotion_with_nan_guard()`; and activation is gated behind
   an `if activate:` branch rather than firing on every retrain.
   **Residual, and the only thing left here:** trace who passes `activate=True` and confirm it is
   the promotion-bar decision that sets it, not the caller unconditionally. If it is wired, close
   this item outright.

---

## P1 — ML / accuracy (highest trading-relevance)

2. **Label redesign** (WIN/LOSS-only binary → 3-class incl. NEUTRAL, or per-horizon
   profitable-net label). `[unverified]` Still the biggest structural accuracy lever. High blast
   radius (touches calibration/gate/sizing) — needs an explicit go/no-go before starting.

3. **`outcome_resolver.py` per-row OHLCV N+1.** `[verified 08-16, open]` `resolve_outcomes`
   (L237) and `resolve_unified_outcomes` still loop per row (L301, L482) issuing
   `SELECT close FROM stock_ohlcv` (L211) each iteration — 2-6 sequential queries × 2000-5000
   rows/run. The transaction-poisoning bug was fixed; the batching was not. Needs its own TDD'd
   session given `simulate_exit`'s chandelier-trailing complexity.

4. **`portfolio.ts` `buildRiskParityWeights` — NOT dead code. Corrected 2026-08-16.**
   `[verified 08-16, open]` This row said "confirmed dead, zero callers" through several passes,
   including one earlier the same day. **That is wrong.** It is live: `server.ts:458` calls
   `portfolioModule.default.buildRiskParityWeights(symbols, 90)` on the picks-export endpoint
   whenever `riskModel !== 'equal'`. A named-import grep (`import { buildRiskParityWeights }`)
   misses it because the call goes through the **default-export namespace object** — the same
   every-reader blind spot `recurring-bugs.md` records for table consumers, in module form.
   **Do not delete it.** The genuine open item is narrower: the endpoint's risk-parity path is
   unreached by the UI and untested, and correlation-aware sizing + sector caps (superseding
   `unified_ranker.py`'s inverse-vol sizing) remain real accuracy work if pursued deliberately.
   Before touching any "dead export" in this repo, grep the bare symbol name, not the import.

5. **Extend the breakout model rather than promote it.** `[reframed 08-16]` The old "promote it
   from advisory" framing is done — it is a live ranker component. What remains is the second
   half of that item: **lift its 0.6138 AUC with better features** (delivery / options / sector,
   where available). It is still the one component with proven durable edge, and
   `.claude/rules/measurement.md` records no other factor clearing significance, so this is the
   highest-value modelling work on the list.

---

## P2 — Performance (N+1 batching)

Reference fix style: `unified_ranker.py` / `signalOutcomesService.ts` / `correlationService.ts`
git history.

6. `backtestRunner.ts` — `[verified 08-16, open]` two sequential `getOhlcvOnOrAfter` calls per
   scored item, up to 100 items. Easy, low-risk first pickup. (Note: the unrelated TIMESTAMPTZ
   `.slice()` crash in the same function *was* fixed during the SQLite decommission — don't
   mistake that for this.)
7. `moneycontrolScreener.ts` — `[verified 08-16, open]` a per-screener `dbGet` inside the
   `MC_SCREENERS` loop (L229) plus the per-stock upsert, not in a transaction. Min fix: wrap in
   `dbTransaction`. Better: multi-row via `dbBulk.ts`.
8. `strategySignalsService.ts` (~91/175/242) — `[unverified]` 2-round-trip existence-check +
   insert per matched symbol.
9. `trendlyneScreener.ts` (~1352-1389) — `[unverified]` nested loop, up to 3 sequential `dbGet`
   per stock.
10. `technical_analysis_engine.py::process_all` — `[unverified]` one `load_ohlcv(symbol)` per
    symbol.
11. `screener_performance.py` — `[unverified]` `phase_b_fill_returns` (~8 q/row) +
    `phase_c_bayesian` (3 q × 1,521 screeners).
12. `reward_engine.py::update_weights` — `[verified 08-16, half closed]` **the timeout risk is
    gone**: the function now takes `days` and defaults to `DEFAULT_WINDOW_DAYS` (L121-127), so it
    no longer scans full outcomes history unbounded. The **N+1 per-row `SELECT` remains**. Batch
    via JOIN; verify the batched result matches per-row semantics exactly.
    ⚠ Before optimising this, read `recurring-bugs.md`: this function's
    `unified_signal_outcomes` UNION half is **inert** (supplies NULL for the column it keys on),
    so it cannot learn from AI/QUANT outcomes at all. Making that work is an RL-weighting change
    needing backtest evidence — do not silently "fix" it while batching.
13. `mcApiService.ts` + `moneycontrol_fetcher.py` — `[unverified]` two independent paths hit the
    same 7 MC endpoints per stock in overlapping windows; `mcApiService.ts` uses a private local
    cache instead of shared `cacheService.ts`/Redis.

---

## P3 — Correctness flags (need domain sign-off, not blind fix)

14. ~~**`insightService.ts` (`getIndexData`) fake index snapshot**~~ — **FIXED 2026-08-16.** It
    returned a hardcoded `NIFTY 50 @ 22450.30` on every failure path, reachable from the live
    `indices.getIndexDetails` tRPC procedure — so a failed *BANKNIFTY* lookup handed the caller a
    plausible NIFTY 50 quote under the index they had asked for, indistinguishable from real data.
    Now returns `null`, matching `getStockInsights`' existing convention in the same file, and logs
    the error instead of swallowing it. No frontend consumer of that procedure exists, so the null
    is unreached by UI today.
15. **`scoring_engine.py:631`** — `[verified 08-16, open]` `news_sentiment_items` load falls back
    to legacy `news_articles` on *any* exception and sets `sentiment_score=1.0` (maximum bullish)
    for every article. Touches scoring math — decide the right fallback value + narrow the
    exception.
16. **`processMlDailyOps` / `processMlWeeklyRetrain` job-level result.** `[verified 08-16,
    partially closed]` The per-step half is done: sub-steps are wrapped in `T.run(...)` so the
    dashboard reflects each one's real outcome, with an in-code comment saying this replaced "the
    old blanket 'success'". **The job-level return is still an unconditional
    `return { success: true }`** (`queues.ts:483` signature, L1136 return), so a run where every
    Python step failed still completes green at the queue level. Remaining decision is the
    degraded-vs-failed threshold and what that does to Telegram alerting.

---

## P4 — Data / vendor-blocked (no code fix; monitor only)

17. `iv_rank`/`iv_skew` structurally empty — `[unverified]` NSE Akamai-walled, NiftyTrader gives
    0.0 IV for equities. `stock_options_oi` accumulates forward-only via `pcr_fetcher`. Only known
    unblocked path for real per-equity IV+greeks: paced Trendlyne per-stock option-chain
    (`smartoptions.trendlyne.com`) — not implemented, blocked by burst rate-limiting.
18. Survivorship bias — `[unverified]` training universe is current-listed-only. Partly addressed
    by the NSE bhavcopy work, but **`backtester.py` still prices from `stock_ohlcv` rather than
    `nse_universe_history`** (recorded in memory, never given an action row until now).
19. **Three fetchers still broken upstream, awaiting a working URL from the user** `[verified
    08-16 via FETCHER_HEALTH_TRACKER, open]` — per the ask-don't-research preference:
    `mf_sector_flow_fetcher.py` (AMFI bulk endpoint returns an HTML frameset — this is also what
    keeps `mf_sector_allocation` empty in AF-20260815-05), `mf_holdings_fetcher.py` (ET Markets
    endpoint 404s for every symbol), and the cash-flow params of `working_capital_fetcher.py` /
    `financial_ratios_fetcher.py` (Trendlyne discontinued those quarterly line-items). All fail
    gracefully; they produce no new data until replaced. Alternative for the last, needing no
    vendor: derive CCC / FCF-yield / interest-coverage from `stock_fundamentals` /
    `fundamentals_history`, already ingested.
20. Regime-conditional calibration — `[verified 08-16, still dormant]` `ml_calibration.py` has
    `per_regime_auc()` (L131) and `regime_readiness`, but its own comment at L185 states they are
    **print-only — nothing persists them**. So this is dormant by construction, not merely
    waiting on a data floor. Auto-activation will not happen on its own; persisting the output is
    a real (small) piece of work whenever the floor clears.

---

## P5 — Calendar-blocked measurement (elapsed time is the only fix)

Full detail and the exact re-run commands live in `.claude/rules/measurement.md`. Listed here so
they are not mistaken for engineering work.

21. **The canonical ranker is not gradeable yet** — needs ~30 pre-market dates in
    `unified_recommendations_history`; clock started 2026-08-12, so ~late September. Do not quote
    a ranker accuracy number before then.
22. Three analyst columns (`eps_revision_3m_pct`, `target_revision_3m_pct`, `analyst_count_chg`)
    unblock around **2026-09-05**, or sooner with a deeper `analyst_estimates_history` backfill.
23. `ccc_trend` is arithmetically impossible today — a YoY delta where **0 of 1,675 symbols** have
    2+ fiscal years in `working_capital_history`.
24. `screener_breadth` and `earnings_beat_yoy/qoq` re-tests both need ~12+ months of history
    (9 and 3 periods respectively today).
25. `pead_model.compute_pead_score()` is unusable at **any** history depth — both required inputs
    (`eps_growth_yoy/qoq`) are ~100% NULL across the panel. Dead schema, not a calendar problem.

---

## Permanent, accepted limitation (no action item — context only)

`signal_outcomes` / `technical_signals` had an unrecoverable ~3.5-week generation gap
(2026-06-04 → 06-29). Exhaustively checked: SQLite fallback (same gap), a June-20 Postgres
backup (same gap). The scanner is now safe for backfill (old #2, fixed 2026-07-30), so **a future
gap would be recoverable — this specific one still is not**, because the inputs to regenerate it
are what's missing, not the tool. Note: the MC deep-history OHLCV backfill (2021+, 2.57M rows)
heals the *price* history, not the derived signal/outcome gap.

---

## Where the rest of the backlog lives

This file is not the whole picture, and pretending otherwise is what let it rot. Also open:

- **`docs/audit-findings.md`** — the live ledger, and the only tracker here with a working
  close-out discipline. 4 open (AF-20260815-01, -05, AF-20260816-09, -10).
- **`docs/SQLITE_DECOMMISSION_PLAN.md`** — 37 files still on the `sqlite3.connect` shim; the flag
  flip is now unblocked (suite is 0-fail on Postgres).
- **`.claude/rules/recurring-bugs.md`** — 3 known-and-decided-against items, two of which need
  backtest evidence before anyone touches them.
- **Memory** (`~/.claude/projects/.../memory/`) — several found-not-fixed items with no ledger
  row: the drift-detector 61% residual, `finbert_scorer`'s neutral conflation,
  `nse_stocks.status` never leaving ACTIVE, the bitemporal `screener_appearances` decision,
  and `DATA_GAP_MANIFEST`'s E4/E5 feeds that are live but never reach `build_features`.
- **GitHub Dependabot** — 1 high-severity advisory on the default branch, recorded in no markdown
  file at all.
