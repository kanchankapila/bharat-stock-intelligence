# Data, Bias & Quant-Strategy Audit — 2026-07-30

**Scope:** every table in the live Postgres DB; endpoint/ingestion correctness; statistical bias;
empirical signal analysis; realtime strategy design; agent-architecture decision; free-tooling review.

**Method:** all numbers below come from read-only queries against the **live production database**
(`bharat_intel` @ :5433, 174 public tables) and from backtests run on the real `stock_ohlcv` table.
Nothing here is inferred from code-reading alone. Where a claim is a hypothesis rather than a
measurement, it is labelled **[HYPOTHESIS]**.

---

## 0. Executive summary — the five things that matter

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **1** | **`screener_momentum_score` — the highest-weighted input in the canonical ranker — is computed with look-ahead.** Its weight (`bayesian_score`) is fit on *realized forward returns* and applied to all history. | **Critical** | Code chain traced + backtest anomaly (§4.3) |
| **2** | **The ML feature matrix is 71% empty and 55 days deep.** 216 of 306 `technical_signals` columns are <50% populated; ~150 are at exactly 0%. Training silently runs on ~50 technical columns. | **Critical** | §2.1 |
| **3** | **`signal_outcomes` mixes two incompatible label definitions** in one table with no source column, and contains a +27,399% return. | **Critical** | §2.2 |
| **4** | **Structural survivorship bias**: 2,436 of 2,450 symbols in 5.5y of price history are still trading. Delisted names simply don't exist in the DB. | **High** | §3.1 |
| **5** | **Short-horizon momentum is significantly *negative* in this market** (−0.53%/5d net alpha, IR −1.38, t=−3.21, 272 rebalances). The platform is tilted toward momentum. | **High** | §4.1 |

**The headline conclusion:** the platform's problem is not that it needs more models, more data sources,
or an agent swarm. It is that **the measurement layer is not yet trustworthy enough to tell you whether
anything works.** Every additional engine built on top of the current feature matrix inherits finding #1
and #2. Fix measurement first — it is ~3 weeks of work and it is the highest-return thing available.

---

## 1. Inventory — what's actually in the database

174 public tables · 161 populated · 13 empty.

**Empty tables (13):** `users`, `watchlist`, `price_alerts`, `signal_actions`, `timeframe_scores`,
`backtest_strategies`, `market_holidays`, `gdelt_sentiment`, `mf_sector_allocation`,
`mc_seasonality_best_stocks`, `signal_portfolio_correlation`, `tick_data`, `order_book_snapshots`.

Two of these matter:
- **`market_holidays` is empty** while the scheduler has holiday-aware logic. Holiday detection is
  running on a fallback path with no holiday table behind it.
- **`gdelt_sentiment` is empty** but `ml_ensemble.py` line 1032 `COALESCE`s it as the historical
  fallback for `news_sentiment_score`. The fallback resolves to NULL for every training row.

**Stale tables (>3 days old on their own date column), 24 total.** The ones with ML impact:

| Table | Rows | Last data | Age |
|---|---|---|---|
| `technical_analysis_signals` | 177 | 2026-05-12 | 79d |
| `xgboost_predictions` | 2,210 | 2026-05-20 | 71d |
| `mf_stock_holdings` | 1,046 | 2026-05-31 | 60d |
| `trendlyne_eps_history` | 61,197 | 2026-06-29 | 31d |
| `stock_earnings_beats` | 2,731 | 2026-06-30 | 30d |
| `trendlyne_checklist` | 1,822 | 2026-07-10 | 20d |
| `working_capital_history` | 1,675 | 2026-07-16 | 14d |

**Date-format defect:** `insider_trades.date` is TEXT holding `"22 May, 2026"` — **44,981 of 44,985 rows
are non-ISO**. Every `date >= …` comparison on this table is a lexicographic string compare and is
silently wrong. `insider_buy_pct_90d` has 0.2% coverage as a direct consequence.

---

## 2. The ML feature matrix — the central problem

### 2.1 `technical_signals` is 306 columns wide and 71% empty

Coverage measured on 2026-07-29 (2,198 rows, a normal full trading day):

- **216 of 306 columns below 50% coverage**
- **~150 columns at exactly 0.0%**
- only **73 columns (24%) at ≥95%**

Entire feature families are at zero: all fundamentals (`roe_annual`, `roce_annual`, `ebitda_margin`,
`eps_ttm`, `pe_ttm`, `fcf_yield`, `ev_ebitda`), all ownership (`promoter_pct`, `fii_pct`, `mf_pct`,
`pledge_pct`, `mf_flow_rank`), all analyst (`analyst_count`, `analyst_upside_pct`,
`eps_revision_3m_pct`), all Trendlyne DVM, all MoneyControl deep features, all six
`screener_cat_*`, and **every banking ratio added in the 2026-07-23 harvest session** (`nim`,
`cost_to_income`, `capital_adequacy`, `gross_npa_pct`, …).

**`news_sentiment_score` coverage is 0.5%.** News sentiment is collected (26,528 items) and is
effectively absent from the model.

### 2.2 The mechanism — a 3-day lateral join over a sporadically-written grid

This is not "the fetchers are broken." Tracking coverage across days shows the real pattern:

| Feature | 07-20 | 07-21 | 07-22 | 07-23 | 07-24 | 07-27 | 07-28 | 07-29 | 07-30 |
|---|---|---|---|---|---|---|---|---|---|
| `dvm_momentum` | 0% | 0% | 0% | 0% | **75%** | 0% | 0% | 0% | 0% |
| `eps_ttm` | 0% | 0% | 0% | 0% | **75%** | 0% | 0% | 0% | 0% |
| `mc_cagr_3y` | **96%** | **95%** | **94%** | **93%** | **93%** | 0% | 0% | 0% | **70%** |
| `roce` | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% (best-ever: **74%** on 07-10) |
| `is_nifty50` | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 1.9% | **100%** |

