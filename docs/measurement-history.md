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

---

# Superseded sections moved out of `.claude/rules/measurement.md` (relocated 2026-08-27)

These three blocks were moved here verbatim, unedited, to keep `measurement.md` readable. **Every
one was already marked superseded/corrected in place before the move — nothing here is a current
verdict, and none of it should be cited as one.** `measurement.md` carries a short pointer in each
block's former position with the operative reading. Kept because the narratives are this repo's own
worked examples of how a confident wrong measurement gets made and caught.

## 1. The 4 previously-ungraded engines, graded against the WRONG horizon (2026-08-20)

Superseded the same day. The correction (native-label re-grade) lives in `measurement.md`.

### ⚠ SUPERSEDED same day, see the correction section immediately below — wrong grading horizon for 3 of 4

### The 4 previously-ungraded `unified_ranker.py` engines — graded 2026-08-20, none clear USABLE

Prompted by a "which of the ~30 models actually earn their runtime cost" review:
`breakout_classifier.py`, `movement_predictor.py`, `confluence_ml_engine.py`, and `cs_ranker.py`
had never been run through `factor_edge.py` or `factor_backtest.py` — no net-of-cost verdict, no
IC/AUC read, anywhere in this repo. Graded the same way `win_probability` just was, live
production 2026-08-20T12:03-12:05 IST.

`factor_edge.py --table technical_signals --scores breakout_probability,movement_probability,cs_score --horizons 1,5,21 --persist`
(80,517 rows / 2,269 symbols / 72 dates, 75,558 matched to forward prices):

| score | horizon | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|---|
| `breakout_probability` | 1d | +0.008 | 0.486 | 59,020 | 28 | no edge |
| `breakout_probability` | 5d | −0.007 | 0.496 | 50,249 | 24 | no edge |
| `breakout_probability` | 21d | −0.013 | 0.492 | 15,261 | 8 | LOW-DATA |
| `movement_probability` | 1d | −0.030 | 0.486 | 48,108 | 22 | no edge |
| `movement_probability` | 5d | −0.031 | 0.489 | 39,339 | 18 | LOW-DATA |
| `movement_probability` | 21d | −0.048 | 0.474 | 4,355 | 2 | LOW-DATA |
| `cs_score` | 1d | +0.047 | 0.505 | 73,368 | 53 | no edge |
| `cs_score` | 5d | +0.062 | 0.512 | 64,597 | 49 | no edge |
| `cs_score` | 21d | +0.015 | 0.508 | 29,483 | 33 | no edge |

`confluence_ml_engine.py`'s `ml_breakout_probability` lives in `confluence_signals`, a 30-min-cadence
intraday table (4.49M rows / 52 dates, not one-row-per-symbol-per-day like `technical_signals`), so
`factor_edge.py`'s `--table` CLI can't be pointed at it directly without either double-counting
same-day snapshots or picking a look-ahead-biased entry point. Reduced to the EARLIEST
`computed_at` per `(symbol, date)` — the most conservative, earliest-tradeable read — via a one-off
script that imported `factor_edge.py`'s own `_forward_returns`/`_metrics`/`_verdict` rather than
reimplementing the IC/AUC math, then persisted to `factor_edge_history` under
`table_name='confluence_signals_daily_first'` so it's flagged as a different measurement shape than
the other rows, deleted after the run (not a shipped tool):

| score | horizon | rank_IC | hit_AUC | n | dates | verdict |
|---|---|---|---|---|---|---|
| `ml_breakout_probability` | 1d | +0.016 | 0.511 | 83,527 | 37 | no edge |
| `ml_breakout_probability` | 5d | +0.040 | 0.526 | 74,140 | 33 | no edge |
| `ml_breakout_probability` | 21d | +0.022 | 0.521 | 36,584 | 17 | LOW-DATA |

**None of the four clear `USABLE` (needs `abs(rank_IC) >= 0.03` AND `hit_AUC >= 0.55`).** Two
data points worth reading precisely rather than as a flat zero: `cs_score` (5d IC +0.062) and
`ml_breakout_probability` (5d IC +0.040) both clear the IC bar alone — same "IC says something real,
AUC says it's not classifiable" shape `win_probability` showed above, just weaker (AUC 0.512/0.526
vs win_probability's 0.513/0.537). Three independent engines now show this identical ceiling
(win_probability, cs_score, ml_breakout_probability), which strengthens rather than weakens the
existing hypothesis that the AUC ceiling is a **label/target construction** problem shared across
this codebase's ML pipeline, not a property of any one model. `movement_probability` and
`breakout_probability` are flat negative/near-zero on both metrics — no directional signal at all,
not even the weak kind.

