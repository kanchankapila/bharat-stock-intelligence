# Intraday Pipeline, Strategy Design & Screener Audit — 2026-07-31

Scope: (1) review the jobs and data feeding intraday capture, (2) design an intraday stock-selection
strategy as a trading analyst would and backtest it on live data, (3) determine whether the intraday
screeners earn their resource cost, (4) verify the open items across all prior audits.

All numbers below come from read-only queries against the **live production Postgres** and from a
purpose-built backtest harness over `intraday_ohlcv` (15-min bars). No production code was changed
in this pass — this is a measurement pass. Scratch harness lives outside the repo.

---

## 0. Headline

The intraday pipeline runs reliably and captures a lot of data. The problem is not availability, it
is **direction and cost**:

1. **The production intraday engine is on the wrong side of the effect it is trying to trade.**
   Every momentum/breakout feature has a *negative* cross-sectional IC against the remainder of the
   session (t = −3 to −11 across 23 days). `intraday_ranker.py` blends 45% breakout + 55% screener
   confluence — both momentum-flavoured — so it systematically buys the names that go on to
   underperform. Re-graded honestly, its Buy/Strong-Buy signals return **−0.10% gross per trade vs a
   −0.003% universe**, i.e. roughly **−0.10% of genuine negative alpha per trade**.
2. **The production backtest that says otherwise is measuring the wrong thing.**
   `intraday_outcome_resolver.py` grades intraday signals against the **daily** OHLC bar, which
   includes price action from *before* the signal existed. That fabricates "gap" exits
   (`STOP_GAP`, avg −9.54% over 122 trades) that are not trades.
3. **No intraday strategy I could construct is net-positive after realistic costs.** 256
   configurations across 8 signal families × 4 decision times × 4 exit rules: the best net return at
   a *generous* 15bps round-trip is **−0.004%**. The only statistically robust signal is
   mean-reversion, and its magnitude (~0.10–0.22%) sits below the cost floor.
4. **The one apparently-profitable variant is not harvestable.** Shorting intraday strength returned
   +0.84%/day gross on the full liquid universe — but that collapses to **+0.02%/day (alpha −0.03%,
   t = −0.27)** once restricted to the F&O universe, i.e. the names you can actually short. The
   entire edge lived in non-shortable small caps.
5. **The intraday screeners are informative but are being read backwards** — and the ML layer on top
   of them has **AUC 0.4962**, i.e. no skill at all.

---

## 1. What actually runs for intraday capture

| Job | Cadence (IST) | Writes | State |
|---|---|---|---|
| `intraday-fetcher` | */15, 09:15–15:30 (weekdays, holiday-gated) | `intraday_ohlcv` | 330 runs, 0 fails |
| `market-regime-refresh` → chain | */15, 09:15–15:30 | see below | 514 runs, 14 fails |
| └ `market_regime_fetcher.py` | (step 1) | `macro_asset_prices` | ok |
| └ `pcr_fetcher.py --gex` | (step 2) | `macro_asset_prices` | ok |
| └ `intraday_regime.py` | (step 3) | `app_settings.intraday_regime`, `intraday_regime_history` | ok |
| └ `intraday_ranker.py` | (step 4) | `intraday_recommendations(_history)` | 444 runs, 7 fails |
| `live-screener-collect` | */15, 09:15–15:30 | `live_screener_*` | 500 runs, 1 fail |
| `trendlyne-intraday` | */15, market hours | trendlyne screener tables | 2223 runs, 0 fails |
| `preopen-snapshot` | 09:10 | preopen tables | 18 runs, 5 fails |
| `intraday_features.py` | post-close (in `ml-daily-ops`) | `technical_signals` (3 cols) | see §2.2 |
| `intraday_outcome_resolver.py` | post-close | `intraday_recommendation_outcomes` | see §3 |
| `intraday_strategy_learner.py` | post-close | `intraday_strategy_lifts` | ok |
| `intradayBreadth.ts` | ad hoc | `intraday_breadth_snapshots` | **54 rows total, last 2026-07-30** |