Features are populated on **exactly the day their fetcher ran**, and nowhere else. The daily grid-ensurer
creates a fresh row per symbol per day carrying only the core OHLCV-derived columns; each enrichment
fetcher then UPDATEs only the row matching its own as-of anchor.

`ml_ensemble.py` then reads them with this join (line 1157):

```sql
LEFT JOIN LATERAL (
    SELECT * FROM technical_signals ts2
    WHERE ts2.symbol = so.symbol
      AND ts2.date <= so.signal_date
      AND ts2.date >= (so.signal_date::date - interval '3 days')::text
    ORDER BY ts2.date DESC LIMIT 1
) ts ON TRUE
```

`ORDER BY date DESC LIMIT 1` over a **3-day window**. Because a grid row exists every trading day, this
always lands on the newest — and therefore emptiest — row. A value written on 07-10 is invisible to a
training row dated 07-24. The as-of join is doing the opposite of what's intended: it guarantees the
freshest row rather than the last *non-null* value per column.

**Consequences, in order of severity:**

1. ~150 of the ~200 features `ml_ensemble.py` selects are NULL for essentially the entire training set.
   The reported ensemble AUC is achieved on technicals alone. Every "we added features" session since
   May shipped columns the model has never seen.
2. **Train/serve skew.** Live inference reads *today's* row, which on a fetcher-run day *does* carry
   enrichment (07-30 has `is_nifty50` at 100%, `mc_cagr_3y` at 70%). So the model is served feature
   distributions it never saw in training. This is a textbook cause of the documented
   "CV AUC 0.75 → live AUC ~0.50" gap, and it is a better explanation than any of the CV-splitting
   issues already fixed.
3. Missingness is correlated with **calendar date, not with the stock**. Imputing NULL→0/median makes
   the feature encode "did the job run today," which is pure noise.

### 2.3 Only 55 days of history

`technical_signals` spans **2026-05-16 → 2026-07-30, 55 distinct dates**, and the earliest days carry
only 269–398 rows (full universe ~2,200 is only reached from ~mid-June). `feature_store` is much
healthier — 788,835 rows, **390 dates**, 2,421 symbols — but it holds only the 86 price/technical columns.

**This is the binding constraint on the entire platform.** No strategy that uses screener, fundamental,
ownership or sentiment features can be validated over more than ~2 months of one market regime. That is
not enough to distinguish alpha from luck, and §4 shows exactly that failure in action.

Weekend rows also pollute the grid: 2026-07-25 (Sat) has 22 rows, 07-26 (Sun) 46, 07-18/19 24 and 46.
These are partial junk rows that any "latest row" read can land on.

### 2.4 `signal_outcomes` — two incompatible labels in one table

There is **no `signal_source` column**, so producers are indistinguishable. Reading the implied barriers
straight off the data:

| Horizon | NEUTRAL band | WIN threshold | LOSS threshold | Label family |
|---|---|---|---|---|
| 3, 7, 14, 30 | exactly [−2.00, +2.00] | ≥ +2.00 | ≤ −2.00 | **terminal return, fixed ±2%** |
| 1, 5, 15 | ~[−15, +15] | ≥ +1.00 | ≤ −0.78 | **path-based (MFE/stop)** |

For h1/h5/h15 the NEUTRAL band *overlaps* the WIN and LOSS regions — a +5% row can be either WIN or
NEUTRAL depending on path. These are two different questions being pooled into one training target.
The effect is visible in the class balance: h5 runs WIN:LOSS = 2.5:1 while h7 runs 0.62:1, on the same
universe five vs seven days out. That inversion is not a market phenomenon; it's a definition change.

**Outlier contamination:** `return_pct` reaches **+27,399%** (h1, h5 and h15 all affected), and the
means confirm the damage — h1/h5/h15 have mean returns of +13.4%/+19.3%/+15.2% against medians of
~0.0%, while the terminal-return horizons sit at a sane −0.5%. `is_plausible_return()` exists in the
signals path but is **not applied to `signal_outcomes`**.

### 2.5 `unified_recommendations` — the canonical ranking table is not universe-controlled

Today's run: **3,959 symbols, of which 2,362 are not in the `nse_stocks` master** (which has 2,366 rows).
Sample of the unknown symbols:

```
13510368, 1STCUS, 4THDIM, 4THGEN, 7NR, 7SEASL, 7TEC, A1L, AADIIND, AAKAAR, AARVEEDEN, AASTAFIN
```

`13510368` is a raw numeric ID leaking into the symbol column — the same class of defect as the
2026-07-23 URL-as-symbol corruption, with a different payload. The rest are BSE-only/SME microcaps
arriving via the screener sources.

Two consequences: (a) 60% of ranked names have no sector, market cap or liquidity data and cannot be
risk-controlled; (b) they have no `stock_ohlcv` history, so **backtests silently drop them** — the
backtested universe and the live recommended universe are different populations. Daily counts also
jump from 2,483 (07-23) to 3,697 (07-24), so this widened recently.

---

## 3. Bias audit

### 3.1 Survivorship bias — structural, High severity

Last available bar per symbol across the full 5.5-year `stock_ohlcv` history:

| Bucket | Symbols |
|---|---|
| still trading (≤5 days) | **2,436** |
| stopped ~1 month ago | 9 |
| stopped 1–3 months ago | 4 |
| stopped >12 months ago | **1** |

**99.4% of the universe survives the entire 2021→2026 window.** The real NSE delisted, suspended or
merged well over a hundred names in that period. The cause is structural: `mc_ohlcv_backfill.py`
iterates `SELECT symbol FROM nse_stocks` — the *current* master — and pulls history for each. Anything
that stopped existing before today was never fetched.

Every backtest on this data therefore trades a universe pre-selected on "survived to 2026." Typical
overstatement for an Indian small/mid-cap universe is **+1–4% annualised** — which is larger than most
of the edges the platform is trying to detect.

### 3.2 Price-data integrity — corrupts any mean-based statistic

