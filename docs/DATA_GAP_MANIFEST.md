# Data-Gap Manifest — Entry/Exit Accuracy Program

_Quant view of what was implemented from data we already hold, and what new feeds are
required to unlock the rest. Written 2026-06-21 (branch `prod-readiness-phase1`)._

The ensemble (`ml_ensemble.py`) had a held-out AUC ~0.62 — near the ceiling of what
**daily, point-feature** data can give. The remaining accuracy lives in **orthogonal data**
and **better labels**, not more daily indicators. This manifest tracks both.

---

## A. Shipped this pass (no new feed — computed from data we already hold)

| Feature | Where | Source data (already in DB) |
|---|---|---|
| `iv_rank`, `iv_skew` | `iv_features.py` → `technical_signals`; consumed by `ml_ensemble.build_features` | ATM IV + 25Δ-proxy skew now captured by `pcr_fetcher.py` from the **NSE option chain** (`impliedVolatility` per strike) into `stock_options_oi.atm_iv/iv_skew` |
| `score_x_low_iv` interaction | `build_features` | derived (signal_score × (1−iv_rank)) |
| `days_to_fno_expiry` | `build_features` | pure calendar math on `signal_date` (last-Thursday expiry) |
| `results_season` | `build_features` | pure calendar math (Jan/Apr/Jul/Oct earnings clustering) |
| MFE / MAE / `days_to_mfe` / `mfe_before_mae` / `trail_exit_pct` / `horizon_close_pct` | `exit_labeler.py` → `signal_excursions` | `stock_ohlcv` (bar replay) + entries from `signal_outcomes` |
| `rs_rank_21d`, `rs_rank_63d` (cross-sectional relative strength) | `relative_strength.py` → `technical_signals`; consumed by `build_features` | `stock_ohlcv` (universe percentile of trailing return) |
| Point-in-time fundamentals (as-of join, fixes look-ahead) | `fundamentals_snapshot.py` → `fundamentals_history`; as-of join in `ml_ensemble.load_training_data` | daily snapshots of `stock_fundamentals` |
| **Exit-policy head** (predicted MFE/MAE → target/stop) | `exit_policy.py` → `ml_models/exit_policy.pkl` | `signal_excursions` (trains once enough labels accumulate) |

**Note on `iv_rank` history:** it ranks within a trailing 252-day window per symbol. It is
leak-free *today*, but the trailing range only deepens as `stock_options_oi` accumulates
daily snapshots — back-history is **not** available retroactively (NSE serves only the live
chain). Expect iv_rank to be neutral (0.5) for the first ~20 trading days of capture, then
to become informative. **Action: let `pcr_fetcher.py` run daily and the window fills itself.**

**Note on exit labels:** `signal_excursions` is the training target for a *future* exit head
(time-to-target / trailing-stop regression). It is populated now; the exit model that
consumes it is the next build (see §D).

---

## B. Blocked on a NEW external feed (highest value first)

### B1. Intraday microstructure — ✅ FEED LIVE (limited back-history)
`moneycontrol_fetcher.py` (`_fetch_intraday`) calls the MC TechCharts history API and writes
15m bars into `intraday_ohlcv` for every stock in its rolling 150-stock daily batch. The API
provides ~2–5 weeks of 15m history and ~2 months of 60m history. **Intraday feature
engineering** (opening-range break, VWAP deviation, first-hour volume share) still needs a
separate `intraday_features.py` engine that reads `intraday_ohlcv` and writes derived columns
onto `technical_signals`. The feed itself is live and accumulating.

- **Remaining work:** `intraday_features.py` (feature derivation engine) → wire to cron.
- **History caveat:** back-history depth is ~5 weeks at 15m. Training lift only materialises
  after ~90 trading days of daily accumulation (~4 months from first live run).

### B2. Exact earnings calendar (upgrade `results_season` → `days_to_earnings`)
We ship a coarse season flag; the real signal is **distance to the specific stock's results
date**.

- **Data needed:** per-symbol next/last earnings date (board-meeting + result dates).
- **Sources:** NSE corporate-announcements API (`/api/corporate-board-meetings`), BSE
  announcements, Tickertape/Trendlyne event calendars, screener.in.
- **Effort:** low–medium. New `earnings_calendar(symbol, event_date, type)` table + an
  `_days_to_earnings(signal_date, symbol)` feature in `build_features`.

