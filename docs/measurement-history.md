# Measurement Investigation History

Full narrative and derivation detail behind the rules and verdicts in
`.claude/rules/measurement.md`. That file is what to read before doing a measurement task;
this one is what to read when you need to know *how* a verdict was reached — the same
split `docs/session-log.md` already gets relative to `CLAUDE.md`. Split out 2026-08-12
purely for length (measurement.md had grown to 32KB, mixing rules with investigation
narrative); no content was changed or dropped in the split.

## `factor_backtest.py`'s exit-pricing bug (2026-08-11, fixed 2026-08-12) — full diagnosis

> ## ⚠ `factor_backtest.py` had a bug that invalidated the factor table
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
> read **+1.29%/month**. Re-measured, 26 factors, monthly rebalance, top-50, 25bps:
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
> Residual caveat on the fix itself: exiting a name that fell under the liquidity floor is now
> modelled at the normal 25bps, which understates real slippage for those names — better than a
> −100% write-off, still not exact.

### The `--rebalance 1` benchmark bug — same class, found and fixed the same week

Measured 2026-08-12. The `universe_annualised_pct` a run reports should be almost invariant to
`--rebalance`: it is the same equal-weighted universe over the same window. It was not.

| factor | universe @ `--rebalance 1` | universe @ `--rebalance 5` |
|---|---|---|
| `delivery_pct` | **−16.77%/yr** | +21.26%/yr |
| `low_vol` | **−16.74%/yr** | +21.75%/yr |
| `momentum_12_1` | **−28.01%/yr** | +13.35%/yr |

The 1d figures were **factor-independent** (−16.77 vs −16.74 for two unrelated factors, as a
universe number should be) — so this was the benchmark computation, not the factors. Same class
as the exit-pricing bug above: a small per-session phantom drag, diluted at 21d, surviving at 5d,
dominating and flipping the sign at 1d. The `benchmark_sane` guard (`-40.0 <= uni_annual <= 80.0`)
didn't catch it — −16.7%/−28.0% sit comfortably inside that band, sized against the old −99.9%
failure and far too wide for this one.

**RESOLVED 2026-08-12. Daily rebalance is usable again.** Root cause was in `run_backtest`'s exit
accounting, not the `benchmark_sane` band: `uni = (...).fillna(missing_exit_pct)` wrote off at
**−100%** any eligible name lacking an exit bar on that exact date, conflating "no bar on this one
date" with "delisted". `index_exit_prices()`'s docstring already declared the intended semantics
("reserved for a name with no price *anywhere* in the panel"); the code could not tell the two
apart.

**Measured over 1,943,089 eligible name-periods: 0.1763%/session were alive-but-unpriced
(written off at −100%) against 0.0094%/session genuinely delisted — ~95% false positives.**
0.176pp/day reconstructs the ~38pp/yr gap almost exactly. Diluted at 21d (12 hits/yr), dominant
at 1d (252 hits/yr), which is why the broken figure was factor-independent.

Fixed with `index_last_alive()`, keyed on **`next_open`, not `close`** — a delisted name's final
bar still has a close, so a close-based survival map suppresses the write-off on exactly the
names that genuinely delisted (caught by the regression test, not by inspection). Alive-but-
unpriced names are now dropped from the period in **both** legs, with the strategy leg
renormalised so the dropped weight isn't silently parked in cash at 0%. Genuine delistings still
take `MISSING_EXIT_PCT`.

**Universe is now near-invariant to rebalance**: `--rebalance 1` **+26.13%/yr**, `5` **+23.30%/yr**,
`21` **+20.31%/yr**. The residual monotone decline is real equal-weight rebalancing premium, not
a bug.

**No prior conclusion changed.** `value_book_to_price` at 21d moved +0.778→+0.792%/mo
(t 1.99→2.04). `delivery_pct` stays negative and insignificant — 21d/25bps **−0.464%/period
t=−1.05** (was −1.04/−1.48), 5d/15bps **−0.112%/period t=−1.11** (was −0.15/−1.48) — so the
decision to keep it out of `unified_ranker` stands. **One sub-claim did change**: at 5d, gross
**+0.500** now *beats* the universe **+0.402**, so at that horizon it genuinely IS a cost story;
the "not a cost story" note held only at 21d (gross +1.505 vs universe +1.592).