Operationally this is healthy — cadences are sensible, market-hours gating works, failure counts are
low. The problems are in the data content and the consumers.

### 1.1 Data captured

`intraday_ohlcv`: 2,077,512 rows, 15-min bars, 2,348 symbols. **Full-universe coverage only begins
2026-06-29** — before that it is <1,000 symbols/day and pre-June it is a handful. Usable
full-universe history is therefore **23 trading days**. This is the binding constraint on everything
in §4.

---

## 2. Data-quality defects found

### 2.1 ~1 synthetic junk bar per real bar for actively-fetched names

The fetcher writes the vendor's "last price" snapshot as if it were a bar, timestamped at *fetch
time* rather than on the 15-min grid. July: **101,716 rows (5.5%) are off-grid, and 99.3% of those
have zero volume**; 18.1% of all July rows are flat (`O=H=L=C`). For names fetched successfully every
cycle the ratio is far worse — **RELIANCE has 49 rows for a 25-bar session on 2026-07-30**, i.e. one
junk row per real bar:

```
09:30:00   1281.5 / 1282.3 / 1279.6 / 1279.6   vol 187458   <- real bar
09:30:20   1281.6 / 1281.6 / 1281.6 / 1281.6   vol 0        <- snapshot written as a bar
```

### 2.2 That corrupts `intraday_features.py`, which selects bars **positionally**

`compute_intraday_features()` takes `grp.iloc[:2]` as the 30-min opening range and `grp.iloc[:4]` as
the first hour. With snapshot rows interleaved, "first 4 bars" frequently covers 45 minutes, not 60.
Measured against the same feature recomputed from clean grid bars for 2026-07-30:

| | correct | stored |
|---|---|---|
| `first_hour_vol_share` mean | 0.245 | **0.197** |
| correlation | — | **0.642** |
| exact match | — | **5.9%** |
| MAE (feature range 0–1) | — | **0.060** |

Same class as the audit-2026-07-30 finding that `screener_momentum_score` cannot be reproduced from
its own source. Fix: filter to on-grid bars in the SELECT, or select by timestamp rather than
position.

### 2.3 `vwap_deviation_pct` is a constant zero for every symbol, every day

`intraday_ohlcv.vwap` is **100% NULL** — the column is written as NULL by the fetcher and never
populated. `intraday_features.py` falls back to `vwap_dev = 0.0` when no VWAP is present, so the
feature is stored as `0.0` for all 2,140 rows on 2026-07-30 (min 0.0, max 0.0). It looks populated
to any coverage check and carries zero information.

This matters more than it looks: VWAP deviation computed properly (typical-price × volume over the
session, which I did in the harness) turns out to be **the single best-ranked intraday signal in the
whole dataset** (§4.1). The platform is discarding its best intraday feature by writing NULL into it.

### 2.4 Missing intraday reference data

- **No index intraday bars.** Only `NIFTYBEES` (710 bars) exists. No intraday relative-strength vs
  NIFTY, no intraday beta hedge, no index-relative regime.
- **No price-band/circuit table.** Cannot exclude circuit-locked names from a signal set.
- `tick_data` = 0 rows, `order_book_snapshots` = 0 rows → **no bid-ask data**, so true slippage
  cannot be modelled. This is the largest single uncertainty in §4's cost conclusions.

---

## 3. The production intraday backtest is invalid

`intraday_outcome_resolver.py` reads the **daily** bar from `stock_ohlcv` and compares a signal's
entry/target/stop against that day's `open`/`high`/`low`:

```python
if o >= tgt:   exit_p, reason = o, "TARGET_GAP"
elif o <= stop: exit_p, reason = o, "STOP_GAP"
elif hi >= tgt and lo <= stop: ...
```

`o`/`hi`/`lo` are the **09:15-to-close** figures. The signal is generated later in the session. So:

- The day's open is compared to a target computed off a *later* price → phantom `TARGET_GAP` /
  `STOP_GAP` exits that never existed. Live: **122 `STOP_GAP` rows averaging −9.54%** and 42
  `TARGET_GAP` rows averaging +5.21%. Neither is a real trade.