### B3. Promoter pledge / bulk & block deals / insider (SAST) / MF holding deltas — ✅ INSIDER FEED LIVE
`moneycontrol_fetcher.py` (`_parse_insider`) fetches the MC mcinsider widget HTML and writes
insider trades (name, designation, action, qty, price, date) into `insider_trades` for the
daily 150-stock batch. Promoter pledge and MF holding deltas still require separate fetchers.

- **Insider captures:** acquirerName, category (Promoter / Director), typeOfTransaction
  (BUY/SELL), quantity, valueInr, date. Already in the `insider_trades` schema.
- **Remaining work for ML:** `insider_features.py` to compute net insider buy/sell delta over
  rolling 90d → feature on `technical_signals`. Pledge % requires separate NSE/BSE fetch.
- **Effort remaining:** medium (feature engine + pledge fetcher).

### B4. India VIX series (regime-level implied vol)
Per-stock ATM IV is now captured (§A), but the **index VIX time series** as a market-regime
feature is not.

- **Data needed:** daily India VIX close.
- **Sources:** NSE (`/api/allIndices` includes INDIA VIX), or store it as a symbol in the
  existing `macro_asset_prices` table (the `feature_engineering.py` pipeline already has a
  `nifty_vix` slot wired to a NSEBANK proxy — replace with true VIX).
- **Effort:** low. One fetcher row + repoint the existing `nifty_vix` feature.

---

## C. Computable from data we already hold (no new feed)

### C1. Cross-sectional relative strength — ✅ SHIPPED
`relative_strength.py` writes universe-percentile ranks of the 21d/63d return
(`rs_rank_21d/63d`) onto `technical_signals`; consumed by `build_features`. Beta-adjusted RS
vs NIFTY is a possible future refinement but the cross-sectional rank captures most of the edge.

### C2. Market breadth / internals — ⏳ remaining (lowest priority)
`regime` is a 3-class label. Continuous breadth (advance-decline, % above 200DMA,
new-high/new-low) predicts regime turns the label can't — computable from our own universe
in `stock_ohlcv`.

- **Build:** a daily `market_breadth(date, …)` table + merge into `build_features`.

### C3. Point-in-time fundamentals (correctness) — ✅ SHIPPED
`fundamentals_snapshot.py` accumulates a daily `fundamentals_history(symbol, as_of_date, …)`
trail; `ml_ensemble.load_training_data` now joins fundamentals **as-of** each signal_date
(latest snapshot ≤ signal_date), falling back to the current snapshot only until history
accumulates (zero regression in the interim). Reported AUC will drift down toward honest as
the trail fills — that drop is the leak being removed, not a real loss.

---

## D. Label/model work (data already present)

### Exit head — ✅ SHIPPED
`exit_policy.py` trains two regressors on `signal_excursions` (predict expected MFE and MAE
from entry-time features); `suggest_levels()` converts them into concrete target/stop prices
(capture a fraction of expected upside, buffer the stop beyond expected drawdown). Retrains
weekly once enough excursions accumulate — the lever for the *exit* half of accuracy.

---

## E. Fetched-but-not-stored — capture targets (no new vendor; the app already pulls these)

_Audit 2026-06-21 (live PG row counts). The V1/V2 dashboards, MC/Trendlyne deep-dives, screeners and
indices tabs already **fetch** a lot of stock- and market-level data that is rendered and then
discarded. Persisting it builds the point-in-time trail the model needs — these factors are
**cross-sectional per-stock** (unlike market-level VIX/breadth, which a prior ablation showed don't
help), so they are exactly where orthogonal edge should live._

**Capture state today:** stored = `stock_delivery_data` (2,415), `stock_fundamentals` /
`fundamentals_history` (2,210 each), `corporate_actions` (90). **Empty scaffolding** (table exists,
nothing writes it) = `stock_options_oi`, `bulk_deals`, `insider_trades`, `institutional_rankings`,
`proprietary_scores_history`, `trendlyne_technical_snapshots`. **No table at all** = analyst
estimates/targets, earnings calendar, shareholding/promoter-pledge.