Regression test: `__tests__/test_factor_backtest_missing_exit.py`, negative-controlled (reverting
the guard fails 3 of 9).

## Screeners are DESCRIPTIVE, not predictive — and the intraday version does not cover costs

- **The gainer/loser-type screeners describe a move that already happened on the day they name.** Measured 2026-08-11, per-date excess vs the same-day universe: **same day (prev-close to close) +0.500pp, t=+12.70**, and for `technical_momentum` screeners **+0.990pp, t=+9.24**. The next session is nothing: **+0.003pp, t=+0.13** overall and **-0.106pp, t=-2.03** for momentum screeners. A screener names the stock *because* it moved, so the same-day figure is the cause of the listing, not a return anyone could have captured.
- **This is why the forward test above is the right one and its answer stands.** "Does yesterday's gainer keep going" is the only tradeable question a daily screener snapshot can answer, and the answer is no.
- **CORRECTION (same day): the intraday version IS testable, via a different table.** `live_screener_appearances` + `live_screener_runs` carry **5.85M rows across 601 runs / 32 days**, captured every 15 min during the session by `QUEUE_LIVE_SCREENER_COLLECT` (`*/15 3-10 * * 1-5` UTC), and every row joins to a run timestamp. 42 live filters include exactly the setups in question (`todayGapUP`, `todayGapDown`, `lowerHighLowerLow`, `orb5minHigh`, `todayStockOpenLow`...). Measured: enter at the OPEN of the first 15-min bar **strictly after** the capture, exit at that day's close, excess vs the equal-weighted liquid universe over the same window. **Result: nothing tradeable.** Cell-weighted (per date+capture-time, then averaged) 15 filters clear Bonferroni, all positive, best `todayBelow20SMA` +0.069pp (t=+7.68) and `roce70To100` +0.132pp (t=+5.60) — but **row-weighted the same data gives −0.019pp with only 11 of 42 positive**, i.e. the sign flips with weighting, and every magnitude (2–13 bps) is below the ~15bps intraday round-trip this repo has already measured (`best net at 15bps = −0.004%`). A result that is not robust to weighting and does not cover costs is not an edge. **The mean-reversion direction is consistent though**: the `todayBelow*SMA` family is the top of the table and `todayGapDown`/`yesterdayGapDown` both clear, while `todayGapUP` and `yesterdayGapUP` do not — same sign as the daily Gap-Down-beats-Gap-Up result.
- **The DAILY-snapshot version still cannot be tested,** and that is a different table: The genuinely open version - enter at the moment of flagging, exit at that day's close - CANNOT be tested with current data.** `screener_appearances.appeared_date` is `TIMESTAMPTZ` but every row is written at `00:00:00`: exactly one distinct time across 720,824 rows. The capture time is never recorded. `intraday_ohlcv` is ready for it (15-minute bars, 2,353 symbols, **215 days**), so the price side is not the blocker.
- **Fixing it needs a new column, not a change to the existing one**: `appeared_date` is part of the primary key `(screener_id, symbol, appeared_date)`, so putting a real time in it would stop a repeat appearance from deduping. Add `appeared_at TIMESTAMPTZ` alongside, written by the three sync files (`etnowScreenerSync.ts`, `moneycontrolScreener.ts`, `etMarketstatsSync.ts`). Until that exists, treat any "intraday screener edge" claim as unmeasured rather than disproven.

## No individual screener gives clear direction (measured 2026-08-11, do not re-run without a reason)