- `high`/`low` include pre-signal price action, so targets and stops can be "hit" before entry.

Everything downstream of this table — the reported win rate, `intraday_strategy_learner.py`'s lifts,
the accuracy metrics — inherits the error.

**The data to do this correctly already exists.** `intraday_ohlcv` holds 15-min bars; the resolver
should walk bars strictly after the signal's own cycle timestamp.

### 3.1 The engine re-graded honestly

Using `intraday_recommendations_history` (which does carry `cycle_at`), entering at the **next
15-min bar open after the signal** and exiting only on post-entry bars:

```
clean trades 3365 over 10 days (2026-07-17 -> 2026-07-30), 336/day

exit-at-close       GROSS mean=-0.099%  median=-0.202%  sd=2.20
   cost=0.15% -> mean=-0.249%  win=40.3%  t= -6.55
   cost=0.50% -> mean=-0.599%  win=31.3%  t=-15.77

engine stop/target  GROSS mean=-0.132%  median=-0.338%
   cost=0.15% -> mean=-0.282%  win=38.8%  t= -8.94

universe (10:15 open -> close) mean = -0.003%
```

So ~**−0.10% to −0.13% of true negative alpha per trade**, t = −6.6 to −8.9. And the score carries no
information — quintile means by `intraday_score`: −0.098, −0.087, −0.187, −0.174, +0.052.
Conviction tiers are equally flat (`S_ELITE` mean −0.037%, median −0.338%).

The engine also emits **~1,430 recommendations per day, one per symbol** — that is a scored universe,
not a selection.

---

## 4. Strategy design and backtest

### 4.1 What the data actually says

Cross-sectional Spearman IC of each feature against the *remaining-session* return, computed per day
and averaged over 23 days, liquid universe:

```
T=10:15      meanIC        t          T=11:00      meanIC        t
vwap_dev    -0.0903    -5.74         or_pos      -0.0975    -6.02
range_pos   -0.0895    -6.56         vwap_dev    -0.0971    -5.00
or_pos      -0.0862    -6.45         range_pos   -0.0971    -5.92
ret_pc_T    -0.0818    -6.76         ret_pc_T    -0.0827    -6.24
ret_open_T  -0.0750    -6.59         ret_open_T  -0.0765    -5.97
above_or    -0.0608    -5.64         above_or    -0.0721    -5.46
rvol        -0.0539    -7.37         rvol        -0.0573   -10.96
below_or    +0.0588    +5.96         below_or    +0.0638    +6.30
```

**Every momentum feature is negative; only "broke down" is positive.** Intraday in this universe is
strongly mean-reverting. This is directionally consistent with the audit-2026-07-30 finding that
short-horizon *daily* momentum is significantly negative — the same effect one horizon down.

The strategy the evidence supports is therefore a **fade**: buy intraday weakness / short intraday
strength, not breakout continuation.

### 4.2 Designed strategy and its result

Design (what a trading analyst would build off §4.1):

- **Universe**: ADTV20 ≥ ₹5cr (liquidity floor — an intraday position must be exitable same day).
- **Decision time**: 10:15 IST. Late enough for the opening auction distortion to clear, early enough
  to leave 5 hours of session.
- **Signal**: composite reversal rank = −(rank(`vwap_dev`) + rank(`range_pos`) + rank(`or_pos`)),
  i.e. most oversold vs its own session VWAP and session range.
- **Entry**: next bar's open (10:30) — no look-ahead.
- **Exit**: 15:15 close, or ATR-scaled target/stop (swept).
- **Costs**: swept 0.10% / 0.15% / 0.25% / 0.50% round trip. India intraday explicit costs are
  ~0.085% (brokerage + STT sell-side + exchange + GST + stamp); 0.15% is a fair floor including
  slippage, 0.25% realistic, 0.50% is what the production resolver already assumes.

Result:

```
long composite-reversal N=20, T=10:15
   cost=0.10%  mean=-0.017%  t=-0.13
   cost=0.15%  mean=-0.067%  t=-0.51
   cost=0.25%  mean=-0.167%  t=-1.28
   GROSS mean=+0.083%  sd=0.623  days=23
```

