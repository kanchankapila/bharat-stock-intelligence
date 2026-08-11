# Measurement Discipline

> ## ⚠ 2026-08-11: `factor_backtest.py` had a bug that invalidated the factor table below
>
> Exits were priced from the **eligible-only** slice, but `eligible` is `adt20 >= Rs 1cr AND
> next_open exists` — a *liquidity screen, not a survival test*. Any name whose 20-day turnover
> dipped under the floor for one session looked unexitable and took `MISSING_EXIT_PCT = -100%`,
> a total write-off, in **both** the portfolio and the benchmark. **0.618% of the eligible
> universe drops out per session**, so the benchmark carried a −0.618%/day phantom drag: the
> harness reported the universe at **−4.66%/month (−99.9% over 5.5 years) for a market that
> roughly tripled**. Arithmetic reconstruction: true universe +0.1072%/day − 0.618% = −0.511%/day
> vs the −0.5177%/day reported.
>
> It did **not** cancel out of the excess figures, because the drag scales with how much a
> factor tilts toward names that lose liquidity. Fixed (`index_exit_prices()`); universe now
> reads **+1.29%/month**. Re-measured, 26 factors, monthly rebalance, top-50, 25bps:
>
> | factor | was (buggy) | now | verdict |
> |---|---|---|---|
> | `value_book_to_price` | +0.93%/mo, **t=2.67** | +0.78%/mo, **t=1.99** | **no longer significant** |
> | `momentum_12_1` | +0.86%/mo, **t=2.08** | +0.53%/mo, **t=1.10** | **no longer significant** |
> | `insider_net` | −0.00%, t=−0.01 (clean null) | +0.48%/mo, **t=+2.05** | only positive one, and it fails multiple testing |
>
> **Exactly 1 of 26 factors is positive and significant, and t=2.05 does not clear the ~t=3.0
> a 26-factor Bonferroni needs.** The correct current statement is: *no factor in this harness
> has a credible positive edge.* The negative results are broadly unchanged and remain the
> reliable part (high_vol t=−6.09, reversal_21d −3.77, screener_oversold −3.50, oversold/
> near-52w-low/below-lower-BB all significantly negative).
>
> Everything below this banner predates the fix. Treat any *positive* claim in it as void until
> re-run; the negative ones held up. Residual caveat on the fix itself: exiting a name that fell
> under the liquidity floor is now modelled at the normal 25bps, which understates real slippage
> for those names — better than a −100% write-off, still not exact.


Read before quoting, comparing, or acting on any accuracy, win-rate, IC, or backtest number.

## Accuracy comes from realized returns, never a proxy