| Check | Count |
|---|---|
| bars with \|1-day return\| > 20% (NSE circuit limit) | **512** |
| \|1-day return\| > 100% | 62 |
| \|1-day return\| > 500% | 35 |
| max single-day return | **+127,900%** (`RELIANCE`, 2022-06-16, close=1280 vs prior ~1.0) |
| `close` outside `[low, high]` | 65 |
| `open` outside `[low, high]` | 22 |
| zero-volume bars | 19,669 |
| `close <= 0` | 112 |

The most liquid stock in the index has a corrupt bar. The practical impact is severe and easy to
underestimate — on the liquid universe over 2026-05-16→07-30:

```
raw mean 5-day return   =  6.49%     <- what a naive backtest sees
median                  =  0.00%
winsorised (1%,99%)     =  0.65%     <- reality
max                     = 92,074%
```

**A single bar moves the measured market return by an order of magnitude.** `backtester.py`,
`performance_tracker.py` and the IC/decile machinery all consume this table with no winsorisation.
I hit this myself: my first backtest pass reported an 850% annualised "edge" that was entirely this
artifact. Any historical performance number produced by this platform to date should be treated as
unverified until re-run with bad-bar filtering.

### 3.3 Split/dividend adjustment basis — the mitigation isn't live

`adjustment_basis` was added to tag the three ingestion paths. Live state:

```
adjustment_basis = NULL            2,608,191 rows  (99.99%)
adjustment_basis = 'split_dividend'      287 rows
```

The column is tagged going forward only; the 2.6M historical rows are untagged, so the seam remains
undiagnosable in practice. Mixing split-only and split+dividend adjusted series in one column produces
a systematic negative bias in long-window returns for high-dividend names.

### 3.4 News/sentiment bias

- 26,528 items; **6,884 (26%) have no symbol linkage**; only **10,249 (39%) are AI-scored**.
- Class balance: NEUTRAL 13,543 / **BULLISH 9,345 / BEARISH 3,640** — a **2.6:1 bullish skew**.
  Financial newswires genuinely skew positive, but consuming this un-demeaned injects a persistent long
  bias. Sentiment must be cross-sectionally demeaned per day before use.
- Symbols are stored as a JSON blob (`symbols_json`) / text (`symbols`) with no normalised, indexed
  symbol column. Per-symbol as-of news features cannot be computed efficiently, which is the practical
  reason `news_sentiment_score` never made it into the feature matrix.

### 3.5 Look-ahead bias — the critical finding

Traced chain:

```
screener_appearances.return_5d / return_10d / return_20d / outcome_20d   <- REALIZED FORWARD RETURNS
      └─> screener_performance.py  computes bayesian_score per screener
            └─> screener_performance_v2.bayesian_score
                  └─> screener_features_fetcher.py:13
                      "screener_momentum_score -- weighted bull count (weight = bayesian_score)"
                        └─> technical_signals.screener_momentum_score / screener_tier1_count
                              └─> ml_ensemble.py:829  X['screener_momentum']
                              └─> unified_ranker.py   screener block (weight 0.30–0.40 — the LARGEST
                                                      single engine weight in most regimes)
```

`bayesian_score` is a **single current value per screener**, upserted with `last_computed` — not a time
series. So the weight applied to a feature row dated 2026-05-20 embeds knowledge of how that screener
performed through 2026-07-30.

This is a different defect from the CV-splitting leaks already fixed. Those were about how rows are
*split*; this is the **feature value itself being computed with full-sample information**. No purged CV,
embargo or holdout can detect it, because the leak is inside the feature, identical in train and test.

It contaminates: `screener_momentum_score`, `screener_tier1_count`, all `screener_cat_*`,
`ml_ensemble`'s screener block, `exit_policy.py`, and the largest-weighted component of the canonical
ranker. **§4.3 measures its magnitude.**

### 3.6 Biases checked and found acceptable

- **Smearing / frozen backfill** — tested and **negative**. Cross-sectional rank autocorrelation of
  `screener_momentum_score` decays 0.645 (lag 1) → 0.522 (lag 5); within-symbol std 5.46 vs
  cross-sectional 15.0; only 0.3% of symbols constant; `screener_streak_days` advances by exactly 1
  day-over-day for the majority of rows. The feature is genuinely time-varying. (This rules out the
  most common failure mode in this codebase — worth recording as a clean result.)
- **Same-day/close leakage** — tested and **negative**. Rank IC is unchanged between close-to-close
  (0.190) and next-day-open-to-open (0.192) entry, so the signal is not exploiting the decision-day close.

---

## 4. Empirical analysis — what actually predicts returns

Setup: `stock_ohlcv` cleaned (80 symbols containing an impossible bar dropped, bars with
`close`/`open` outside `[low,high]` removed, cross-section winsorised at 1/99 each period), liquid
universe ≥₹1cr 20-day ADVT, **entry at next-day open** (decision on close of *t*, fill at open *t+1*),
non-overlapping rebalances, top-20 equal weight.

**Cost model — Indian cash delivery, round trip ≈ 0.60%:** STT 0.10%×2, brokerage 0.03%×2,
exchange+SEBI+GST ≈0.012%×2, stamp 0.015%, impact/spread 0.15%×2.

### 4.1 Short-horizon momentum is significantly negative

| Window | Signal | Rebalances | Gross | Bench | Turnover | **Net alpha** | IR | t |
|---|---|---|---|---|---|---|---|---|
| 2021-01→2026-07 | `mom21` | 272 | 0.21% | 0.43% | 52% | **−0.53%** | −1.38 | **−3.21** |
| 2021-01→2026-07 | `mom63_skip21` (12-1) | 264 | 0.49% | 0.41% | 37% | −0.14% | −0.41 | −0.94 |

Year by year (`mom21`, net alpha per 5 days): 2021 **+0.27%**, 2022 −0.42%, 2023 −0.72%,
2024 −0.82%, 2025 −0.52%, 2026 −0.76%. **Negative in 5 of 6 years, on 272 independent rebalances.**