Gross edge is real but is **+0.08%**, below every plausible cost. Widening to a full sweep:

> **256 configurations** (8 signal families × 4 decision times × 4 exit rules × 2 basket sizes).
> **Best net return at 15bps: −0.004%.** Not one configuration is net-positive.

Alpha decay confirms there is no shorter hold that rescues it — the absolute gross return of the best
long basket peaks at **+0.12%** (T=10:15, 1-hour hold) and is ~+0.05% by the close.

### 4.3 The short side, and why it does not survive

Fading intraday strength looked genuinely good:

```
short highest vwap_dev, N=10, T=10:15, all liquid names
   GROSS +0.838%/day   beta-neutral alpha +0.739%  t=2.88
   net @25bps +0.588%/day, 74% of days positive
```

Then restricted to the F&O universe — the realistic shortable set, since brokers' intraday MIS short
lists are essentially F&O names plus select large caps:

```
short highest vwap_dev, N=10, F&O only
   GROSS +0.017%/day   beta-neutral alpha -0.031%  t=-0.27
```

**The entire edge lived in the ~950 non-F&O names**, which are exactly the names you cannot reliably
short intraday, and exactly where bid-ask bounce on a thin book manufactures apparent reversal when
returns are measured bar-close to bar-close. Excluding ASM/GSM names changes nothing further.

### 4.4 Honest limits of this result

- **23 trading days.** That is the hard ceiling imposed by `intraday_ohlcv` coverage. A t-stat of 2–3
  on 23 days for a strategy chosen after inspecting the data is not evidence.
- **One mild regime.** The universe drifted −0.10%/day over the window. A falling tape flatters short
  books and penalises long ones.
- **Slippage is assumed, not measured** — no order-book data exists (§2.4). If real slippage on
  liquid names is materially below 5bps/leg, the marginal cases move.

What is *not* limited by sample size, because it is a property of the code rather than the market:
the sign of the IC (§4.1, t up to −11, consistent across 3 decision times and all liquidity tiers),
the production engine's negative alpha (§3.1, t = −6.6), and the resolver's look-ahead (§3).

---

## 5. Are the intraday screeners worth it?

### 5.1 Resource cost

| Table | Size |
|---|---|
| `live_screener_appearances` | **499 MB** |
| `live_screener_outcomes` | **381 MB** |
| `intraday_recommendations_history` | 117 MB |
| `live_screener_ml_scores` | 18 MB |

~**382,000 appearance rows/day**; 3.85M rows since 2026-06-30. Plus a */15 collection job and a
20-minute-budget resolver ×3/day.

### 5.2 Do they predict anything?

257,704 first-appearances scored over 22 days, entry at next 15-min bar open, exit at close:

```
OVERALL: mean return -0.099%   mean alpha +0.045%

TOP                          n    alpha    ret       t        BOTTOM                    alpha    ret       t
orb5minLow                2380   +0.162  +0.169   6.24        orb5minHigh              -0.151  -0.233  -3.90
stockPEAbove100           2329   +0.116  -0.023   3.68        todayStockOpenLow        -0.043  -0.148  -1.57
yesterdayNR7              3950   +0.095  -0.104   4.15        stockPEBelow5            -0.042  -0.181  -1.03
lowerHighLowerLow         8973   +0.088  -0.050   6.22        outsideDay               -0.032  -0.122  -0.85
todayBelow50SMA           9843   +0.070  -0.049   5.43        higherHighHigherLow      -0.018  -0.155  -1.03
todayGapDown              7573   +0.060  -0.128   3.68        todayAbove20SMA          +0.017  -0.131   1.14

filters with |t|>2: 24 of 41 (expect ~2 by chance) — 23 positive, 1 negative
```

Verdict, in three parts:

1. **They carry real, non-random information.** 24 of 41 filters clear |t|>2 where ~2 would by
   chance, and the pattern is coherent, not noise: every "weakness" filter is positive
   (`orb5minLow` +0.162, `lowerHighLowerLow` +0.088, `todayBelow50SMA` +0.070, `todayGapDown`
   +0.060) and every "strength" filter is negative or flat (`orb5minHigh` −0.151,
   `higherHighHigherLow` −0.018, `todayAbove20SMA` +0.017). `orb5minLow` / `orb5minHigh` is a clean
   symmetric ±0.16% pair.