- **Accuracy and win-rate must always be computed from actual realized returns vs. the actual system-generated signal — never from a proxy metric (a job's "success" status, a promotion gate's CV/AUC number, a model's self-reported test score).** This project's own incident history is full of proxies that looked fine while the real outcome was wrong — a leak-inflated CV score blocking honest retrains forever, a "success" heartbeat on a step that silently wrote nothing, `unified_recommendations` classifying `Sell` on a stock that then rallied 15%+. The only check that catches this class of bug is joining the signal table (`unified_recommendations`/`unified_signals`/`intraday_recommendations`) against what the underlying instrument actually did afterward (`stock_ohlcv`/`intraday_ohlcv`, or the already-graded `signal_outcomes`/`intraday_recommendation_outcomes` tables) and computing win rate as `WIN / (WIN + LOSS)` — decisive outcomes only, NEUTRAL/PENDING excluded — plus average realized return, not a single blended percentage. **Before trusting or comparing any win-rate number, check its `label_definition`** — this table has at least two structurally different label conventions in production right now (`signal_outcomes.label_definition`: `terminal_pct2`, a strict fixed ±2% terminal-return barrier, vs `path_barrier`, a path-based max-favorable-excursion rule) and they are NOT comparable: live-measured 2026-08-06, `technical`-sourced h5/h15 outcomes (path_barrier) showed an 88–91% win rate while `confluence`-sourced h7/h14 outcomes (terminal_pct2, the exact same calendar window) showed 41–44% — the gap is almost entirely the label definition, not real skill. See [[topgainers_reverse_engineering_practice]] for the full methodology this rule is extracted from.

## Reverse-engineer against what actually happened

- **Always take a reverse-engineering approach to validate the correctness of logic, models, and code — not a code-only review.** Trace the claim against what actually happened: pull real top gainers/losers from `stock_ohlcv` and check whether the system's own pre-move signal called it correctly (see [[topgainers_reverse_engineering_practice]]); for a model, grade its stored predictions against realized outcomes rather than trusting its own reported CV/test metric; for a fix, re-run the affected code path against live production data and query the result back, rather than stopping at `tsc --noEmit`/a green test suite. This project has repeatedly found real, currently-active bugs this way that a code-only review missed entirely — e.g. the 2026-08-06 session that found `unified_ranker`'s RL gate had silently excluded 825 symbols platform-wide (43% of them on fewer than 5 historical samples) purely by tracing one specific symbol's absence through the live pipeline step by step, something no amount of reading `unified_ranker.py` in isolation would have surfaced. A plausible-sounding lead from code-reading alone (e.g. "market_cap is NULL for this symbol, that's probably it") is a hypothesis, not a finding, until it's actually traced end to end against live data — the same session's own first-pass KECL lead turned out to be entirely wrong once traced properly.

## Screeners are DESCRIPTIVE, not predictive - and the intraday version does not cover costs

- **The gainer/loser-type screeners describe a move that already happened on the day they name.** Measured 2026-08-11, per-date excess vs the same-day universe: **same day (prev-close to close) +0.500pp, t=+12.70**, and for `technical_momentum` screeners **+0.990pp, t=+9.24**. The next session is nothing: **+0.003pp, t=+0.13** overall and **-0.106pp, t=-2.03** for momentum screeners. A screener names the stock *because* it moved, so the same-day figure is the cause of the listing, not a return anyone could have captured.
- **This is why the forward test above is the right one and its answer stands.** "Does yesterday's gainer keep going" is the only tradeable question a daily screener snapshot can answer, and the answer is no.
- **CORRECTION (same day): the intraday version IS testable, via a different table.** `live_screener_appearances` + `live_screener_runs` carry **5.85M rows across 601 runs / 32 days**, captured every 15 min during the session by `QUEUE_LIVE_SCREENER_COLLECT` (`*/15 3-10 * * 1-5` UTC), and every row joins to a run timestamp. 42 live filters include exactly the setups in question (`todayGapUP`, `todayGapDown`, `lowerHighLowerLow`, `orb5minHigh`, `todayStockOpenLow`...). Measured: enter at the OPEN of the first 15-min bar **strictly after** the capture, exit at that day's close, excess vs the equal-weighted liquid universe over the same window. **Result: nothing tradeable.** Cell-weighted (per date+capture-time, then averaged) 15 filters clear Bonferroni, all positive, best `todayBelow20SMA` +0.069pp (t=+7.68) and `roce70To100` +0.132pp (t=+5.60) — but **row-weighted the same data gives −0.019pp with only 11 of 42 positive**, i.e. the sign flips with weighting, and every magnitude (2–13 bps) is below the ~15bps intraday round-trip this repo has already measured (`best net at 15bps = −0.004%`). A result that is not robust to weighting and does not cover costs is not an edge. **The mean-reversion direction is consistent though**: the `todayBelow*SMA` family is the top of the table and `todayGapDown`/`yesterdayGapDown` both clear, while `todayGapUP` and `yesterdayGapUP` do not — same sign as the daily Gap-Down-beats-Gap-Up result.
- **The DAILY-snapshot version still cannot be tested,** and that is a different table: The genuinely open version - enter at the moment of flagging, exit at that day's close - CANNOT be tested with current data.** `screener_appearances.appeared_date` is `TIMESTAMPTZ` but every row is written at `00:00:00`: exactly one distinct time across 720,824 rows. The capture time is never recorded. `intraday_ohlcv` is ready for it (15-minute bars, 2,353 symbols, **215 days**), so the price side is not the blocker.
- **Fixing it needs a new column, not a change to the existing one**: `appeared_date` is part of the primary key `(screener_id, symbol, appeared_date)`, so putting a real time in it would stop a repeat appearance from deduping. Add `appeared_at TIMESTAMPTZ` alongside, written by the three sync files (`etnowScreenerSync.ts`, `moneycontrolScreener.ts`, `etMarketstatsSync.ts`). Until that exists, treat any "intraday screener edge" claim as unmeasured rather than disproven.

## No individual screener gives clear direction (measured 2026-08-11, do not re-run without a reason)

- **552 screeners cleared the sample bar (≥10 dates, ≥5 liquid members/date) at 1d; 51 were nominally significant at p<0.05 against 28 expected by chance, and ZERO survived Benjamini-Hochberg FDR or Bonferroni.** At 5d two survived nominally — `moneycontrol/371 "Downward Momentum"` and `moneycontrol/178 "Ben Graham Undervalued"` — but 5d returns on consecutive dates overlap 80%, and once Newey-West corrected their t-stats fall to −3.70 and −3.35 against the ~4.2 Bonferroni needs. **Neither is established.** If you test screeners again, the overlap correction is not optional: the uncorrected t-stat is inflated by roughly √5.
- **The population has clear direction, and it is negative.** Mean per-screener 1d excess **−0.0596pp (t=−6.46, n=552)**; 3 of the 4 sources are individually significant (et_marketstats −0.19/t=−4.73, trendlyne −0.048/t=−4.51, etnow −0.076/t=−2.51; moneycontrol insignificant). Appearing on a screener is, on average, a mildly *bad* sign.
- **The sentiment labels are significantly INVERTED.** Bullish-labelled screeners return **−0.1204pp (t=−6.62)**; bearish-labelled are indistinguishable from zero (−0.0138, t=−0.96). **bullish minus bearish = −0.1066pp, t=−4.61, p<0.001** — a working label system needs that difference significantly *positive*. Mechanism, not mystery: `screener_master.classified_by` is `'keyword'` for **all 1,669** rows, so sentiment is pattern-matched off the screener's *name* and has never been validated against an outcome.
- **Two categories survive Bonferroni across the 10 tested, both negative**: `technical` (−0.042/t=−3.38 at 1d) and `technical_momentum` (−0.136/t=−3.21 at 1d, **−0.673/t=−3.29 at 5d** — the most negative category found). This is the same short-horizon-momentum-is-negative result the factor panel and the Gap-Up/breakout setups both give. Nothing with a positive sign reached significance.
- **`screener_master.tier` is degenerate and cannot prioritise anything**: 1,527 of 1,669 rows are `D`, 112 `Unranked`, 29 `C`, **1 `B`, and no `A` at all**. Every screener that met the sample bar was tier D.

## What data is actually testable (audited 2026-08-11)

- **Of 60 symbol+date tables, only 9 have enough history to test anything; 35 cannot be tested at all.** The calendar constraint this file already recorded for fundamentals/analyst/ownership is far wider than four categories — 35 tables start at ~2026-06-30 and have under 40 distinct dates. No amount of modelling fixes that; only elapsed time or a backfill does. Do not spend a day "testing" any of them.
- **The deep data, ranked**: `trendlyne_pb_history` and `trendlyne_pe_history` (**3,028 dates, 12.6 years, ~4.1M rows each, ~2,420 symbols**) are by far the deepest factor data on the platform and they underpin the one provisional positive factor, `value_book_to_price`. Then `insider_trades` (1,635 dates / 11y, already measured null), `stock_ohlcv` (1,394 / 5.6y), `nse_universe_history` (1,387 / 5.6y), `macro_asset_prices` (1,242 / 4.7y, 81 assets, **never factor-tested**), `feature_store` (398 dates / 19 months, 2,424 symbols, a ready-made technical panel, **never factor-tested**), `stock_delivery_data` (286 dates / 14 months), `news_symbol_link` (188 dates but sparse over 15y).
> **2026-08-12 follow-up: the "still not wired into anything" caveat below resolved to "and it should not be."**
> The turnover-aware run this paragraph asks for was done. Long-only top-50, survivorship-free:
> **21d/25bps net excess −1.04%/period (t=−1.48), 5d/15bps −0.15%/period (t=−1.48)**, 2/6 and 1/6
> years positive. Not a cost story — **gross/period 0.77% is already below the universe's 1.43%**.
> A quintile *spread* and a long-only *top slice* are different constructions: high delivery picks
> the calm names (as the both-tails result below says outright), and a low-vol tilt lags a universe
> compounding at 18–21%. **Anything consuming `delivery_pct` long-only — including the 9th ranker
> engine drafted 2026-08-12 — is unsupported by this data.** The two-tail directional result below
> still stands; it just is not harvestable this way.

- **`stock_delivery_data` is the one that settled an open question.** The 2026-08-11 reverse audit flagged `delivery_pct` as a lead on 25 dates of `technical_signals`; this table carries **275 usable dates**. Result: direction AUC 0.541 at 1d (t=+8.85) and 0.546 at 5d (t=+10.99), top-minus-bottom quintile **+0.1917pp/day (t=+7.82)** and **+0.4812pp/5d (t=+9.94)**. It passes the both-tails test in the strongest possible form: AUC vs the winning tail 0.444 and vs the losing tail 0.403 are **both below 0.5** (high-delivery names avoid both tails — they are the calm ones) while the gainer-vs-loser AUC is above 0.5. That combination is a genuine directional signal, not a volatility proxy. The 1d figure uses non-overlapping windows so it needs no HAC correction. **Still not wired into anything**: +0.19pp/day gross against ~15bps round-trip costs makes a daily rebalance marginal, and the 5d construction has a fifth of the turnover — run it through `factor_backtest.py` (turnover-aware, survivorship-free) before acting. Caveat: 88% of the table was backfilled, so `updated_at` cannot prove point-in-time availability for historical rows; the live path writes trade-date D after the 15:30 IST close, which is tradeable at D+1's open.
- **Two data defects found while auditing**: `stock_delivery_data.trades` is a byte-for-byte duplicate of `delivery_qty` in **100% of 664,006 rows** (the trade-count column is fed delivery quantity), and `mc_earnings_forecast`'s date column holds non-ISO values like `'Mar 2024'` so it will not cast to a date at all.

## Grade every candidate factor against BOTH tails

- **An AUC computed only against winners cannot tell "predicts winners" from "predicts volatility", and this codebase has been fooled by that exact statistic twice.** `flyer_classifier` (AUC 0.81, IC −0.041) was the first. The second: measured 2026-08-11, ~40 features across all six factor groups, the apparent winners for next-session top-50 gainers *all* predicted the top-50 losers at least as well — `hv_20d` 0.679 gainers vs **0.704 losers**, `breakout_probability` 0.670 vs **0.705**, `bb_width` 0.632 vs **0.662**, `rs_vs_sector_21d` 0.573 vs **0.628**, `rsi` 0.556 vs **0.611**. Direction AUC (gainers vs losers, which isolates sign from magnitude) came out **below 0.5 for every one**, several significantly (t=−2.3 to −3.8). These features carry *magnitude, not sign* — re-weighting them cannot help, and a one-tailed AUC will keep saying they can. Always report three numbers: AUC vs the winning tail, AUC vs the losing tail, and AUC of one tail against the other.
- **The common bullish setups are inverted at 1-day.** Next-day open→close excess vs universe, per-date: **Gap Up ≥2% −0.465pp (t=−8.80)** — the most significantly negative thing measured here — Breakout>20d-high −0.185pp (t=−2.69), volume shocker ≥3× −0.122pp (t=−1.67), while **Gap Down ≤−2% is +0.329pp (t=+3.70)**. Open=Low/Open=High are null. Before building anything on a continuation screen, check its sign on this data.

## `factor_backtest.py`'s benchmark is WRONG at `--rebalance 1`. Do not use daily rebalance.

Measured 2026-08-12. The `universe_annualised_pct` a run reports should be almost invariant to
`--rebalance`: it is the same equal-weighted universe over the same window. It is not.

| factor | universe @ `--rebalance 1` | universe @ `--rebalance 5` |
|---|---|---|
| `delivery_pct` | **−16.77%/yr** | +21.26%/yr |
| `low_vol` | **−16.74%/yr** | +21.75%/yr |
| `momentum_12_1` | **−28.01%/yr** | +13.35%/yr |

The 1d figures are **factor-independent** (−16.77 vs −16.74 for two unrelated factors, as a
universe number should be) — so this is the benchmark computation, not the factors. It is the
same class as the exit-pricing bug in this file's banner: a small per-session phantom drag that
is diluted at 21d, survives at 5d, and **dominates and flips the sign at 1d**.

**The `benchmark_sane` guard does not catch it.** That guard is an absolute band,
`-40.0 <= uni_annual <= 80.0` (`factor_backtest.py`), and −16.7%/−28.0% sit comfortably inside
it, so a verdict is issued as though nothing were wrong. The band was sized against the old
−99.9% failure and is far too wide for this one.

**Consequences, until this is fixed:**
- Treat any `factor_backtest.py` result at `--rebalance 1` as **void**, not as evidence. Every
  net/excess/t-stat in such a run is measured against a benchmark that is wrong by ~35pp/yr.
- The 5d and 21d results in this file are unaffected — their universe figures (+13% to +22%)
  are plausible for the window and agree with each other.
- The right fix is not a tighter band. Compare the rebalance-chained universe against a
  **buy-and-hold** universe computed over the same window from the price panel: they should
  agree to within costs, and that invariant holds at every rebalance frequency. An absolute
  band can only ever catch the catastrophic case.

## The panel spec (use this exact recipe, every time)

Any cross-sectional forward-return measurement on this data:

- **Per-date, then average. Never pooled.** Pooling has flipped or inflated a conclusion three separate times here (`cs_ranker._mean_daily_ic`, the screener-direction measurement, the RL-gate counterfactual — a pooled +0.798% became a per-date +0.098%, t=1.22). If a dramatic pooled number disagrees with per-date numbers, the pooled number is wrong.
- **Winsorise.** Raw means on `stock_ohlcv` are void: a +127,900% RELIANCE bar once produced an 850%-annualised phantom edge. Raw mean 5d return 6.49% vs 0.00% median vs 0.65% winsorised.
- **Filter `is_suspect = 1`.** ~425 quarantined bars; `ohlcv_quality.py` owns the flag.
- **Liquidity floor ≥ ₹1cr ADT.** Without it you are measuring microcaps you cannot trade.
- **Next-day OPEN entry.** Signals computed off a close cannot be bought at that close.
- **Check `label_definition` before comparing any two win rates.** `terminal_pct2` (fixed ±2% terminal) and `path_barrier` (path-based MFE) are not comparable — same calendar window, 41–44% vs 88–91%, and the gap is almost entirely the label.
- **Check `signal_source` before joining `signal_outcomes`.** Three writers share that table.
- **Decompose a "% of rows affected" figure by liquidity before believing it.** A defect reading 42% of rows read ~100% of the *tradeable* slice.

## Known state of the edge (as measured, not assumed)

`unified_score` 5d rank IC ≈ 0.0001 (t=0.02). Short-horizon momentum is negative at three horizons. Bullish screener consensus is significantly negative (t=−2.36). `insider_net`, `delivery_spike`, `ticket_size` are null-to-negative. `momentum_12_1` (+0.86%/mo, t=2.08) is the only positive factor and does not clear a multiple-testing bar across 18 factors tested.

**Consequence: reweighting the existing engines is not a fix.** ~~A new factor must beat `momentum_12_1` *alone*~~ (**void — see the banner: `momentum_12_1` is t=1.10 after the exit-pricing fix, so there is no incumbent to beat; the bar is now simply significance after multiple testing**) — combining reduced performance in every case tested (12-1 alone +0.86% vs +2 exclusions −1.25%; long-only +0.86% vs long/short +0.49%; the 8-engine blend at IC 0.0001).

## Already tested — do not re-run without a reason

Each of these was measured on the 5-year price panel with the spec above. Re-testing them costs days and returns the same answer. If you think one deserves another look, state what changed (more history, a different horizon, a different construction) before spending the time.

| Factor | Result | Verdict |
|---|---|---|
| `momentum_12_1` | +0.86%/mo, t=2.08 | **only positive** — does not clear Bonferroni across 18 factors |
| `value_book_to_price` | +0.93%/mo, t=2.67 | provisional — vendor history may be retrospectively restated |
| `momentum_21d` / `63d` / `reversal_21d` | negative, t up to −3.96 | dead |
| `high_vol` / `low_vol` | both negative (−1.21, −1.66) | **both tails lose**; the middle outperforms |
| `insider_net` | −0.00%, t=−0.01 | clean null across 6 separate years |
| `delivery_spike` / `delivery_trend` | t=−1.08 / −1.43 | dead |
| **`delivery_pct` (raw level, NOT the derived spike/trend above)** | quintile spread +0.19pp/day, t=+7.82 — but **long-only top-50 net excess −1.04%/period at 21d/25bps and −0.15%/period at 5d/15bps, t=−1.48 both** (measured 2026-08-12) | **dead as a long-only factor.** The cost-verification this row used to ask for was run and it failed |
| `ticket_size` (institutional proxy) | −0.67%, t=−2.36 | significantly **inverted** |
| screener bullish consensus | IC −0.027, t=−2.36 | significantly negative; cleaning the labels made it *more* negative |
| **every individual screener** (1,563, one at a time) | **0 survive FDR or Bonferroni** | measured 2026-08-11 — see the screener block below before re-running this |
| news sentiment | same-day +0.13 IC, next-day −0.03 | real but not tradeable — the move is over by the first entry you can take |
| `near_52w_high`, `low_beta`, `low_idio_vol` | insignificant | US-published factors that did not transfer |
| `low_max_ret` (lottery demand) | t=−3.12 | significantly **inverted** vs the published result |
| intraday (23 days, 256 configs) | best net at 15bps = −0.004% | edge exists in sign, smaller than costs |

**Combining made it worse in every case tested.** 12-1 alone +0.86% vs the same factor with two exclusions −1.25%. Long-only +0.86% vs long/short +0.49%. The 8-engine blend at IC 0.0001. A new factor must beat `momentum_12_1` **alone**, not add to it.

**Fundamentals, analyst, ownership and earnings factors cannot currently be tested at all** — every one of those tables has ~30 distinct dates, all starting 2026-06-30, i.e. 1–2 independent quarterly observations. This is a calendar constraint, not an engineering one. Do not "test" them; you will be fitting noise.