Both tails underperform the universe (top-20 −0.38%, bottom-20 −0.49% vs universe): this is the
**lottery/high-volatility discount**, not a directional momentum effect.

**Implication — this contradicts the platform's design.** `REGIME_WEIGHTS`, `relative_strength.py`'s
skip-month momentum, and the momentum-heavy screener weighting all lean into a factor that is
significantly *negative* after costs at this horizon in this market. The tradeable direction here is
**short-horizon reversal plus a low-volatility / quality filter**, not momentum.

### 4.2 Cost drag dominates at weekly turnover

At ~50% turnover per weekly rebalance, cost drag is **0.60% × 0.50 × 50 ≈ 15% annualised**. Nothing in
§4.1 clears that. Every strategy on this platform must be designed around turnover before signal.

### 4.3 The platform's own scores, and the size of the look-ahead

Same construction, restricted to the 55-day window where `technical_signals` exists:

| Signal | Rebalances | Gross | Bench | Turnover | **Net alpha** | t |
|---|---|---|---|---|---|---|
| `screener_momentum_score` | 6 | 4.17% | 0.12% | 48% | **+3.76%** | 2.99 |
| `screener_bull_count` | 6 | 3.82% | 0.12% | 47% | **+3.42%** | 2.93 |
| `cs_score` | 5 | 2.95% | 0.34% | 96% | +2.03% | 1.90 |
| `calibrated_win_probability` | 5 | 0.72% | 0.34% | 87% | −0.14% | −0.38 |
| **`mom21` (control)** | 5 | −0.01% | 0.34% | 85% | **−0.86%** | −2.42 |

Read this carefully. **In the exact same window, with the same construction and costs, plain price
momentum lost 0.86% per 5 days while `screener_momentum_score` made 3.76%.** So the screener result is
*not* a momentum restatement and *not* a friendly-regime artifact — the regime was hostile to momentum.

Combined with §3.5, the parsimonious explanation is the look-ahead: the screener weights know which
screeners worked over the sample. **[HYPOTHESIS — testable, see below.]** +3.76% per 5 days (≈580%
annualised) is not a plausible live edge by any standard; a real cross-sectional equity signal in a
liquid universe lands at 0.05–0.30% per 5 days net.

Note also `calibrated_win_probability` — the platform's flagship ML output — produced **negative net
alpha** even in this contaminated window, at 87% turnover. That is consistent with the documented
live-AUC≈0.50 finding and with §2.2 (it is trained on a mixed label) and §2.1 (on a mostly-empty
feature matrix).

**The decisive test (≈1 day of work):** recompute `bayesian_score` point-in-time — for each date *D*,
fit it using only `screener_appearances` rows whose 20-day outcome resolved strictly before *D* — store
it as a time series, rebuild `screener_momentum_score` from the PIT weights, and re-run the table above.
If net alpha collapses toward zero, finding #1 is confirmed and the ranker's largest weight is invalid.
If it survives, you have a genuine and valuable signal. **Until this test is run, no number produced by
the screener stack should be trusted, and the ranker's 0.30–0.40 screener weight is unsupported.**

---

## 5. Strategy design — what the evidence supports

Design constraints established above: costs 0.60% round trip; shorting realistically limited to the
~190 F&O names; short-horizon momentum negative; both return tails underperform; only 390 days of
trustworthy (price-derived) feature history.

### 5.1 Core strategy — short-horizon reversal with a quality/liquidity gate

The one robust, 272-rebalance result in this dataset is that extreme recent movers underperform.
That is directly tradeable and is the opposite of the current tilt.

```
universe    : ADVT20 >= Rs 5 cr, price > Rs 20, not in ASM/GSM (point-in-time), F&O-eligible preferred
signal      : z(-ret_5d)  +  z(-ret_21d)  +  z(-hv_60d)    [reversal + low-vol; hv_60d IC was -0.072]
gate        : exclude bottom quintile of delivery_pct (weak-hands filter; delivery_pct forward IC +0.063)
              exclude names with |ret_1d| > 15% (event/circuit noise)
construction: top 30 equal-weight, monthly rebalance (NOT weekly — see 4.2)
hedge       : short NIFTY futures at 0.4-0.6 beta -> isolates the cross-sectional effect
sizing      : inverse-vol, 10% single-name cap, 30% sector cap  (already in normalize_position_sizes())
```

Monthly rebalance cuts cost drag from ~15% to ~4% annualised. **Validate before deploying:** run this
on the cleaned 5.5-year `stock_ohlcv` — it needs no `technical_signals` history, so it is the one
strategy you can honestly backtest today.

### 5.2 Event strategy — post-earnings-announcement drift

PEAD is the most robust anomaly in emerging markets and the platform already has the raw inputs
(`stock_earnings_beats`, `eps_surprise_*`, `analyst_estimates_history`, `pead_score`). It is currently
unusable because `stock_earnings_beats` is 30 days stale and `pead_score` has 0% coverage.

PEAD is attractive here specifically because it is **low-turnover and event-driven**, so the 0.60% cost
clears easily on a 20–60 day hold. Fix the plumbing (§6) and this is the highest-expected-value *new*
strategy — but note the publication-lag correction (already applied in `earnings_beat_features.py`) is
essential, and it must be validated on point-in-time estimates only.

### 5.3 News — use as a risk filter, not an alpha source

At 26% unlinked, 39% scored, 2.6:1 bullish skew and 0.5% feature coverage, news sentiment cannot carry
alpha in its current state. Its realistic near-term value is **negative screening**: suppress or
downweight longs with a strong same-day bearish cluster. If used as a factor at all, it must be
cross-sectionally demeaned daily to strip the source bias.

### 5.4 What to stop doing

- **Stop adding engines.** There are already three score producers, six signal tables and ~140
  DB-writing scripts. Each new one inherits §2 and §3.
- **Stop trusting `win_probability` for sizing** until it is retrained on a single label definition and
  a dense feature matrix. It currently has negative measured net alpha (§4.3).
- **Stop momentum-weighting** the ranker until §4.1 is refuted on your own data.