2. **They are being consumed backwards.** `intraday_ranker.py` weights intraday screener confluence
   at 55% in a *long* score. The filters that fire on strength — the ones a breakout-flavoured
   confluence score rewards — are precisely the negative-alpha ones.
3. **They are not independently tradeable.** Only one filter (`orb5minLow`, +0.169% gross) has a
   positive absolute return at all. At 15bps that is +0.019%; at 25bps it is negative. The +0.045%
   average "alpha" is mostly a size/liquidity artifact of benchmarking against an equal-weight
   universe that includes the illiquid tail.

**So: not a waste — but not worth what is currently being spent on them, and actively harmful in
their current wiring.** They belong as a cheap, correctly-signed feature, not as 880 MB of raw
appearance history feeding a 55%-weighted long score.

### 5.3 The ML layer on top has no skill

`live_screener_ml_ranker.py` → `live_screener_ml_scores.win_probability`, graded against actual
same-day outcome (4,986 scored rows, 5 days):

```
quintile   win_prob    realised return
   0        0.391        -0.0035%
   1        0.467        +0.0097%
   2        0.513        +0.0003%
   3        0.556        +0.0087%
   4        0.629        -0.0397%     <- highest-confidence quintile is the worst

daily rank IC = -0.0017 (t = -0.08)
AUC(win_probability -> positive same-day return) = 0.4962
```

**AUC 0.4962 is no skill.** 5 days is a small sample and the model was retrained mid-window
(two `model_version` values present), so this is suggestive rather than final — but it is consistent
with everything else here, and the model's promotion gate is measuring held-out AUC on a label whose
live discrimination is nil.

---

## 6. Audit backlog verification

Checked against the live DB and current source, not against the docs' own claims.

### Closed / verified done

| Item | Evidence |
|---|---|
| NSE bhavcopy survivorship fetcher | `nse_universe_history`: 3,238,963 rows, 1,377 dates, 2021-01-01 → 2026-07-30, 4,033 symbols. Current. |
| `screener_membership_snapshot` (PIT reproducibility) | 24,882 rows for 2026-07-31 — writing as designed from the day it shipped. |
| `recommendation_log.entry_price` / `stop_loss` | **Fixed and working**: 07-31 241/313, 07-30 262/505; zero before 07-30. The 97.8%-NULL aggregate is historical rows only, not a live gap. Trailing-stop job now has real positions to act on. |
| Breadth staleness guard | `_fresh_breadth()` in `intraday_regime.py` correctly drops snapshots older than `BREADTH_MAX_AGE_MIN`. |
| Weekly `financial_ratios_fetcher` / banking ratios | `nim` present on 40 symbols — ≈ the real bank share. |
| Job schedule destagger | Verified in `queues.ts`; no same-minute collisions in the intraday window. |

### Still open — confirmed by inspection

| Item | Status |
|---|---|
| **`nse_universe_history` → backtest path** | **Still open, as documented.** `backtester.py` references it *only* in `survivorship_gap()` (a reporting function, lines 103–133). The actual trade universe at lines 150/165 still reads `stock_ohlcv`. The gap is measured but not closed. |
| **`adjustment_basis` consumers** | **Not done.** Only `backfill_ohlcv.py`, `backtester.py`, `data_integrity_repair.py`, `mc_ohlcv_backfill.py` reference it. The documented follow-up — wiring `relative_strength.py` / `ml_ensemble.py` / `breakout_classifier.py` to detect a straddling return window — is unimplemented. Moot for now regardless: **287 of 2,608,478 rows are tagged (0.011%)**, by design (no backfill, to preserve Timescale compression). |
| **`live_datasource` test coverage** | 16 test files vs ~140 DB-writing Python files (~11%). Still the largest single control gap. |
| **Finding #31 (regime tilts never backtested)** | Still open; still blocked on regime-labeled outcome history that does not exist. |
| **Pre-2026-07-31 screener feature values** | Permanently unverifiable, as documented. |
| `mc_cagr_3y` | Current-day-only (1,538 on 07-30, 0 on 07-29/28) — working as designed; `densify_feature_matrix.py` cannot reach backwards. Not a defect. |