| # | Data (already fetched by) | Storage status | Model gap it fills | Back-history |
|---|---|---|---|---|
| E1 | **Analyst consensus / target price / EPS & revenue estimates / # analysts** (`getMcAnalystRating`, `getMcConsensus`, `getMcPriceForecast`, `getMcEarningsForecast`) | ✅ **DONE** — `analyst_estimates_history` table + `analyst_estimates_snapshot.py` snapshotter + 3 ML features (`analyst_buy_pct`, `n_analysts_log`, `target_upside_pct`) wired into `build_features`. Runs in `processMlDailyOps`. 24/24 tests GREEN. | AS-OF join fixes look-ahead; accumulates a daily trail | partial (consensus snapshot) |
| E2 | **Shareholding / promoter pledge / FII-DII-MF stake + QoQ deltas** (`getShareholding`) | no table | **B3** — promoter pledge ↑ is one of the strongest negative signals on the street | quarterly history usually available |
| E3 | **ATM IV / IV skew / PCR** (`pcr_fetcher` → `stock_options_oi`) | table **empty on PG** | `iv_rank`/`iv_skew` — already wired into `build_features` but all-null → neutral; just needs the fetcher actually writing on PG | forward-only |
| E4 | **Bulk / block deals + insider (SAST)** (MC insights / Trendlyne) | ✅ **INSIDER FEED LIVE** — `moneycontrol_fetcher.py._parse_insider` writes to `insider_trades` daily (150-stock rolling batch). Bulk deals + ML feature engine pending. | **B3** — India-specific institutional footprints | some |
| E5 | **MC Stock Vitals: Altman Z, DuPont ROE, Graham Number, Ohlson O-Score** (via `moneycontrol_fetcher.py`) | ✅ **FEED LIVE** — `_parse_vitals` writes to `mc_stock_vitals` + `proprietary_scores_history` daily (150-stock batch). ML feature wiring from EAV→`build_features` pending. | orthogonal quality / financial-health scores | forward-only |
| E6 | **Earnings dates** (`getCorporateActions` / MC / Trendlyne event calendars) | no table | **B2** — `days_to_earnings` + earnings-blackout flag (upgrade the coarse `results_season`) | forward + next-date |

**Pattern for each (same as the shipped `fundamentals_history`):** a daily/periodic snapshotter writes
a `*_history(symbol, as_of_date, …)` table → `ml_ensemble.load_training_data`/`load_pending_signals`
join it **as-of** each `signal_date` → a `build_features` factor with a neutral `num()` fallback →
migrate the column in `db.ts` + `db/schema.postgres.sql` → wire the snapshotter into `processMlDailyOps`.

**Priority (quant):** **E1 analyst estimates** (likely the single best unused signal) and **E3 IV/PCR**
(already wired — just turn on capture) first; then **E2 shareholding/pledge** and **E6 earnings dates**;
**E4/E5** activate the existing empty scaffolding as a fast-follow. Most are forward-only, so the value
is "start the trail now" — AUC won't move until enough as-of history accumulates (same caveat as IV-rank
and PIT fundamentals).

---

## Priority order (quant recommendation)

**Done (no new feed):** C3 point-in-time fundamentals, §A IV capture, §A exit labels,
D exit head, C1 relative strength, calendar features. These compound on the **next ensemble
retrain** (`ml_ensemble.py --train` + `exit_policy.py --train`); the IV window needs ~20
daily `pcr_fetcher.py` runs to become informative.

**Remaining, in order:**
1. **B1 intraday microstructure** — biggest entry/exit lever, but the heaviest feed (broker
   intraday history into the empty `intraday_ohlcv`).
2. **B2 earnings calendar** — exact `days_to_earnings` (upgrade the coarse `results_season`).
3. **B4 India VIX series** — repoint the existing `nifty_vix` proxy to true VIX (low effort).
4. **C2 market breadth** — adv-decline / % above 200DMA from our own universe (no new feed).
5. **B3 corporate signals** — promoter pledge / bulk deals via the existing Trendlyne feed.

---

## Implementation Plan (remaining items)

Each follows the **pattern already established** by the shipped work: a fetcher/enricher writes
a feature onto `technical_signals` (or a small new table joined by symbol/date), it's added to
both `ml_ensemble.load_*` queries + `build_features` with a neutral `num()` fallback, the
column is migrated in `db.ts` **and** `db/schema.postgres.sql`, the engine is wired into the
daily/weekly job in `queues.ts`, and pure logic gets a TDD test. Order = best effort/value first.