### 5.5 Realtime prediction — the honest position

A genuinely realtime (intraday, sub-15-minute) prediction system is **not** the right next build. The
platform's validated edge at daily frequency is currently zero-to-negative once look-ahead is removed,
and intraday adds an order of magnitude more cost sensitivity (spread + impact dominate), more data
integrity risk, and no measurement infrastructure. Build the daily/weekly cross-sectional system,
prove it out of sample for two quarters, *then* consider shortening the horizon.

---

## 6. Remediation plan, in dependency order

**Phase 1 — make measurement trustworthy (≈3 weeks). Nothing else matters until this is done.**

1. **Point-in-time `bayesian_score`** (§3.5, §4.3). Store as a time series keyed by date; rebuild
   screener features from PIT weights; re-run §4.3. *This is the single highest-priority item.*
2. **Bad-bar quarantine on `stock_ohlcv`.** Reject/flag bars violating `low<=open,close<=high`,
   `close>0`, and |1-day return| > 25% without a corresponding `corporate_actions` split/bonus row.
   Backfill the flag over history and make every consumer filter on it.
3. **Fix the feature join.** Replace the 3-day `LIMIT 1` lateral with per-column LOCF (last non-null
   carried forward) — or better, stop denormalising slow-moving data into the daily grid and as-of join
   each source table at feature-build time (`as_of.py` already does this correctly for
   `fundamentals_history`/`analyst_estimates_history`; extend that pattern).
4. **Split `signal_outcomes`.** Add `label_definition` + `producer` columns; stop pooling path-based and
   terminal-return labels; apply `is_plausible_return()` on write.
5. **Universe control on `unified_recommendations`.** Reject symbols absent from `nse_stocks`; add a
   `symbol ~ '^[A-Z][A-Z0-9&-]{1,19}$'` CHECK.

**Phase 2 — remove structural bias (≈2 weeks).**

6. **Fix survivorship.** Rebuild the historical universe from **NSE daily bhavcopy archives**
   (free, official, 2000→present). Each day's bhavcopy is the point-in-time list of what actually
   traded, including names now delisted. This also gives official delivery data and is a
   more reliable OHLCV source than scraping.
7. **Backfill `adjustment_basis`** over the 2.6M untagged rows, or re-ingest from bhavcopy on a single
   consistent basis.
8. **Normalise news symbol linkage** into an indexed `news_symbol_link(symbol, news_id, published_at)`
   table; demean sentiment cross-sectionally.
9. Fix `insider_trades.date` to ISO; populate `market_holidays`.

**Phase 3 — only now, strategy.** Implement §5.1 on the cleaned data, walk-forward, two-quarter paper
period before any capital.

---

## 7. Architecture — agents, supervisor, or MCP?

**Recommendation: do not build a multi-agent signal-generation system. Keep signal generation
deterministic. Use one narrow LLM agent for unstructured text only.**

### Why a supervisor + specialist agents would make this worse

You proposed market / stock / F&O / news / earnings agents under a supervisor. The reasoning against:

1. **The bottleneck is data correctness, not orchestration.** Every finding in §2–§4 is a data-integrity
   or measurement problem. An agent layer sits *above* that and inherits all of it. Five agents reading
   a 71%-empty feature matrix produce five confidently-wrong opinions instead of one.
2. **Non-determinism destroys backtestability.** You explicitly want backtesting against actual market
   movements. An LLM supervisor weighing five agents' outputs cannot be replayed exactly over 5 years of
   history — so the strategy becomes unfalsifiable. This platform has spent five audit passes *removing*
   sources of non-reproducibility; adding an LLM to the decision path reverses that.
3. **A supervisor combining N opinions is a weighted ensemble with unknown weights.** You already have a
   weighted ensemble with *known, tunable, testable* weights (`unified_ranker.py`'s `REGIME_WEIGHTS` +
   `_blend()`). A deterministic blend is strictly better than an LLM approximating one: it is auditable,
   free to run, and optimisable against realized outcomes.
4. **Cost and latency.** Five agents per symbol × 2,400 symbols × every cycle is enormous inference cost
   for a decision a matrix multiply makes in milliseconds.
5. **Prior evidence from this codebase.** The AI/LLM signal path was already measured at **74% of
   signals with a 2.3% win rate**, and was deliberately demoted to explainer-only behind a quant gate.
   That experiment has been run here and it failed.

### Where LLM agents *do* earn their place

One agent, one job: **unstructured text → bounded structured score.** Earnings-call transcripts,
management commentary, regulatory filings, annual-report MD&A — text with no parser equivalent, where
extraction genuinely needs language understanding.

Constraints that make it safe:
- Output is a **bounded component score** (e.g. `guidance_tone ∈ [−1, 1]`, `capex_intent ∈ {0,1}`) that
  enters `unified_ranker.py` as one more weighted engine — **never a free-floating buy/sell verdict**.
- Score is **persisted with the timestamp of the source document**, so it is point-in-time and
  backtestable.
- It gets the same treatment as any other engine: measured rank IC, a promotion gate, and a weight
  earned from realized outcomes.

### MCP's actual role

MCP is a **tool-access protocol, not an accuracy mechanism** — it changes how a model reaches your data,
not whether the data is right. It will not improve signal quality.

It is genuinely useful for the **research loop**: `src/server/mcpServer.ts` already exists (6 tools,
not wired into any npm script). Making that the interface for ad-hoc analysis — "what's the IC of X",
"show coverage for feature Y" — would have surfaced most of this audit's findings months earlier.
Worth finishing for that purpose. Its `query_stocks_db` arbitrary-SQL tool should become typed
procedures first.

### The architecture that fits the evidence

```
ingestion (deterministic, tested, PIT)
    -> feature store (dense, as-of correct, versioned)         <- Phase 1-2 above
        -> component engines (each: bounded score + measured IC + promotion gate)
            - technical / cross-sectional  (existing)
            - fundamental / earnings       (fix plumbing)
            - flow / ownership             (fix plumbing)
            - LLM text engine              (the ONE new agent)
        -> deterministic regime-weighted blend  (unified_ranker.py — keep)
            -> portfolio construction (vol targeting, sector caps — largely exists)
                -> LLM narrative layer (explains the decision; never makes it)
```