### Newly found, not previously tracked

- `intraday-breadth-capture` is registered in `monitorScripts.ts` and has a `job_heartbeat` row with
  **run_count = 0** — it is monitored by table freshness only and never calls `recordHeartbeat`.
  Same pattern as the `job-digest` gap closed on 07-31. Its producer (`intradayBreadth.ts`) has
  written only **54 rows, last on 2026-07-30**, so the breadth input to `intraday_regime.py` is
  usually dropped by the staleness guard rather than used.

---

## 7. Recommendations, in priority order

**P0 — correctness (these are wrong regardless of what strategy you run)**

1. **Fix `intraday_outcome_resolver.py` to walk `intraday_ohlcv` bars after the signal's `cycle_at`,
   not the daily `stock_ohlcv` bar.** Everything measured off it today is invalid. The data exists.
2. **Stop writing the vendor snapshot as a bar** in `intraday_fetcher.py` (or mark it), and make
   `intraday_features.py` select bars by timestamp rather than position.
3. **Populate `intraday_ohlcv.vwap`** (typical-price × volume accumulation is a two-line fix) — this
   turns the platform's best measured intraday signal from a constant zero into a live feature.

**P1 — direction**

4. **Reverse or remove the momentum loading in `intraday_ranker.py`.** As wired it has measured
   negative alpha of ~−0.10%/trade at t = −6.6. Given §4, the defensible interim action is to stop
   emitting Buy recommendations from it rather than to flip the sign — a flipped version is still
   below costs (§4.2), so flipping converts a losing signal into a break-even one, not a winning one.
5. **Cut emission from ~1,430/day to a genuine selection**, or relabel the table as a score, not a
   recommendation.

**P2 — the screeners**

6. Keep collecting, stop storing raw. 880 MB of appearance/outcome history for a feature that is
   worth ~0.1% is not a good trade; aggregate to a daily per-(symbol, filter) fact and retain the raw
   rows for a short window.
7. Re-sign the screener contribution in the confluence score per §5.2, or drop `orb5minHigh`-class
   filters from the long side entirely.
8. **Do not promote `live_screener_ml_ranker` further until its live AUC clears 0.5** — the
   promotion gate is currently comparing held-out AUCs of a model with no live discrimination.

**P3 — data required to change the answer**

The negative result in §4 is limited by three specific, closable gaps:

| Gap | Why it matters | Cost |
|---|---|---|
| **23 days of full-universe 15-min history** | The binding statistical constraint. Nothing here can be validated across regimes. | Just time — but backfill 15-min history from the existing MC TechCharts/Yahoo sources if the vendors serve it. |
| **No bid-ask / order-book data** | The entire conclusion turns on a *cost assumption*. Several strategies are within ±0.05% of break-even. | Free from the existing NiftyTrader/broker feeds; `order_book_snapshots` table already exists and is empty. |
| **No index intraday bars** | Cannot compute intraday relative strength vs NIFTY or beta-hedge — the standard way to convert a small directional alpha into a tradeable market-neutral one. | Trivial — same fetcher, add index symbols. |

Two more that are cheap and clearly useful: **price-band/circuit data** (to exclude untradeable
names) and 1-min or 5-min bars (15-min is too coarse to resolve whether a stop or target filled
first — my harness had to assume the stop, which is conservative but crude).

Note the honest framing: closing these gaps will let you *measure* better. Nothing measured so far
suggests a large intraday edge is being missed — the effect that exists is real, robust in sign, and
simply smaller than the cost of trading it.

---

## 8. FIX STATUS — implemented 2026-07-31

Everything in §7 P0–P3 is implemented, plus the two open backlog items from §6 that were
actionable. Every fix was live-run against the real production Postgres, not just unit-tested.
Suites after all changes: **892 Python passed / 65 skipped / 0 failed**, **333 TypeScript
passed**, `tsc --noEmit` clean.