### Sprint 1 — quick wins, no new external feed (do first)

**B4. India VIX as a regime feature** *(effort: S, ~half day)*
- Source: NSE `/api/allIndices` (already reachable) → `INDIA VIX` close. Or yfinance `^INDIAVIX`.
- Store as a row in the existing `macro_asset_prices` table (symbol `INDIAVIX`); a tiny fetcher
  alongside `fii_dii_fetcher.py`. `feature_engineering.py` already has a `nifty_vix` slot wired
  to a weak NSEBANK proxy — repoint it; add `india_vix` + `vix_change_5d` to `build_features`.
- Wire: append to `processMlDailyOps` in `queues.ts`. Test: fetch parser + feature passthrough.

**C2. Market breadth / internals** *(effort: M, ~1 day)*
- Source: **none** — computed from our own `stock_ohlcv` universe.
- New `market_breadth.py` → new table `market_breadth(date, pct_above_200dma, adv_decline_ratio,
  pct_at_20d_high, net_highs_lows)`. Pure core `compute_breadth(closes_wide)` (TDD).
- Join into `ml_ensemble.load_*` **by date** (like `nifty_regime`), add the 4 cols to
  `build_features`. Wire after `relative_strength.py` in `processMlDailyOps`.

### Sprint 2 — needs a new (but cheap) external feed

**B2. Earnings calendar → `days_to_earnings`** *(effort: M, ~1–2 days)*
- Source: NSE `/api/corporate-board-meetings` + `/api/event-calendar`; Trendlyne (already an
  integrated provider) is the lower-maintenance route. Resolve symbols via `stockMapping.ts`.
- New table `earnings_calendar(symbol, event_date, event_type, fetched_at)`; fetcher
  `earnings_fetcher.py` (daily). Replace the coarse `results_season` in `build_features` with
  `_days_to_earnings(signal_date, symbol)` (signed: negative = just reported) + an
  `in_earnings_blackout` flag (≤2 trading days pre-event). Test the date math.
- Risk: NSE rate-limits; reuse the `pcr_fetcher.py` session-priming pattern.

**B3. Corporate signals (promoter pledge / bulk-block deals)** *(effort: M–L, ~2–3 days)*
- Source: Trendlyne (preferred — already wired) or NSE `/api/corporate-pledgedata`,
  bulk-deals, SAST disclosures. India-specific, high orthogonal value (pledge ↑ = strong −).
- New table `corporate_signals(symbol, as_of_date, pledge_pct, pledge_pct_chg, bulk_deal_net,
  …)`; fetcher `corporate_signals_fetcher.py`. **As-of join** (like `fundamentals_history`) so
  historical rows see only what was knowable. Add `pledge_pct_chg`, `bulk_deal_net` to the
  ensemble. Test the as-of selection.

### Sprint 3 — heaviest, highest ceiling

**B1. Intraday microstructure** *(effort: L, ~1–2 weeks incl. backfill)*
- Source: broker historical intraday (Zerodha Kite / Upstox / Dhan / Fyers 1-min; TrueData /
  GDFL for tick + L1 depth). Populate the **already-defined but empty** `intraday_ohlcv` table.
- Phase 1 (bars only): `intraday_backfill.py` + daily top-up; derive opening-range break,
  first-hour volume share, VWAP-deviation-at-entry, close-auction imbalance → `technical_signals`.
- Phase 2 (L1 depth, optional): bid-ask spread, order-book imbalance at signal time.
- This is the structural cap on *intraday* entry/exit precision; sequence the bar feed first,
  prove lift, then decide on the depth feed. Highest storage + ops cost of the set.

### Cross-cutting

- **Retrain to realize value:** every shipped/added feature only affects predictions after
  `ml_ensemble.py --train` (+ `exit_policy.py --train`). Schedule a retrain once Sprint 1 lands.
- **Watch for AUC drift down** as point-in-time fundamentals + earnings blackout remove
  leakage — that is correctness, not regression. Compare *live* hit-rate, not just held-out AUC.
- **Backfill vs forward-fill:** IV-rank, fundamentals_history, corporate_signals only accumulate
  going forward (vendors serve current snapshots). Breadth/relative-strength/VIX can be fully
  backfilled from `stock_ohlcv` + history. Prioritize backfillable features for immediate lift.