**Consumption check — this is the part that makes the finding actionable, not just descriptive.**
Grepped `unified_ranker.py` for all four:
- **`cs_score` and `breakout_probability` ARE live-blended** into `unified_score` today (`engine_scores['cs']`/`engine_scores['breakout']`, unified_ranker.py:2065-2092,2221) — i.e. two inputs to the canonical Buy/Sell call that every dashboard shell ultimately reads now have an external, well-powered (24-53 dates) "no edge" verdict.
- **`movement_probability` is advisory-only by its own inline comment** (queues.ts:1102, "Advisory-only for now") — never read by `unified_ranker.py` at all. It trains, scores, and writes on a 30-min job for a value nothing downstream ever consumes beyond a freshness-coverage check (`dataQualityChecks.ts`) and a NEVER_FILL list (`densify_feature_matrix.py`). Pure runtime cost, zero output.
- **`ml_breakout_probability` has no reader anywhere outside `confluence_ml_engine.py` itself** — not `unified_ranker.py`, not any other file. Same shape, fully inert.

**Does not contradict `load_engine_edge_verdicts()`'s existing gate.** `unified_ranker.py`'s live
`ENGINE_EDGE_SHRINK` mechanism (line 681 area) reads `factor_edge_history` filtered to
`table_name='unified_recommendations'` — i.e. the ranker's OWN blended reporting columns
(`cs_score`/`breakout_score` on `unified_recommendations`), not the raw `technical_signals` values
graded above. Checked live: that table's own grading run (`run_at=2026-08-17T19:05:22`) is stuck at
**1 date** for both (`LOW-DATA`) — same calendar-constraint shape as `smart_money_score`'s existing
entry below, because `unified_recommendations_history` still only has a handful of provably
pre-market dates. So the live auto-shrink gate has nothing to act on yet regardless. **The grading
above is a different, much better-powered read of the same underlying question** (24-53 dates vs 1)
— it measures whether the raw engine output has any signal at all, upstream of the ranker's own
regime multipliers and crowding discount, and at this sample size it's a more decisive answer than
the gate's own input currently can give.

**Not escalated to a `factor_backtest.py` cost/turnover-aware run.** Unlike `win_probability`
(real, *growing* IC that justified the extra cost-aware pass), none of these four clear even the
fast IC+AUC screen — the two closest (`cs_score`, `ml_breakout_probability`) are weaker than
`win_probability`'s already-tested-and-rejected 5d read. Per this file's own "already tested, do
not re-run without a reason" discipline, spending a full cost-aware backtest on a result already
below a rejected bar isn't warranted.

## 2. `win_probability`'s 2026-08-15 preliminary grade — the flip-flop, in full

Three nested layers, in the order they were written: the retraction-withdrawal, then the retraction
that was itself wrong, then the original preliminary grade. **All superseded by the 2026-08-20
powered re-measurement.** Retained as the repo's richest worked example of the master rule — a
wrong provenance conclusion retracting a correct finding.

### ⚠ RETRACTION WITHDRAWN 2026-08-15 — the retraction itself was wrong. Result stands, preliminary.

**Read this whole block before citing anything here; this finding flipped twice in one session.**

The retraction below claimed two defects. **Both are false**, and the error was mine:

1. *"--score runs only weekly."* **Wrong.** `ml_ensemble.py --score` is not the only scoring path.
   `queues.ts:1037` runs `T.run('ml-ensemble-score', () => pythonApi.scorePending())` **daily**
   inside ml-daily-ops — an HTTP call to the ml-api service, which is why a grep for `--score`
   missed it. `python_api.py`'s handler is `ml_ensemble.run(do_train=False, do_score=True)`.
   Confirmed in data: `unscored = 0` on every recent date (08-10 … 08-14); a weekly cadence would
   leave a visible backlog. `dataQualityChecks.ts:653` already documented this in a comment —
   *"win_probability is written by ml-ensemble-score … which runs once in the evening, AFTER
   technical-scan has written that day's rows (8:30am-4pm IST)"* — i.e. the answer was written
   down in this repo and I concluded the opposite without reading it.
2. *"Train-on-test leakage."* **Wrong for the live path.** The daily scorer passes
   `do_train=False`; it scores with the pickled model from the *previous* weekly retrain, which
   predates the rows being scored. The weekly `--train --tune --score` does train-then-score, but
   by the time it runs, daily scoring has already filled those rows, so its `WHERE
   win_probability IS NULL` matches ~nothing. Not a live leakage path.