| # | Fix | Verification |
|---|---|---|
| P0-1 | `intraday_outcome_resolver.py` rewritten to walk `intraday_ohlcv` 15m bars strictly after `cycle_at` | Re-resolved all 11 history dates. **Phantom gap exits: 164 → 0.** PnL range **−100.04%…+6.32% → −3.56%…+4.52%**. The corrected number (−0.658% on 07-30 at its 0.50% cost model) independently matches the research harness (−0.632%) |
| P0-2 | `intraday_fetcher.py` drops off-grid vendor snapshot bars | Live MC fetch: 120 bars parsed, **0 off-grid survivors** |
| P0-3 | `intraday_fetcher.py` populates `vwap` (cumulative typical-price × volume, reset per session) | Live: VWAP present and correctly **NULL on the partial first day** of the window (no session open ⇒ no trustworthy accumulation) |
| P0-4 | `intraday_features.py` selects windows by timestamp, not row position; derives VWAP when the column is NULL | Backfilled 4 sessions: `vwap_deviation_pct` **100% zero → ~97% non-zero (sd 2.4)**; `first_hour_vol_share` **0.197 → ~0.23** |
| P1-1 | `intraday_ranker.py` gains `W_REVERSAL` (the one correctly-signed component); breakout cut 0.45→0.20 | Weights assert-sum to 1.0; 2,329 symbols scored from live bars |
| P1-2 | Emission gate — Buy/Strong-Buy only published while the engine's own trailing realised net PnL is positive | Live: **gate CLOSED** (−0.456%/trade over 3,015 honestly-resolved trades), **338 Buys downgraded to Hold, buy_pool 0** |
| P2-1 | `live_screener_ml_ranker.py` measures LIVE AUC and raises the promotion bar when it is unproven | Live: **AUC 0.3778 over 47,559 rows** detected (worse than the 0.4962 first estimated — it is *anti*-predictive); margin raised 0.01→0.05; candidate correctly rejected |
| P2-2 | `live_screener_resolver.py` retention guard (365d) | DELETE proven to match 2.7M rows at a 5-day window, rolled back; **no-op at the default window today** — a growth guard, not a space reclaim |
| P3-1 | Index intraday bars added (`^NSEI`, `^NSEBANK`, `^CNXIT`, `^NSMIDCP`, `^INDIAVIX`) | 976 bars each, 2026-06-09…07-31, plausible ranges (NIFTY50 23,116–24,525; INDIAVIX 11.5–16.3) |
| §6 | `backtester.py` point-in-time universe from `nse_universe_history` | MEGASOFT (stopped trading 2026-02-06): a 2026-07-01 signal is dropped, a 2021-06-01 one kept |
| §6 | `intraday-breadth-capture` moved onto the scheduled 15-min chain + heartbeat | Was cache-driven (fired only on a user request missing cache): **54 rows total, multi-day gaps** |

### Notes on what was deliberately NOT done

- **The ranker's sign was corrected but not inverted into a short book.** §4.3 showed the short
  edge is entirely in non-shortable names. A flipped long score is break-even, not profitable,
  which is why the emission gate — not the sign change — is the load-bearing fix.
- **No bulk backfill of `intraday_ohlcv`.** It is a compressed TimescaleDB hypertable (47 of 59
  chunks); a predicate-wide UPDATE/DELETE would force full decompression, the same trap
  documented for `stock_ohlcv` in the 2026-07-30 audit. Both the junk bars and the NULL VWAPs
  are therefore fixed *forward* in the writer and defended on the *read* side — which has the
  useful property that `intraday_features.py`'s VWAP fallback repairs all historical sessions
  immediately, not just future ones.
- **`nse_universe_history` prices are still not unioned into the backtest.** Only the
  point-in-time *tradability* half was wired, which needs no price adjustment. The prices
  remain blocked on a split-adjustment pass — bhavcopy is RAW while `stock_ohlcv` is
  split-adjusted, and merging them would reintroduce the mixed-basis seam.
