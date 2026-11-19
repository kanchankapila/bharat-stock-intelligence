# Pre-registration: all-expiry futures OI and index contribution (AF-20261119-09, AF-20261119-10)

Written 2026-11-19 ~19:45 IST, **before any forward return was computed for either test**. Committed before the
runs so the definitions cannot move after a result is seen. Source: `docs/audits/2026-11-19-moneycontrol-endpoint-evaluation.md`.
Bar: two-sided |t| >= 2.58 (the 2026-10-10 convention for several tests at once). Panel recipe: `measurement.md`
"The panel spec" (per-date then average, winsorise, `is_suspect = 0`, Rs 1cr ADT floor, next-session OPEN entry).
Runs happen outside 09:00-16:00 and 18:50-00:30 IST (production load rule).

## Test A - does all-expiry OI change carry information that near-month OI change hides? (AF-20261119-09)

**Data.** `stock_futures_eod_history`, `instrument = 'STK'`, 2021-01-01..2026-11-12 (two nearest expiries per
symbol-day; 1,448 sessions, 307 symbols). Prices: `stock_ohlcv` (`is_suspect = 0`), joined on the NSE symbol.

**Factors (fixed now):**
1. `oi_pct_all` - matched-contract total OI change: over expiries present on both t-1 and t,
   `sum(OI_t) / sum(OI_{t-1}) - 1`. Matching removes the expired contract and the newly listed far month, so a
   roll (near down, next up) nets to about zero. (Example, IRFC 2026-10-26: near -20.96M, next +21.21M.)
2. `oi_pct_near` - the near-month contract only (`expiry_rank = 1` on both days, same expiry): the series the
   repo stores today. **Baseline**, graded identically.
3. `oi_conf_all` - `oi_pct_all * sign(close_t / close_{t-1} - 1)`: OI growth in the direction of the price move
   (the continuous form of long/short buildup).

**Population.** Symbol-days with both factors defined, `stock_ohlcv` close and next open present, ADT20 >= Rs 1cr,
`|oi_pct_all| <= 1` (drops listing/delisting artefacts). Cross-sections under 50 names are dropped (DEGENERATE-XS).

**Outcome.** Return from the open of t+1 to the close of t+h, h in {1, 5, 10}, winsorised 1/99 per date.

**Statistic.** Per-date Spearman rank IC; mean over dates; t on non-overlapping dates (every h-th date) so
`n` = independent periods. Also the per-date top-minus-bottom quintile spread and the per-year sign of the IC.

**Splits.** (i) all sessions; (ii) **excluding expiry week**: the monthly expiry session of the near contract and
the 4 sessions before it.

**Decision rule.**
- The repo's "no edge" verdict for OI change changes only if `oi_pct_all` or `oi_conf_all` reaches |t| >= 2.58
  at some h in split (i) or (ii) with the same sign in at least 4 of the 6 years.
- If `oi_pct_near` also passes with the same sign, near-month storage is not the problem; no fetcher change.
- If only the all-expiry factor passes: switch the fetcher to all expiries (or capture `getFnoOiTrends`), and the
  next step is a cost-aware `factor_backtest.py` arm, never a ranker weight (an IC is ordering, not money).
- If nothing passes: record "no edge on 1,448 sessions" for all three, which supersedes the 13-14-date readings.

## Test B - is Moneycontrol index contribution a regime conditioner? (AF-20261119-10)

**Data.** `research/out/af-20261119-10/index_contribution.csv` (backfilled 2026-11-19 from
`getAllIndexContribution`, one call per session, ~2023-12 onwards). Primary index NIFTY 50 (`index_id = 9`); target
`stock_ohlcv` `NIFTY50`. NIFTY 500 has no index price series here, so it is descriptive only.

**Validation first (not a result).** `net_contri` must track the NIFTY 50 point change: Pearson >= 0.95 on matched
sessions, else the series is not what it claims and the test stops.

**Variable (fixed now).** Rotation `R_t = 1 - |pos + neg| / (pos + |neg|)`, in [0, 1]: 0 when every point moved
one way, 1 when gains and losses offset. Signal `R5` = mean of R over the 5 sessions ending t.

**Tests.**
1. Time series: NIFTY 50 log return from the t+1 open to the t+5 close regressed on standardised `R5`, on
   non-overlapping 5-session periods. |t| >= 2.58.
2. Conditioner: does the platform's 5-session cross-sectional mean-reversion IC (feature_store `ret_5d` reversal,
   liquid universe, per the panel spec) differ between periods with `R5` above vs below its trailing-252 median?
   Two-sample t on per-period ICs, |t| >= 2.58. The median uses only past data (no look-ahead).

**Power stated up front.** About 490 sessions, so about 98 independent 5-session periods. A pass is a lead for a
shadow arm, not a regime weight; a fail is weak evidence because of the short history (data starts ~2023-12;
2023-09-05 and earlier are refused by the endpoint).