- **552 screeners cleared the sample bar (≥10 dates, ≥5 liquid members/date) at 1d; 51 were nominally significant at p<0.05 against 28 expected by chance, and ZERO survived Benjamini-Hochberg FDR or Bonferroni.** At 5d two survived nominally — `moneycontrol/371 "Downward Momentum"` and `moneycontrol/178 "Ben Graham Undervalued"` — but 5d returns on consecutive dates overlap 80%, and once Newey-West corrected their t-stats fall to −3.70 and −3.35 against the ~4.2 Bonferroni needs. **Neither is established.** If you test screeners again, the overlap correction is not optional: the uncorrected t-stat is inflated by roughly √5.
- **The population has clear direction, and it is negative.** Mean per-screener 1d excess **−0.0596pp (t=−6.46, n=552)**; 3 of the 4 sources are individually significant (et_marketstats −0.19/t=−4.73, trendlyne −0.048/t=−4.51, etnow −0.076/t=−2.51; moneycontrol insignificant). Appearing on a screener is, on average, a mildly *bad* sign.
- **The sentiment labels are significantly INVERTED.** Bullish-labelled screeners return **−0.1204pp (t=−6.62)**; bearish-labelled are indistinguishable from zero (−0.0138, t=−0.96). **bullish minus bearish = −0.1066pp, t=−4.61, p<0.001** — a working label system needs that difference significantly *positive*. Mechanism, not mystery: `screener_master.classified_by` is `'keyword'` for **all 1,669** rows, so sentiment is pattern-matched off the screener's *name* and has never been validated against an outcome.
  > **2026-08-13 follow-up: one real mechanism found and fixed, this exact t-stat NOT re-measured.**
  > `NLPScreenerInference.domain_override()` (`nlp_engine.py`) already has a MEASURED override for
  > oversold/near-52w-low/below-lower-BB (settled by the 5y backtest above `screener_oversold` etc.),
  > but checked `_VAL_RICH`/`_VAL_CHEAP` (reasoned-only) BEFORE it. Trendlyne/ETnow screener "names"
  > are sometimes full marketing paragraphs, e.g. `screener_catalog`'s `"Close Within 52 Week Low
  > Zone..."` row carries ~500 chars of ad copy ending "...hidden potential that lies within these
  > undervalued gems, waiting to be unearthed" — the stray word "undervalued" tripped `_VAL_CHEAP`
  > and shipped this row `bullish` live, opposite of its own measured, strongly-bearish 52w-low
  > family (t=−3.79). Fixed by re-ordering `domain_override` so the measured family runs before the
  > reasoned-only valuation checks (`nlp_engine.py`, regression test
  > `test_measured_family_beats_incidental_valuation_words_in_marketing_copy`, negative-controlled).
  > Re-running `reclassify_screener_sentiment.py --apply` against live Postgres corrected **94** of
  > 2,539 `screener_catalog` rows and 92 of 1,672 `screener_master` rows (35 neutral→bearish, 32
  > bearish→neutral, 12–13 neutral→bullish, 10–11 bullish→bearish, 3 bullish→neutral) — both tables
  > are now internally consistent (0 pending changes on re-dry-run). **This is a plumbing fix, not a
  > re-measurement**: the −0.1066pp/t=−4.61 bullish-minus-bearish number above was computed by a
  > one-off audit script against the labels as they stood 2026-08-11, not by `factor_backtest.py`,
  > so there is no cheap re-run — reproducing it needs the same point-in-time
  > `screener_appearances`-vs-forward-return join, now against corrected labels. Until that is
  > redone, treat the −4.61 t-stat as **stale, not disproven**: it is likely somewhat less negative
  > post-fix (94 rows moved, many from a wrong label toward the label the MEASURED family already
  > says is correct), but by how much is unmeasured. Do not cite −4.61 as the current number.
- **Two categories survive Bonferroni across the 10 tested, both negative**: `technical` (−0.042/t=−3.38 at 1d) and `technical_momentum` (−0.136/t=−3.21 at 1d, **−0.673/t=−3.29 at 5d** — the most negative category found). This is the same short-horizon-momentum-is-negative result the factor panel and the Gap-Up/breakout setups both give. Nothing with a positive sign reached significance.
- **`screener_master.tier` is degenerate and cannot prioritise anything**: 1,527 of 1,669 rows are `D`, 112 `Unranked`, 29 `C`, **1 `B`, and no `A` at all**. Every screener that met the sample bar was tier D.

## Judge a datasource by dates PER SYMBOL, and by its DENSE span (2026-08-12)