- **Screener aggregation** (daily per-(symbol, filter) fact, short raw retention) is the larger
  storage win but changes the shape every consumer reads; deferred to its own pass.
- **Finding #31** still needs regime-labeled outcome history that does not exist.

### The honest bottom line, unchanged by these fixes

The measurement problems are fixed and the engine no longer publishes negative-expectancy
recommendations. **None of that creates an intraday edge.** The effect that exists is real,
robust in sign, and smaller than the cost of trading it; the gate will re-open by itself if and
when that stops being true. The three data gaps in §7-P3 — longer 15m history, bid-ask data,
and now-available index bars — are what would let a future pass *measure* better, not evidence
that a large edge is being missed.

### Additional pre-existing bug found while verifying the index-bar fix

Adding index series to `intraday_ohlcv` surfaced — but did not cause — a live defect:
**index pseudo-symbols were already being emitted as intraday stock recommendations.**
`technical_signals` carries `breakout_probability` rows for `NIFTY50`/`NIFTYBANK`/`NIFTYIT`/
`NIFTYMIDCAP`, so `_breakout_scores()` picked them up and the ranker scored them like equities —
complete with entry/stop/target and position sizing. **522 such rows had accumulated in
`intraday_recommendations_history`.** The eligibility filter only removed the ones that happen
to lack an ADTV, which let `NIFTY50` and `NIFTYMIDCAP` through.

Fixed by excluding index series at the **universe level** in `intraday_ranker.py` rather than
inside any one component, since they now arrive via two independent routes. Leaked rows purged;
verified zero remain after a re-run. Three regression tests pin it, including one that asserts
the reversal component *would* otherwise score an index — the reason a component-level guard is
not sufficient.

---

## 9. BACKLOG RESOLUTION — 2026-07-31 (later session)

The §6 "still open" table is now resolved. Two items are **closed as won't-fix** with reasons,
so future passes do not keep re-opening them; the rest are done or unchanged.

| Item | Resolution |
|---|---|
| **`nse_universe_history` → backtest path** | **DONE.** New `ohlcv_adjust.py` derives split/bonus factors from NSE's own data (649 events persisted), and `backtester.load_ohlcv()` now unions split-adjusted bhavcopy prices for any symbol absent from `stock_ohlcv`. Live: MEGASOFT 1,260 bars ending exactly at its 2026-02-06 delisting, INFIBEAM 1,257, SEQUENT 1,251 — all previously untradeable. Split path verified end-to-end (IVZINNIFTY's 1:10 is continuous across its ex-date). |
| **Finding #31 (regime tilts)** | **RESOLVED — as shrinkage, not a fit.** Measured: BULL has 3 lifetime regime episodes and CRASH 6, and `stock_factor_breakdown_history` has **zero days** of either. Fitting *and* sign-validation are both impossible, and will not become possible on any useful horizon. Tilts are now treated as priors and shrunk halfway to neutral (direction preserved, magnitude damped); `regime_tilt_fit_readiness()` reports when a regime accumulates enough history to justify a real fit. |
| **`adjustment_basis` consumers** | **CLOSED — won't fix.** 287 of 2,608,478 rows are tagged (**0.011%**), and backfilling means decompressing 21 of 24 Timescale chunks and permanently losing the compression. Wiring `relative_strength.py` / `ml_ensemble.py` / `breakout_classifier.py` to a column that is empty for 99.989% of rows buys nothing. The mixed-basis problem it was meant to detect is now handled at source by `ohlcv_adjust.py`. Re-open only if a *dense* basis tag ever exists. |
| **Pre-2026-07-31 screener feature values** | **CLOSED — permanently unverifiable, and superseded.** `screener_membership_snapshot` (2026-07-31) makes every value reproducible from that date forward. A bitemporal rebuild of `screener_appearances` cannot recover state that was overwritten in place, so it would cost a dual-write migration to fix nothing historical. Treat pre-07-31 screener-derived numbers as void and move on. |
| **`live_datasource` coverage** | Improving incrementally, still the largest single control gap. Not closeable in one pass. |
