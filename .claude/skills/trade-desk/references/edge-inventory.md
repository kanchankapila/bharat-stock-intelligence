# Edge inventory — what is tradeable here, and what is already dead

One-page distillation of `.claude/rules/measurement.md` for trading decisions. That file is
authoritative; this one is the lookup table. **Re-read the source before quoting any number
from here** — measurement.md's own banner records numbers in it going stale as the panel
grows (`insider_net` went from "the one significant survivor, t=2.05" to "does not
reproduce, t=1.73" on a re-run with no code change).

## Tradeable

| Setup | Construct | Result | Notes |
|---|---|---|---|
| **capitulation triple** | `gap_down` AND `open_eq_low` AND `top_loser` on session D → long at D+1 open, exit D+1 close | **+0.53%/day excess, net 15bps, t=+3.61, p=0.0003, 425 dates, 6/6 years positive** | Robust: winsorizing *strengthens* it (t 3.69–3.94); dropping the 3 most extreme days still t=3.25. ~1.5 signals/day when it fires. Thin — not capacity-proven at scale. |

That is the entire list.

## Explicitly dead — do not build a trade around these

- **Every single-leg gap trade.** `gap_down` alone: t=−3.54. `gap_up`: t=−3.55. Both are
  turnover traps (~90–93% one-way turnover per period). The triple works *because* it is
  rare and narrow; loosening any leg lands you in these rows.
- **Momentum, all short horizons.** `momentum_21d`/`63d`/`reversal_21d` negative to t=−3.96.
  `momentum_12_1` t=1.10, not significant.
- **The whole oversold/overbought technical family.** 14 of 23 `feature_store` columns clear
  a Bonferroni bar and *every one of them is negative*: `stoch_d` −9.28, `williams_r` −9.02,
  `stoch_k` −9.00, `cci` −7.57, `di_plus` −7.34, `dist_sma20_pct` −6.40, `vwap_dist_pct`
  −5.78, `volume_ratio_20d` −5.75, `obv_slope` −4.98, `atr_pct` −4.81, `macd_hist` −3.92,
  `bb_width` −3.15.
- **Volatility, both tails.** `high_vol` −1.21 *and* `low_vol` −1.66 — the middle outperforms.
- **Screener consensus.** Bullish consensus IC −0.027, t=−2.36. Sentiment labels are
  themselves inverted (−0.11pp, t=−4.61) because they are keyword-classified off the
  screener's *name* and never validated. 0 of 1,563 individual screeners survive FDR.
- **News sentiment.** Real same-day (+0.13 IC) but −0.03 next-day: the move is over before
  any entry you can take.
- **Delivery, insider, ticket size.** `delivery_spike`/`delivery_trend` dead; `ticket_size`
  significantly *inverted* (t=−2.36); `insider_net` does not reproduce (t=1.73);
  `delivery_pct` has a real spread but is dead long-only (t=−1.48).
- **Vendor composite calls.** `mojo_indigraph` (MarketsMojo's own bullish/bearish call):
  t=−0.15 to −1.26, no edge.
- **Sector-neutralising anything.** Every sector-neutral variant is worse than its raw
  parent here — the opposite of the published US result, and confirmed against a control.

## The platform's own outputs — what they are worth

| Surface | Measured value | How to use it |
|---|---|---|
| `unified_recommendations` (canonical ranker) | `unified_score` 5d rank IC ≈ 0.0001, t=0.02. Only ~2 gradeable pre-market dates exist; needs ~30. | Context only. **Not gradeable yet** — do not quote an accuracy number for it. |
| `stock_scores` (`scoring_engine.py`) | Input to the ranker. Carried a standing downward bias from neutral screener tags scored as bearish (fixed 2026-08-13, explained ~1% of the universe). | Context only. |
| `quant_scores` | Input to the ranker. No `date` column — one row per symbol. | Context only. Never `ORDER BY date` it. |
| `signal_outcomes` win rates | **Check `label_definition` first.** `terminal_pct2` vs `path_barrier` on the same window gave 41–44% vs 88–91%. Not comparable. | Never compare two win rates without checking this. |

An early live grading pass (n=2 dates, not significant) found the ranker's **Strong Sell
underperforming plain Sell on both dates** — conviction pointing the wrong way — and its Sell
bucket's win rate flipping with the day's market direction, i.e. reading as beta, not skill.
Consistent with the zero-IC finding. Treat high conviction as no more informative than low.

## Not measurable yet — don't spend time here

- **Fundamentals / analyst / ownership / earnings factors.** Every one of those tables has
  ~30 distinct dates starting 2026-06-30 — 1–2 independent quarterly observations. Calendar
  constraint, not an engineering one.
- **F&O positioning** (long/short buildup, short covering). No fetcher captures per-stock
  futures OI; `so_stock_oi_summary.fut_oi` is 100% NULL. Needs a new data source.
- **PEAD / earnings surprise.** `earnings_category_yoy` has 19 trading days of real depth.
  `pead_model.py`'s own inputs (`eps_growth_yoy`/`_qoq`) are ~100% NULL — dead schema.
- **`screener_breadth`.** Only 9 periods (`screener_appearances` spans ~2.5 months). Point
  estimates negative, nowhere near significant. Re-test at 12+ months.

## Before adding anything to the "tradeable" table

1. Run it through `factor_backtest.py` or `screener_combo_finder.py` — the real harness,
   with the real cost and turnover accounting.
2. Apply the panel spec: per-date then averaged (never pooled), winsorized, `is_suspect`
   filtered, ≥₹1cr ADT, next-day open entry.
3. Correct for how many things you tested. A t=2.2 out of 26 candidates is noise.
4. Write the verdict into `measurement.md` — including if it failed. The failures are the
   most valuable rows in that file.

**A backtest script that formats plausible numbers without connecting to the database is
worse than no backtest**, because the output gets committed and cited as evidence. Five such
scripts were found and deleted here on 2026-08-12. Before trusting any result: does the
script actually `.execute()` a query before formatting its numbers?