---

## 8. Free/unpaid tooling — what's worth adopting

**Data (the highest-value items — these fix real findings above):**

| Source | Cost | Fixes |
|---|---|---|
| **NSE daily bhavcopy archive** | Free, official | **Survivorship (§3.1)** + adjustment basis (§3.3) + official delivery data. The single most valuable addition. |
| **NSE/BSE corporate actions feed** | Free, official | Validates the split/bonus filter in the bad-bar quarantine (§6.2) |
| **AMFI daily NAV + portfolio disclosures** | Free | Real MF holdings — replaces the 60-day-stale `mf_stock_holdings` |
| **SEBI / BSE filings (XBRL)** | Free | Point-in-time fundamentals with true publication dates — removes the estimated `PERIOD_LAG_DAYS` guess |
| **RBI DBIE** | Free | Macro (rates, CPI, IIP) — currently absent as a regime input |
| **GDELT 2.0** | Free | `gdelt_sentiment` table already exists and is empty; it's the intended historical sentiment fallback |
| `yfinance` / Stooq | Free | Cross-validation second source for bad-bar detection |

**Libraries — worth adding:**
- **`quantstats`** / **`alphalens`** — factor tearsheets, IC decay, turnover, decile analysis. Would
  have made §4 a one-liner. Highest-value library addition.
- **`vectorbt`** (open-source core) or **`bt`** — vectorised backtesting; replaces bespoke loops in
  `backtester.py` and gets cost/slippage modelling for free.
- **`river`** — proper incremental learning with rollback, addressing the documented
  "`online_learner.py` can't reject a bad partial_fit" limitation.
- **`pandas-market-calendars`** — NSE trading calendar; fixes empty `market_holidays` and the entire
  recurring `date.today()` anchor bug class at the root.

**Already optimal, no change needed:** LightGBM/CatBoost (§ gradient boosting is the right model class
for tabular cross-sectional data — a deep-learning upgrade is not warranted at 390 days of history),
Optuna, FinBERT, Ollama, Postgres/TimescaleDB, BullMQ.

**Explicitly not recommended:** a paid data vendor. Nothing in this audit is caused by data
*availability* — it is caused by data *handling*. Buying a feed would not fix a single finding.

---

## 8b. FIX STATUS — 2026-07-31

All Phase-1 and Phase-2 items are implemented and live-verified against the production DB.
Full Python suite: **796 passed, 51 skipped, 0 failed** (36 new regression tests).

### MAJOR CORRECTION to Finding #1 — the leak is real, its magnitude was not

The PIT fix was built, backfilled and used to run the decisive test §4.3 called for. **The
test did not confirm the magnitude claim, and the headline in §0/§3.5/§4.3 was wrong.**

| Variant, same window, same construction | Rebalances | Gross | Bench | Net alpha |
|---|---|---|---|---|
| feature rebuilt with **full-sample** weights | 4 | −0.46% | −0.08% | **−0.94%** |
| feature rebuilt with **point-in-time** weights | 4 | −0.65% | −0.08% | **−1.12%** |

**`corr(full-sample weight, PIT weight) = 0.9946.`** The weights barely move, so the
`bayesian_score` leak cannot account for the +3.76%. My inference in §3.5 — that a traced
leak path of the right *shape* must be the cause of an anomaly of the right *size* — did not
survive being measured. The fix is still correct and shipped (the leak is real, it is simply
small today, and it will grow as weights diverge with more history), but it is not the
explanation.

### What the test found instead — a worse problem

Rebuilding the feature with the **production `compute_features()` function** and comparing
row-by-row against the values actually stored in `technical_signals` for 2026-07-20:

```
corr(stored, rebuilt) = 0.672      exact match = 2.1%
mean stored = 5.33                 mean rebuilt = 1.76      (stored ~3x larger)
```

Meanwhile the *stored* feature yields +4.11% net alpha in the very window where the *rebuilt*
one yields −0.94%. **The stored feature cannot be reproduced from its own source data using
its own formula.** `screener_appearances` is mutated in place (`exited_date` backfilled, rows
replaced), so the state that produced any historical feature value no longer exists.

That is a more serious finding than the original one: the platform's highest-weighted input is
**unverifiable and unreproducible**. Its alpha cannot be attributed to any mechanism, and it
cannot be recomputed for a backtest. Until `screener_appearances` is made append-only /
bitemporal, no screener-derived backtest number means anything — including the +4.11%.

**Recommended next step (not done here, needs a design decision):** make
`screener_appearances` append-only with `(screener_id, symbol, appeared_date, observed_at)`
and derive `exited_date` as a view, so historical state is reconstructible.

### Implemented