**So the numbers stand** — raw h=1d rank IC **+0.0364, t=+2.58** (41 dates), h=5d +0.0763,
t=+3.58; top-decile excess +0.183%/day; the day's 10 biggest gainers at mean percentile 0.550.
Rows are written the evening of date *d*, so they are knowable before *d+1*'s open, and the
next-open entry used in the grading is legitimate.

**The caveats that remain genuinely valid, unchanged:**
- **IC is not a tradeable edge.** No cost or turnover analysis was run. `delivery_pct` in the
  table above had spread t=+7.82 and was still **dead** long-only net of costs.
- **h=5 windows overlap** across consecutive dates, so those observations are autocorrelated and
  t=+3.58 is optimistic. **h=1 (t=+2.58) is the honest read.**
- **41 dates is thin**, and `win_probability` history only starts 2026-05-16.

**Provenance is now measured rather than inferred.** Migration `1787050000000` added
`win_probability_scored_at`, stamped by the scorer itself, and check `win-probability-scored-in-time`
watches the lag. From the next daily run the real cadence is a number in the data instead of
something reconstructed from the scheduler — which is what should have settled this the first time.
**Note:** the 1.41d lag observed on 2026-08-15 is an artifact of a manual test write, NOT the real
cadence; expect ~0.2-0.5d once the daily scorer stamps a full batch.

### (superseded — the retraction that was itself wrong, kept for the record)

**The provenance trace that the entry below listed as its own #2 caveat was carried out
2026-08-15 and it invalidates the result.** Two independent, structural defects, either one
sufficient on its own:

1. **The value does not exist at the entry time it was graded against.** `ml_ensemble.py --score`
   appears in exactly ONE scheduled place (`queues.ts:1290`), inside the **weekly** retrain job
   (`--train --tune --score`, "weekly retrain continues"). It scores `WHERE ts.win_probability IS
   NULL`, i.e. the whole backlog since the last weekly run. So a Monday row's `win_probability` is
   typically written the FOLLOWING weekend — days after the Tuesday open the grading used as its
   entry. Nobody could have traded on it. `technical_signals.created_at`/`updated_at` are 100%
   NULL (dead columns), which is why this had to be traced through the scheduler rather than read
   off the row; `computed_at` (100% populated) records only when the row was CREATED, a lower
   bound, and it correctly shows same-day creation — which is what made the setup *look* clean.
2. **Train-on-test leakage.** In the same invocation `run()` executes `if do_train:` first —
   `load_training_data()` pulls every resolved `signal_outcomes` row with no cutoff excluding the
   week about to be scored — and only then scores that week's rows. **The model is fitted on the
   outcomes of the very rows it subsequently scores.** A positive IC is the expected artifact.

**Retracted numbers** (raw h=1d IC +0.0364 t=+2.58; h=5d +0.0763 t=+3.58; calibrated +0.0472 /
+0.1007; top-decile excess +0.183%/day; gainers at percentile 0.550). Grading the raw column
separately did rule out *calibration* leakage specifically — but not this, which sits upstream of
both columns and contaminates raw and calibrated alike. **`unified_score`'s IC ≈ 0.0001 remains
this platform's honest headline; nothing has displaced it.**

**Separate, real finding worth keeping — `win_probability` is not fit to be a live signal as
currently produced.** It feeds `scoring_engine`'s Factor 3 (`ml_alignment_points`, 0-20 pts, ~18/20
mean) and the 0.55/0.40/0.30 bands, yet it is (i) written only weekly, so it is stale by up to
~5 trading days for most rows, and (ii) produced by a train-then-score-in-one-invocation job, so
it can never be graded as a forward signal without first separating those steps. Fixing it means
scoring on a daily cadence with a model trained strictly on data preceding each scored date —
until then, no measurement of this column can be trusted, in either direction.

### (superseded, kept for the record) PRELIMINARY — `win_probability` grades POSITIVE

Graded 2026-08-15 against realized returns, full panel spec (per-date then averaged, winsorised
1/99 on observed values, `is_suspect` excluded, ≥₹1cr ADT20, **next-day OPEN entry**):

| column | h=1d rank IC | h=5d rank IC |
|---|---|---|
| **raw `win_probability`** (model output, never fitted on outcomes) | **+0.0364, t=+2.58** (41 dates) | **+0.0763, t=+3.58** (38 dates) |
| `calibrated_win_probability` (isotonic fit ON realized outcomes) | +0.0472, t=+3.41 (36) | +0.1007, t=+4.15 (33) |