- **`count(DISTINCT date)` over a whole table is close to useless, and `min(date)` is worse.** Both
  misled this repo on the same dataset in one session. `marketsmojo_shareholding_history` reports 44
  distinct `period_date`s spanning 2018–2026 — it is **exactly 5 per symbol** (min = median = max = 5;
  9,120 rows = 1,824 × 5), the 44 being the union across symbols whose fiscal periods don't align.
  Four QoQ changes per name is not testable. Then `marketsmojo_technical_history` reports
  2021-07-26 → 2026-08-11, apparently 5 years — **2021 is ONE row for ONE symbol**; dense coverage
  starts 2023-08 (100/249/249/151 dates for 2023/24/25/26), so the real panel is ~3 years, which is
  what the backtest reported back as 2.83–2.94.
- **Always run both before calling a table testable**:
  `SELECT min(n), median(n), max(n) FROM (SELECT symbol, count(DISTINCT date) n FROM t GROUP BY 1)`
  **and** `SELECT extract(year FROM date), count(DISTINCT date) FROM t GROUP BY 1 ORDER BY 1`.
- Measured per-symbol depth of the 5 MarketsMojo tables: `technical` **742** (the only deep one),
  `index` 2,474/index, `financials` 35 quarters, `fintrend` 20, `shareholding` 5.
- **A one-shot vendor backfill is not an observed history.** All five arrived in a single
  2026-08-11 call (`count(DISTINCT fetched_at) = 1`), so a 2023 score is today's recomputation of
  2023. Two `fintrend` rows are dated 2026-08-14 and shareholding's max period is 2026-08-31 —
  in the future, which is proof the series is generated rather than recorded. Consequence for
  grading: a **positive** result on such data is provisional, a **negative** one is trustworthy,
  since restatement bias would if anything flatter the factor.

## What data is actually testable (audited 2026-08-11)

- **Of 60 symbol+date tables, only 9 have enough history to test anything; 35 cannot be tested at all.** The calendar constraint this file already recorded for fundamentals/analyst/ownership is far wider than four categories — 35 tables start at ~2026-06-30 and have under 40 distinct dates. No amount of modelling fixes that; only elapsed time or a backfill does. Do not spend a day "testing" any of them.
- **The deep data, ranked**: `trendlyne_pb_history` and `trendlyne_pe_history` (**3,028 dates, 12.6 years, ~4.1M rows each, ~2,420 symbols**) are by far the deepest factor data on the platform and they underpin the one provisional positive factor, `value_book_to_price`. Then `insider_trades` (1,635 dates / 11y, already measured null), `stock_ohlcv` (1,394 / 5.6y), `nse_universe_history` (1,387 / 5.6y), `macro_asset_prices` (1,242 / 4.7y, 81 assets, **never factor-tested — not a cross-sectional table, see the 2026-08-11 note below**), `feature_store` (399 dates / 19 months, 2,424 symbols, a ready-made technical panel — **factor-tested 2026-08-12, 23 columns via `factor_backtest.py`'s `_add_feature_store`, 14 significantly negative, 0 positive; see `measurement.md`'s already-tested table**), `stock_delivery_data` (286 dates / 14 months), `news_symbol_link` (188 dates but sparse over 15y).

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

## The FnO / positioning family is NOT testable — checked 2026-08-12, do not re-scope it

- **Long buildup / short buildup / short covering cannot be reconstructed at all.** That family is
  defined by (price change × *futures* OI change), and **no fetcher on this platform captures
  per-stock futures OI**. `so_stock_oi_summary.fut_oi` / `fut_oi_chg` / `fut_price` are **100% NULL
  across all 4,650 rows** — already root-caused and deliberately left NULL in
  `so_option_chain_fetcher.py` (see its comment block): Trendlyne's `body["futureData"]` is genuinely
  `{}` for real stocks, `fno_rollover_fetcher.py` is rollover%/cost-of-carry from bhavcopy (a
  different metric), and `nt_dashboard_fetcher.py` is options OI, not futures. This needs a **new
  data source**, not a code fix.
- **PCR is too shallow.** Deepest stock-level source is `stock_options_oi`: **40 distinct dates, 212
  symbols** (~2 monthly rebalance periods). `technical_signals.pcr_oi`/`pcr_vol` are populated
  (62,977 of 66,992 rows) but only **65 dates**, starting 2026-05-16.
- **`feature_store.pcr_oi` / `pcr_vol` are 100% NULL across 810,775 rows** — declared in the schema,
  never written by `feature_engineering.py` (its only writer), and read by nobody
  (`cs_ranker.py`/`ml_ensemble.py` read `technical_signals.pcr_oi`, which is fine). Dead schema, no
  consumer impact — but do **not** mistake `feature_store`'s 19-month depth for PCR depth.