| # | Fix | Verification |
|---|---|---|
| 1 | **PIT screener scores.** New `screener_performance_history` + `phase_f_pit()` / `compute_pit_scores()` / `--backfill-pit`; `load_screener_meta(con, as_of)` reads the newest snapshot ≤ as_of, falling back to full-sample only at bootstrap. Wired into `run()`. | 8,239 rows over 6 as-of dates; 9 tests incl. "appending future outcomes must not move a past score" |
| 2 | **Feature-matrix densification.** New `densify_feature_matrix.py` forward-fills sparse enrichment columns across the grid — strictly forward, per symbol, capped at 120 days, never backward; records `enrichment_ffill_age_days`. Model outputs and price columns are excluded so a stale prediction is never fabricated. | +628,100 non-null cells; `roce` 0%→**73.3%**, `dvm_momentum` 0%→**75.5%**, `eps_ttm` 0%→**75.4%**, `mf_flow_rank` 1.9%→**45.3%** on 2026-07-29 |
| 3 | **Feature join window** 3d→7d in `ml_ensemble.py` (both dialect branches) and `backfill_technical_features.py` — 3 days cannot span a holiday+weekend closure, which returned *no* feature row at all. | `tsc`/suite clean |
| 4 | **Bad-bar quarantine.** `stock_ohlcv.is_suspect` + `suspect_reason`; flags OHLC inconsistency, non-positive prices, and >25% 1-day moves with no corporate action within ±3d. `backtester.py` and `performance_tracker.py` now filter on it (`outcome_resolver.py` already did, partially). | **425 bars flagged**; RELIANCE 2022-06-16 correctly `impossible_move` |
| 5 | **Universe control.** `unified_ranker._restrict_to_tradeable_universe()` keeps only symbols in `nse_stocks` *and* priced in the last 30 days. | dropped **2,310** symbols incl. `13510368`, `1STCUS`, `4THDIM`; today's table: **1,566 rows, 0 not-in-master** (was 3,959 / 2,362) |
| 6 | **Label hygiene.** `signal_outcomes.label_definition` (`terminal_pct2` vs `path_barrier`) + `is_suspect`. | 115,163 / 130,297 split; 148 implausible rows flagged; max \|return\| among clean rows now **100.0%** (was 27,399%) |
| 7 | **`adjustment_basis`.** Column DEFAULT pinned to `split_only`, convention documented in a column comment, `ohlcv_adjustment_basis()` resolver added. Deliberately **not** backfilled in place — 21 of 24 chunks are compressed, and decompressing 2.6M rows to write a metadata tag permanently costs the compression. | resolves 2,608,191 `split_only` + 287 `split_dividend` |
| 8 | **`insider_trades.date`** → ISO `date_iso` + index. | 44,985 converted, 0 unparseable, range 2015-07-06..2026-07-28 |
| 9 | **`market_holidays`** populated from observed trading gaps (matched the existing `(date, exchange, description)` shape rather than inventing a second one). | 75 rows, 2021-01-26..2026-04-14 |
| 10 | **`news_symbol_link`** — indexed `(news_id, symbol, published_at, sentiment_score)`, filtered to master symbols so pseudo-tags don't create phantom per-stock features. | 25,936 rows, 2,097 symbols, 0 outside master |
| 11 | **Job wiring.** `densify-feature-matrix` + `data_integrity_repair --bad-bars` added to `ml-daily-ops` after enrichment and before training; registered in `JOB_REGISTRY` as **critical** (silent failure re-sparsifies the matrix with nothing erroring). | `tsc --noEmit` clean |

### Not done, and why

- **Survivorship (§3.1)** — needs the NSE bhavcopy archive ingestion built (a new fetcher plus
  its mandatory `live_datasource` test). Real work, not a patch; it is the top Phase-2 item.
- **`screener_appearances` bitemporality** — see above; needs a schema-design decision.
- **Finding #31 (regime tilts)** — still requires data that does not exist yet.
- **`mc_cagr_3y` / `nim` and similar still at 0%** — correctly *not* fixed by densify: they have
  no non-null value anywhere in the 55-day window to carry forward. That is a fetcher-cadence
  problem, not a join problem, and it is the next thing to chase.

## 8c. FIX STATUS ROUND 2 — the previously-open items, 2026-07-31

Suite: **814 passed, 63 skipped, 0 failed** (+18 unit, +12 live-datasource tests).

### Survivorship — SOLVED at source, and it is far worse than §3.1 estimated

Probed NSE's archives live rather than assuming. Two endpoints exist; only one is usable:

| Endpoint | Depth | Verdict |
|---|---|---|
| `sec_bhavdata_full_DDMMYYYY.csv` | **2021-01-04 → today**, consistent schema | **use this** — covers the whole `stock_ohlcv` span |
| `BhavCopy_NSE_CM_*` (UDiFF) | 2024-04 → today, 404 before | too shallow |
| `cm{DD}{MON}{YYYY}bhav.csv.zip` (legacy) | 404 | discontinued |

New **`nse_bhavcopy_fetcher.py`** → `nse_universe_history`. Each file is the exchange's own
record of what actually traded that day, so a name that vanished in 2022 is present in 2022's
file and absent from 2023's — the point-in-time universe, by construction. It also carries
`DELIV_QTY`/`DELIV_PER`, so official delivery data comes free.

**Full daily backfill complete: 1,442 trading days, 3,389,444 rows, 2021-01-01 → 2026-07-30.**

**CORRECTION — I twice reported "37.6% of the traded universe is missing, systematically the
ones that died". That headline was wrong, and decomposing it is what showed why:**

```
4,033 distinct securities traded 2021-2026
1,622 absent from stock_ohlcv                     = 40.2%   <- the raw number I quoted
  of which:
    1,199  SME series (SM/ST)          -- a different board, arguably out of universe
      384  STILL TRADING (GOLDBEES, BANKBEES, CPSEETF, ...)  -- ETFs, not equities
      234  rights entitlements (-RE/-RE1/-RE2)   -- expire by design, never "died"
      367  genuinely stopped trading
         of which  61  look like ETFs (UTINIFTETF, GOLDSHARE, AXISBPSETF, ...)
                  306  real mainboard companies    <- the actual survivorship casualties
```

**The honest figure is ~306 companies (7.6% of the universe), not 40%** — and even that
includes ticker changes and demergers rather than pure failures: `TATAMOTORS` appears in the
list because of the 2025 demerger, not because it went under. Genuine casualties include
`MEGASOFT`, `INFIBEAM`, `SEQUENT`, `JCHAC`, `CREATIVE`, `SMSLIFE`, `MANGCHEFER`, `DHANI`.

That is still a real bias worth fixing — a backtest that never sees ~300 companies that
traded for years and then stopped is measurably optimistic — but it is roughly a fifth of the
size I first claimed, and the fetcher is justified on those grounds rather than the headline.
**Method note: I quoted the raw missing-count twice before decomposing it by series and
liveness. The decomposition took one query.**