Top-decile-by-`win_probability` excess vs the day's own universe: **+0.183%/day (t=+2.56)** at
h=1, **+0.886%/period (t=+3.24)** at h=5. The day's 10 biggest real gainers sat at a mean
`win_probability` percentile of **0.550** vs 0.500 for chance.

**Leakage was tested for, not assumed.** `calibrated_win_probability` is produced by
`ml_calibration.py` fitting isotonic on realized `signal_outcomes` — i.e. potentially on the very
outcomes being graded. Grading the **raw** column separately isolates that: raw is independently
positive, so this is **not purely a leakage artifact**. That calibrated is consistently stronger
than raw is nonetheless consistent with *some* leakage in the calibrated column, and it should not
be quoted as the headline number.

**Why this does NOT contradict this file's "no edge" headline:** that verdict is about
`unified_score` (5d rank IC ≈ 0.0001, t=0.02) and the 26 `FACTORS`. `win_probability` is a
different, previously-ungraded column — the LGBM ensemble's own output. This is new information,
not a reversal.

**Four reasons this is NOT yet a tradeable edge, and must not be treated as one:**
1. **IC is not edge, and this platform has been burned by exactly that.** See `delivery_pct` in
   the table above: quintile spread t=+7.82, yet **dead** as a long-only factor net of costs
   (−1.04%/period at 21d/25bps). Nothing here is cost- or turnover-aware. A real
   `factor_backtest.py`-style net-of-cost run is required before any claim of tradeability.
2. **Provenance is unverified.** It is assumed, not proven, that a date-`d` `win_probability` is
   written before `d+1`'s open. `ml_ensemble --score` only fills `WHERE win_probability IS NULL`
   (so it does not rewrite history), but the write *timing* was not traced. This repo has already
   had one confident, wrong result from exactly this class (`signal_generated_at`, t=−3.44 → −1.28
   once re-anchored) — treat the provenance filter as unchecked until someone traces it.
3. **h=5 windows overlap** on consecutive dates, so those 38 observations are autocorrelated and
   the t-stat is optimistic. h=1 (t=+2.58 raw) is the cleaner read.
4. **Only 41 dates** (`win_probability` history starts 2026-05-16). Thin, and the same span that
   this file elsewhere calls insufficient for a verdict.

**Next step, in order:** trace write-timing provenance → re-run h=1 only, non-overlapping →
cost/turnover-aware portfolio run. If it survives all three, it is the first genuinely positive
signal measured on this platform and belongs in the "already tested" table with a real entry.
Until then it stays here, flagged preliminary.

## 3. `build_features()` — the periodic-`.copy()` fix and its single-pass rewrite (2026-08-22)

Both entries. The second supersedes the first. Neither is a scoring change; both are recorded here
for the verification method (old-vs-new byte-identical comparison), not for any measured verdict.

### `build_features()`'s pandas fragmentation fix (2026-08-22) is NOT a scoring change — no `factor_backtest.py` run applies