- **The mistake that led here is worth more than the result: screener constituent counts are
  BREADTH, not depth.** The FnO screeners look healthy (`208631` 198 names, `208626` 92, `208625`
  50) because that is *today's* membership. Membership says nothing about history. Run the
  per-symbol depth query from [[breadth_is_not_depth_2026_08_12]] **before** nominating any
  datasource as testable.

## Grade every candidate factor against BOTH tails

- **An AUC computed only against winners cannot tell "predicts winners" from "predicts volatility", and this codebase has been fooled by that exact statistic twice.** `flyer_classifier` (AUC 0.81, IC −0.041) was the first. The second: measured 2026-08-11, ~40 features across all six factor groups, the apparent winners for next-session top-50 gainers *all* predicted the top-50 losers at least as well — `hv_20d` 0.679 gainers vs **0.704 losers**, `breakout_probability` 0.670 vs **0.705**, `bb_width` 0.632 vs **0.662**, `rs_vs_sector_21d` 0.573 vs **0.628**, `rsi` 0.556 vs **0.611**. Direction AUC (gainers vs losers, which isolates sign from magnitude) came out **below 0.5 for every one**, several significantly (t=−2.3 to −3.8). These features carry *magnitude, not sign* — re-weighting them cannot help, and a one-tailed AUC will keep saying they can. Always report three numbers: AUC vs the winning tail, AUC vs the losing tail, and AUC of one tail against the other.
- **The common bullish setups are inverted at 1-day.** Next-day open→close excess vs universe, per-date: **Gap Up ≥2% −0.465pp (t=−8.80)** — the most significantly negative thing measured here — Breakout>20d-high −0.185pp (t=−2.69), volume shocker ≥3× −0.122pp (t=−1.67), while **Gap Down ≤−2% is +0.329pp (t=+3.70)**. Open=Low/Open=High are null. Before building anything on a continuation screen, check its sign on this data.

## Sector-neutralising a factor DESTROYS it here — the opposite of the US result (measured 2026-08-12)

- **Pre-registered** (4 factors, 21d/top-50/25bps, written down before looking): Asness/Porter/Stevens
  (2000) find industry-relative firm characteristics predict better than raw ones, because a raw
  value sort is substantially a sector bet. **On this panel every value form was worse than its raw
  parent.** Figures below are **post-`index_last_alive`-fix** — all six were re-run on the fixed
  harness, and the three B/P variants share an identical universe (+1.540%/period), so this is
  apples-to-apples: `value_book_to_price` +0.805→**+0.456**%/mo (t 2.07→**1.14**),
  `value_earnings_yield` →+0.172 (t 0.52), `value_composite` →+0.533 (t 1.43). Only `momentum_12_1`
  improved (+0.533→+0.688, t 1.10→1.67) and is still nowhere near significant.
- **The obvious confound was ruled out, and this is the part worth keeping.** The `_sn` factors score
  NaN where `nse_stocks.sector` is unmapped, so they pick top-50 from **69%** of the panel while their
  raw parents pick from 100% — "raw beat sector-neutral" could just have meant "bigger pool beat
  smaller pool". The control (`value_book_to_price_secmapped`, raw scoring on exactly the `_sn`
  universe) came in at **+0.821%/mo, t=2.10** (post-fix) — restricting the universe slightly
  *helped*. So the full drop from **+0.821 → +0.456 on an identical universe is neutralisation
  itself**, not selection: it costs ~45% of the edge.
  The control factor is left registered so nobody re-derives why the naive comparison is invalid.
- **Interpretation: on Indian equities a large part of the value premium IS the sector bet.** Removing
  it removes the signal rather than purifying it. Do not re-run this without a genuinely different
  angle (a point-in-time sector history would be one — `nse_stocks.sector` is a current, surviving-
  universe snapshot, which is the one real weakness in the above).
- **Nothing was promoted.** `secmapped` at t=2.08 vs raw at t=1.99 is noise on the same factor, not an
  improvement, and neither clears a multiple-testing bar that is now ~30 factors wide (needs ~t=3.0).