Wired into `ml-daily-ops` before the quality/feature steps and registered **critical** in
`JOB_REGISTRY` — every missed day is a day whose delisted names are lost for good.
Mandatory `live_datasource` test added (12 tests, all passing against the real endpoint):
real-day fetch → own parser → own DB writer → ML-usability assertions, plus idempotent
upsert, equity-series filtering, and the weekend-404-is-not-an-error path.

### `screener_appearances` reproducibility — closed going forward

I could not isolate why a historical rebuild diverges from the stored feature, and two
plausible mechanisms were **tested and refuted**:

- *"`INSERT OR IGNORE` collapses repeat episodes"* — **wrong**, the PK is already
  `(screener_id, symbol, appeared_date)`, so re-entries do create new rows (565,786 rows vs
  308,253 distinct pairs).
- *"the 3-day window double-counts continuously-present symbols"* — **wrong**, measured
  42,629 rows vs 42,280 distinct pairs in the window: 0.8% duplication, nowhere near the 3×
  gap.

Rather than invent a third mechanism, **`screener_features_fetcher.py` now writes
`screener_membership_snapshot`** — the exact `(as_of_date, symbol, screener_id)` set used to
build that day's features, immutably, *before* computing from it. Reproducibility is now true
by construction regardless of how `screener_appearances` mutates. Live: 22,131 memberships
snapshotted for 2026-07-31, alongside **1,375/1,632 screeners now on point-in-time weights**.

Historical values before 2026-07-31 remain unverifiable. That is a permanent gap, and
screener-derived backtests over that period should still be treated as unattributable.

### `nim` / `mc_cagr_3y` at 0% — diagnosed, not the same problem

- **`nim` and every banking ratio**: not a bug. `financial_ratios_fetcher.py` is gated to the
  **first Sunday of the month**; its last full-universe run was **2026-07-11**, and the
  banking harvest shipped **2026-07-23**. So 1,969 of 1,978 rows simply predate the feature —
  only the 2 manual test rows from that session had it. Live-probed the API first to confirm
  it was not a parsing failure: HDFCBANK `nim=2.94`, ICICIBANK `3.71`, SBIN `2.27`,
  KOTAKBANK `3.83`, AXISBANK `2.97`, RELIANCE `NonBank/None`. Triggered a full-universe run;
  banking ratios are landing (16 `nim` / 14 `capital_adequacy` in the first 688 stocks, ≈ the
  expected bank share). **Lesson: adding a column to a monthly fetcher means up to a month of
  total absence, and densify cannot help because there is no prior value to carry.**
- **`mc_cagr_3y`**: writes only onto the current day's row (the `MAX(date)` anchor), so it is
  present on 07-30 (1,538 rows) and absent before. Forward-fill cannot reach backwards, so
  history stays empty — but from now on each day carries forward correctly. Working as
  designed; the historical gap is permanent and not worth re-fetching.

### One conflict found and resolved

`data_integrity_repair.py --bad-bars` was originally scheduled in `ml-daily-ops`. That would
have been **silently wiped**: `ohlcv_quality.py` (which runs earlier in the same chain) does
`UPDATE stock_ohlcv SET is_suspect=0` at the top of every run. The audit's extra checks were
merged into a new `ohlcv_quality.flag_malformed_bars()` instead — the file that owns the flag
and its reset — and the queue step was removed. Live-verified through a full reset+reflag
cycle: 297 bars flagged, RELIANCE 2022-06-16 still caught, and **0 malformed bars left
unflagged**. `data_integrity_repair.py --bad-bars` remains a stricter manual sweep; its >25%
move threshold was deliberately *not* pushed into the daily path, since `ohlcv_quality`
already has a corporate-action-aware threshold someone calibrated.

### Still open

- **Merging `nse_universe_history` into the backtest path** — the table now exists and is
  survivorship-free, but `backtester.py` still reads `stock_ohlcv`. Wiring it in is the next
  step and needs a decision on whether to union the two or migrate outright.
- **Pre-2026-07-31 screener feature values** — permanently unverifiable (above).
- **Finding #31 (regime tilts)** — still needs data that does not exist yet.

## 9. Corrections to my own analysis (recorded for future sessions)

- My first backtest pass reported a **+4.86% gross / 850% annualised** result for
  `screener_momentum_score` and an **8.55% per-5-day benchmark**. Both were artifacts of the corrupt
  bars in §3.2 propagating through a naive `mean()`. The corrected, winsorised, bad-symbol-filtered
  numbers are in §4.3. **Lesson: never compute a mean on this price table without winsorisation.**
- My initial hypothesis that unresolved recent outcomes were being mislabelled NEUTRAL instead of
  PENDING was **wrong** — the resolver does use PENDING correctly at h5/h15 (verified: 9 PENDING rows
  for 2026-07-27 at both horizons). The real label defect is the mixed definition in §2.4.
- The screener-feature "smear" hypothesis was **tested and refuted** (§3.6) before the
  `bayesian_score` mechanism was found in §3.5. Recording both so a future session doesn't
  re-run the smear test.
- **My survivorship magnitude was wrong twice** — see the correction in §8c. I quoted a raw
  "40% of the universe is missing" figure from a single query, and repeated it, before
  decomposing it by series and liveness. Once decomposed, ~75% of the gap is SME-board names,
  still-trading ETFs and rights entitlements that were never part of an equity universe; the
  real casualty count is ~306 companies (7.6%). **Same failure mode as the §8b correction: a
  number of the right shape, reported before the counterfactual/decomposition was run.**
- **My §3.5/§4.3 attribution was wrong** — see §8b. I traced a leak path of the right *shape*
  and attributed an anomaly of the right *size* to it without measuring the link. Measured,
  the PIT and full-sample weights correlate 0.9946 and the leak explains essentially none of
  the alpha. **Lesson: a mechanism that could explain an anomaly is a hypothesis, not a
  finding, until the counterfactual is actually run.** The genuinely load-bearing discovery
  only appeared *because* the fix was built and tested: the stored feature cannot be
  reproduced from its own source at all (corr 0.672, 2.1% exact match), because
  `screener_appearances` is mutated in place.