`ml_ensemble.py`'s `build_features()` assigns 400+ columns one at a time (`X['col'] = expr`),
which trips pandas' `PerformanceWarning: DataFrame is highly fragmented` past its internal
~100-block threshold — 612 distinct source lines, ~16,500 total warning instances across a full
pytest run, purely from this one function (called from training, two scoring/backtest paths, and
`incremental_update`). Found while investigating why a routine pytest run's output looked
alarming (16k+ warning lines read, at a glance, like mass failure — it wasn't; 0 tests failed).

Fixed by inserting `X = X.copy()` at 5 points spread across the function's ~50 section
boundaries. `.copy()` is a pure identity operation — it duplicates the DataFrame's data
byte-for-byte into freshly consolidated memory blocks, changing zero values — and its only
effect is resetting pandas' block-fragmentation counter before the next stretch of assignments
re-triggers the warning. **No feature's computed value changes, no column is added or removed,
no weight/threshold/formula is touched.**

**`factor_backtest.py` was deliberately NOT run, same reasoning as this file's
`_log_recommendations`/`seed_screener_catalog`/`_next_generated_at` entries**: it measures
price-panel factor edge and has no code path sensitive to `build_features()`'s internal memory
layout. The applicable verification is a direct one, done: `test_ml_ensemble.py`,
`test_exit_policy.py`, `test_ml_ensemble_pricefeed_fallback.py`,
`test_ml_ensemble_promotion_label_and_edge.py`, `test_cs_ranker.py`,
`test_analyst_estimates_snapshot.py`, `test_fundamentals_pit.py` (all callers of
`build_features()` reachable from the test suite) — 80/80 passed, and the `PerformanceWarning`
no longer appears in any of their output. **Warning volume measured, not asserted**: a full
CI-identical run dropped from 16,526 warnings (pre-fix baseline) to 154 (post-fix) — the ~16.4k
difference is entirely `PerformanceWarning` instances this fix removes.

Full CI-identical suite re-run twice to confirm no regression, and each run told a different,
useful part of the story: the first came back `1 failed, 2125 passed` —
`test_mc_earnings_fetcher.py::TestFetchActualEstimateBeatsUsesLogicalTradingDate::test_write_targets_logical_trading_date`,
a file this change never touches. Investigated rather than dismissed: passed standalone, passed
with its whole file run alone, and passed within `src/server/tests/` run alone (1,658 tests) — a
`src/server/__tests__/`/`tests/chatbot/`-interaction-dependent flake, not reproducible in
isolation. A second full run came back **`2129 passed / 232 skipped / 0 failed`** — clean,
including that exact test. Recorded honestly rather than claimed as fixed: this is a
**pre-existing, non-deterministic flake, root cause not identified**, orthogonal to this change
(3 of 4 attempts against the post-fix code were clean; the file's own logic and this diff share
no code path). Worth a dedicated look if it recurs; not this session's finding to claim.

### `build_features()` rewritten to single-pass construction (2026-08-22) — supersedes the periodic-`.copy()` interim fix above, still not a scoring change

The periodic-`.copy()` fix above was explicitly the mitigation, not the fix: it silenced the
warning by resetting pandas' block-fragmentation counter, but the 400+ sequential
`X['col'] = expr` assignments were still there. Rewritten for real: `build_features()` now
accumulates every feature into a plain `dict` (`feat['col'] = expr`, O(1), no pandas block
machinery involved at all) and constructs the DataFrame **once** at the very end
(`X = pd.DataFrame(feat, index=df.index)`), which also made the 5 `.copy()` checkpoints
unnecessary — removed.

Done as a scoped, mechanical text transform (Python script under `Bash`, not hand-edited line by
line across ~880 lines) with safety assertions on every substitution count before writing:
`X['` → `feat['` (408 occurrences), `X.get(` → `feat.get(` (3, the second-order-interaction
fallback reads), `index=X.index` → `index=df.index` (3, same 3 lines) — checked first for any
other whole-DataFrame usage of `X` (`.columns`, `.shape`, `.loc`, `in X`, etc.) that a blind
substitution could silently break; none existed beyond the 3 `.get()` sites and one unrelated
comment mentioning `predict_proba_ensemble()`'s own `X` parameter (a different function, left
untouched).

**Verified as zero-value-change two ways, not one:**
1. A direct old-vs-new comparison — both versions loaded side by side via `importlib`, called on
   the identical synthetic 50-row input (broad column coverage, including columns deliberately
   left absent to exercise `num()`'s default path and the `.get()`/`feat.get()` fallback path,
   plus the `len(df)==0` empty branch) — **421 columns, 0 differing values, exact match
   (`atol=0, rtol=0`), including the empty-input branch's column set.** Not a unit test; a one-off
   script, deleted after use per this file's own convention for such checks.
2. The existing 80-test suite across every `build_features()` caller — 80/80 passed, unchanged
   from the periodic-`.copy()` fix's own verification.

**No `factor_backtest.py` run applies, same reasoning as the periodic-`.copy()` fix and this
file's `_log_recommendations`/`seed_screener_catalog` entries** — a construction-method change
with byte-identical output has nothing for a price-panel factor-edge measurement to detect.

Full CI-identical suite re-run a third time on top of this change: **2140 passed / 232 skipped /
0 failed / 154 warnings (980.79s)** — same warning count as the periodic-`.copy()` fix (confirms
the single-pass rewrite doesn't reintroduce fragmentation elsewhere), and the
`test_mc_earnings_fetcher.py` flake noted above did **not** recur this run either (4 of 5 total
attempts across both fixes now clean — consistent with "non-deterministic, unrelated," not
"caused by either change").

**Performance was not benchmarked.** Every claim above is about correctness (identical values) and
warning suppression (confirmed), not wall-clock speed — dict accumulation plus one final
construction is expected to be faster than 400+ incremental DataFrame inserts (the textbook
reason pandas recommends this pattern), but that expectation was not measured with a timer, and
should not be quoted as a measured number.
