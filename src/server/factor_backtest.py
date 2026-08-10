"""Cross-sectional factor backtest harness -- cost- and turnover-aware, survivorship-free.

WHY THIS EXISTS (2026-08-10)
----------------------------
`backtester.py` replays discrete SIGNALS (one row = one trade with entry/target/stop). That
answers "did these specific calls work". It cannot answer the question that actually decides
whether this platform is tradeable:

    "If I ranked the universe by X every N days, held the top K, and paid real Indian
     delivery-equity costs on the names that actually changed -- what would I have made?"

That is a portfolio question, not a trade question, and it needs three things the signal
replayer does not provide: a point-in-time universe, next-open entry, and costs charged on
TURNOVER rather than on notional every rebalance.

The audit that motivated this measured `unified_score` at a 5-day forward rank IC of 0.0001
(t=0.02) over the only 29 ranker-days that exist, and found nothing in 4.5 years of price
history with positive alpha after costs. Those conclusions were reached with throwaway scripts.
This module exists so the next such claim is reproducible instead of re-derived from scratch.

THE THREE THINGS MOST BACKTESTS GET WRONG, AND WHAT IS DONE HERE
----------------------------------------------------------------
1. SURVIVORSHIP. `stock_ohlcv` is backfilled by iterating the CURRENT `nse_stocks` master, so
   companies that stopped trading are simply absent. Measured 2026-08-10: **385 of 2,168
   liquid (>=1cr ADT) symbols since 2022 are missing**, 17.8% -- far worse than the ~7.6%
   full-universe figure quoted elsewhere in this repo, because delistings concentrate in
   exactly the liquid-enough-to-trade band. Filled from NSE bhavcopy via
   `Backtester.load_bhavcopy_adjusted` (reused, not duplicated -- it already handles the
   raw-vs-split-adjusted seam a naive UNION would reintroduce), mirroring the pattern
   `breakout_classifier.py` already uses. Disable with --no-survivorship-fill to measure the bias.

2. LOOK-AHEAD. A rank computed from date D's close cannot be traded at date D's close. Entry
   and exit are both at the NEXT session's OPEN, so a position formed on D is bought at D+1
   open and sold at (next rebalance)+1 open. There is no path by which the ranking sees a
   price it then trades at.

3. COSTS ON TURNOVER, NOT NOTIONAL. Charging a flat round-trip every rebalance (what the
   ad-hoc audit scripts did) overstates cost badly for a book whose names persist. Here the
   traded fraction is the standard sum(|w_new - w_old|) over the union of held names, so a
   rebalance that keeps 70% of the book pays ~30% of a full round trip. A complete
   replacement gives sum|dw| = 2.0 = one full round trip, which is the correct limit.

COST MODEL (Indian delivery equity, per side, bps)
--------------------------------------------------
    STT 10.0 (0.1%, charged BOTH sides on delivery) | brokerage ~3.0 (discount) |
    exchange txn ~0.3 | SEBI ~0.01 | GST 18% on (brokerage+txn) ~0.6 | stamp 1.5 (buy only)
    => ~15 bps explicit per side, ~29 bps explicit round trip.
Default here is 25 bps/side (50 bps round trip), i.e. explicit cost plus ~10 bps/side of
slippage -- deliberately conservative for a liquid mid/large-cap book. Slippage is ASSUMED, not
measured: `tick_data` and `order_book_snapshots` are both empty, so no spread data exists in
this platform to calibrate against. Sweep it with --cost-bps before believing any result that
sits within a few bps of break-even.

WHAT THIS DOES NOT DO
---------------------
No intraday fills, no partial fills, no market-impact model (impact scales with size and this
assumes you are small relative to 1cr ADT), no short book, no leverage, no dividends (price
return only -- Indian large-cap yields ~1-1.5%/yr, so a long-only result here is understated by
roughly that against a total-return benchmark, and a long/short spread is unaffected).

RESULTS AS OF 2026-08-10 (14 factors, 53 monthly rebalances, top-50, 25bps/side)
--------------------------------------------------------------------------------
Read this before adding a factor, because the pattern is consistent and it is the opposite
of what "more signal = better" would predict.

  POSITIVE AND SIGNIFICANT:
    value_book_to_price  +0.93%/mo  t=+2.67   turnover 0.28   <- strongest found
    momentum_12_1        +0.86%/mo  t=+2.08   turnover 0.35
  SIGNIFICANTLY NEGATIVE (useful only as exclusions):
    low_vol              -1.66%     t=-2.95
    low_max_ret          -1.54%     t=-3.12   <- MAX (Bali et al.) INVERTS on Indian equities
    reversal_21d         -1.39%     t=-3.97
    momentum_ex_lottery  -1.25%     t=-2.69   <- see below
    high_vol             -1.21%     t=-3.89
    reversal_x_delivery  -0.89%     t=-2.15
  NOT SIGNIFICANT: momentum_63d, momentum_21d, near_52w_high, delivery_pct, low_beta,
                   low_idio_vol, reversal_5d

FOUR of the five imported literature factors FAILED to replicate here (near_52w_high,
low_beta, low_idio_vol all insignificant; low_max_ret significantly INVERTED). Do not assume
a US-published factor transfers to this universe -- test it.

COMBINING MADE IT WORSE, EVERY TIME. This is the single most useful thing measured:
    momentum_12_1 alone                          +0.86%  t=+2.08
    momentum_12_1 + 2 exclusions (ex_lottery)    -1.25%  t=-2.69   (-2.1pp)
    momentum_12_1 long-only                      +0.86%  t=+2.08
    momentum_12_1 long/short                     +0.49%  t=+0.50   (short leg destroys it)
    8-engine unified_score blend                  IC 0.0001, t=0.02
Adding components to this dataset has reduced performance in every case tested. Prefer the
simplest thing that works; a new factor needs to beat momentum_12_1 ALONE, not add to it.

value_book_to_price: positive in all 6 cost x size configs (+0.54 to +0.99), survives 40bps
(+0.85, t=2.44), not survivorship-driven (0.933 t=2.67 with fill vs 0.857 t=2.42 without),
Sharpe 1.47 and max DD -17.9% -- better than momentum on both. Lowest turnover of any factor
that works (0.28 -> 1.65%/yr cost drag).

BOTH SURVIVING FACTORS ARE DECAYING, and this is the most important caveat on the page:
    book_to_price  2021 +1.51 | 2022 +1.53 | 2023 +1.33 | 2024 +0.66 | 2025 +0.16 | 2026 -0.06
    momentum_12_1  2022 -0.15 | 2023 +1.37 | 2024 +2.32 | 2025 +0.37 | 2026 +0.02
Two independent, canonical factors both monotonically decaying to ~zero over the last 18
months is more likely a regime/crowding effect than two coincidences. Neither clears a
multiple-testing bar across 18 tested factors (~t=3.0 needed). Size accordingly.

momentum_12_1 caveats: positive in all 9 cost x size configs and sign-consistent across all
holding periods, and NOT survivorship-driven (0.861% with fill vs 0.847% without). But t=2.08
does not survive a multiple-testing correction across 14 factors (~t=3.0 needed), and monthly
per-year excess decays (2023 +1.37, 2024 +2.32, 2025 +0.37, 2026 +0.02). Paper-trade it.

USAGE
-----
    python factor_backtest.py --factor all --rebalance 21 --cost-bps 25
    python factor_backtest.py --factor momentum_12_1 --picks --top-k 25
    python factor_backtest.py --factor momentum_12_1 --cost-bps 40 --no-survivorship-fill
"""
from __future__ import annotations

import argparse
import datetime
import json
import math

import numpy as np
import pandas as pd

from db_compat import read_df, transaction

# -- Cost model -------------------------------------------------------------------
DEFAULT_COST_BPS_PER_SIDE = 25.0     # see COST MODEL above; sweep this, don't trust one value
DEFAULT_MIN_ADT = 10_000_000         # Rs 1cr average daily turnover -- the tradeable floor
DEFAULT_START = '2021-01-01'

# Per-holding-period return clamp. This is a DATA-QUALITY guard, not a risk model: a genuine
# +80% month should count, but this repo's own history includes bars implying +127,900%
# (RELIANCE 2022-06-16). is_suspect already removes the known-bad ones; this catches whatever
# slipped through. Every clamp is COUNTED and REPORTED -- a run that clamps a lot is not
# trustworthy and must say so rather than silently absorbing it into the mean.
RETURN_CLAMP_PCT = 50.0

# The configuration momentum_12_1 was actually validated at (t>2 only at K=50 and K=100).
# Below this, momentum concentrates into speculative microcaps -- a different strategy from
# the one measured, so --picks says so out loud rather than implying the backtest covers it.
VALIDATED_MIN_TOP_K = 50
THIN_LIQUIDITY_WARN = 50_000_000     # Rs 5cr ADT: below this, 25bps/side is optimistic
FACTOR_PICKS_SETTING = 'factor_picks_momentum_12_1'


# -- Factor definitions -----------------------------------------------------------
# Each takes the panel and returns a score where HIGHER = more attractive to go long.
# Keep these pure and vectorized; anything needing a DB read belongs in load_price_panel.
FACTORS = {
    'momentum_21d':  lambda d: d['r21'],
    'momentum_63d':  lambda d: d['r63'],
    'momentum_12_1': lambda d: d['r12_1'],
    'reversal_5d':   lambda d: -d['r5'],
    'reversal_21d':  lambda d: -d['r21'],
    'low_vol':       lambda d: -d['vol21'],
    'high_vol':      lambda d: d['vol21'],
    'delivery_pct':  lambda d: d['deliv_pct'],
    # Composite the 2026-07-30 audit recommended but nobody ever built or tested:
    # short-horizon reversal gated on delivery quality, avoiding the high-vol tail.
    'reversal_x_delivery': lambda d: (
        _z(-d['r5']) + _z(d['deliv_pct']) - _z(d['vol21'])
    ),

    # -- Pre-registered literature factors (2026-08-10) ---------------------------
    # These are NOT data-mined: each is a specific published result being retested on
    # Indian equities. Naming the source matters, because the multiple-testing penalty for
    # "I tried 20 things and 1 worked" does not apply the same way to "the literature
    # predicts X; does X hold here". Anything that fails here is reported as failing.
    #
    # Ang/Hodrick/Xing/Zhang (2006): high idiosyncratic vol UNDERPERFORMS. Expect negative.
    'low_idio_vol':   lambda d: -d['idio_vol'],
    # Frazzini/Pedersen (2014) Betting Against Beta: low beta wins risk-adjusted.
    'low_beta':       lambda d: -d['beta'],
    # Bali/Cakici/Whitelaw (2011) MAX: lottery demand: high max-daily-return UNDERPERFORMS.
    'low_max_ret':    lambda d: -d['max_ret_21d'],
    # George/Hwang (2004): nearness to the 52-week high often DOMINATES raw momentum.
    'near_52w_high':  lambda d: d['pct_of_52w_high'],
    # The two things this dataset actually supports, combined: the only factor with positive
    # cost-adjusted excess (momentum_12_1) with the two robustly-negative tails removed.
    # Deliberately equal-weighted -- fitting the blend weights on 65 observations would be
    # exactly the overfit this repo has been burned by before.
    'momentum_ex_lottery': lambda d: (
        _z(d['r12_1']) - _z(d['max_ret_21d']) - _z(d['vol21'])
    ),

    # -- Value (2026-08-10). Fama-French HML is book-to-market; Basu (1977) is earnings yield.
    # Testable after all -- see _add_valuation's correction note.
    'value_earnings_yield': lambda d: d['earnings_yield'],
    'value_book_to_price': lambda d: d['book_to_price'],
    'value_composite':     lambda d: _z(d['earnings_yield']) + _z(d['book_to_price']),
    # Value + momentum is THE canonical pair because the two are negatively correlated, so the
    # combination diversifies rather than concentrates. This is the one composite with a prior
    # reason to expect it beats its parts -- every other combination tested here made things
    # worse, so it is stated as a hypothesis to be tested, not an assumption.
    'value_x_momentum':    lambda d: (
        _z(d['earnings_yield']) + _z(d['book_to_price']) + _z(d['r12_1'])
    ),
}


def _z(s: pd.Series) -> pd.Series:
    """Cross-sectional z-score within the current date group (NaN-safe)."""
    sd = s.std()
    if not sd or not np.isfinite(sd) or sd == 0:
        return pd.Series(0.0, index=s.index)
    return (s - s.mean()) / sd


# -- Panel construction -----------------------------------------------------------
def load_price_panel(start: str = DEFAULT_START,
                     end: str | None = None,
                     min_adt: float = DEFAULT_MIN_ADT,
                     survivorship_fill: bool = True) -> pd.DataFrame:
    """Daily panel with features + the NEXT session's open (the tradeable entry price).

    Returns one row per (symbol, date) with: open, close, next_open, adt20, r5/r21/r63/r12_1,
    vol21, deliv_pct. Rows without a next_open (the final bar of a symbol's life) are kept --
    they are legitimately untradeable and get dropped at portfolio-formation time.
    """
    end = end or datetime.date.today().isoformat()

    px = read_df(
        "SELECT symbol, date, open, close, volume FROM stock_ohlcv "
        "WHERE date >= ? AND date <= ? AND COALESCE(is_suspect,0)=0 AND close > 0 AND open > 0",
        (start, end),
    )
    if px.empty:
        raise RuntimeError(f"no stock_ohlcv rows in {start}..{end}")
    px['date'] = pd.to_datetime(px['date']).dt.strftime('%Y-%m-%d')
    n_base = px['symbol'].nunique()

    if survivorship_fill:
        px = _fill_delisted(px, start, end)
    filled = px['symbol'].nunique() - n_base
    print(f"[FactorBacktest] price panel: {px['symbol'].nunique()} symbols "
          f"({n_base} from stock_ohlcv + {filled} survivorship-filled), {len(px):,} bars")

    # Official NSE delivery % -- a genuinely independent (non-price) factor that this platform
    # collects and has never tested. Left NaN where bhavcopy has no row; never zero-filled,
    # since 0% delivery is a real and very different statement from "unknown".
    deliv = read_df(
        "SELECT symbol, date, deliv_pct FROM nse_universe_history "
        "WHERE date >= ? AND date <= ? AND deliv_pct IS NOT NULL",
        (start, end),
    )
    if not deliv.empty:
        deliv['date'] = pd.to_datetime(deliv['date']).dt.strftime('%Y-%m-%d')
        px = px.merge(deliv, on=['symbol', 'date'], how='left')
    else:
        px['deliv_pct'] = np.nan

    px = px.sort_values(['symbol', 'date']).reset_index(drop=True)
    g = px.groupby('symbol', sort=False)

    px['next_open'] = g['open'].shift(-1)          # entry/exit price: no same-bar look-ahead
    px['turnover'] = px['close'] * px['volume']

    # .rolling() on the GroupBy, not .transform(lambda s: s.rolling(...)): the lambda form
    # runs a Python call per group and takes minutes over 3,400 symbols x 5 years. Same result.
    px['adt20'] = g['turnover'].rolling(20, min_periods=10).mean().reset_index(level=0, drop=True)

    for lag, col in ((5, 'c5'), (21, 'c21'), (63, 'c63'), (252, 'c252')):
        px[col] = g['close'].shift(lag)
    px['r5'] = (px['close'] / px['c5'] - 1) * 100
    px['r21'] = (px['close'] / px['c21'] - 1) * 100
    px['r63'] = (px['close'] / px['c63'] - 1) * 100
    px['r12_1'] = (px['c21'] / px['c252'] - 1) * 100      # 12-1: skip the reversal month
    px['_dr'] = g['close'].pct_change()
    px['vol21'] = (px.groupby('symbol', sort=False)['_dr']
                     .rolling(20, min_periods=10).std()
                     .reset_index(level=0, drop=True)) * 100

    gs = px.groupby('symbol', sort=False)
    # MAX (Bali/Cakici/Whitelaw): the single largest daily return in the trailing month.
    px['max_ret_21d'] = (gs['_dr'].rolling(21, min_periods=10).max()
                           .reset_index(level=0, drop=True)) * 100
    # George/Hwang: where the price sits within its own 52-week range (1.0 = at the high).
    px['_hi252'] = gs['close'].rolling(252, min_periods=120).max().reset_index(level=0, drop=True)
    px['pct_of_52w_high'] = px['close'] / px['_hi252']

    px = _add_valuation(px, start, end)
    px = _add_beta_and_idio_vol(px)
    px = px.drop(columns=['_dr', '_hi252', '_mkt'], errors='ignore')

    px['eligible'] = (px['adt20'] >= min_adt) & px['next_open'].notna() & (px['next_open'] > 0)
    print(f"[FactorBacktest] eligible (>=Rs {min_adt/1e7:.0f}cr ADT & tradeable next open): "
          f"{int(px['eligible'].sum()):,} symbol-days")
    return px


def _add_valuation(px: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """Daily cross-sectional P/E and P/B from trendlyne_*_history.

    CORRECTION (2026-08-10): an earlier pass concluded "no fundamental history exists" after
    checking only fundamentals_history / historical_fundamentals / stock_fundamentals /
    tl_financial_quality / quant_scores -- all of which do start 2026-06-30. It never looked
    for trendlyne_pe_history / trendlyne_pb_history, which carry ~2.3M rows over 2,325 symbols
    and 1,384 daily dates covering the ENTIRE price window. Value factors are testable.

    CAVEAT that must travel with any result from these columns: fetched_at spans only
    2026-06-30..2026-08-08, so this is the vendor's CURRENT view of history, backfilled -- not
    a series accumulated day by day. If Trendlyne restates trailing EPS after the fact, the
    historical P/E embeds the restatement. That is the standard situation with vendor history
    and is not disqualifying, but it is NOT the same guarantee as observing daily and storing
    immutably (which is precisely what the rebuild's bitemporal store exists to provide).
    """
    for tbl, col in (("trendlyne_pe_history", "pe_ttm"), ("trendlyne_pb_history", "pb_ratio")):
        try:
            df = read_df(
                f"SELECT symbol, date, {col} FROM {tbl} "
                f"WHERE date >= ? AND date <= ? AND {col} IS NOT NULL",
                (start, end),
            )
        except Exception as e:                                  # noqa: BLE001
            print(f"[FactorBacktest] WARNING: {tbl} unavailable ({str(e)[:80]}); "
                  "value factors will be skipped.")
            px[col] = np.nan
            continue
        if df.empty:
            px[col] = np.nan
            continue
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        px = px.merge(df, on=["symbol", "date"], how="left")

    # E/P and B/P rather than P/E and P/B: the reciprocal is the well-behaved form. A P/E near
    # zero explodes; the yield form keeps loss-making firms ranked at the BOTTOM (negative
    # yield) instead of at the top, which is what a raw 1/PE sort on a negative denominator
    # would do. 17.6% of rows are loss-making, so this is not an edge case.
    px["earnings_yield"] = np.where(px["pe_ttm"].abs() > 1e-6, 1.0 / px["pe_ttm"], np.nan)
    px["book_to_price"] = np.where(px["pb_ratio"].abs() > 1e-6, 1.0 / px["pb_ratio"], np.nan)
    n_ey = int(px["earnings_yield"].notna().sum())
    print(f"[FactorBacktest] valuation: earnings_yield on {n_ey:,} rows, "
          f"book_to_price on {int(px['book_to_price'].notna().sum()):,}")
    return px


BETA_WINDOW = 252
BETA_MIN_OBS = 120


def _add_beta_and_idio_vol(px: pd.DataFrame) -> pd.DataFrame:
    """Rolling market beta and idiosyncratic vol vs NIFTY50.

    Computed from rolling cov/var rather than an explicit per-symbol regression -- same
    numbers, and a real regression over 3,400 symbols x 5 years would take minutes:
        beta      = cov(r_i, r_m) / var(r_m)
        idio_vol  = sqrt(max(0, var(r_i) - beta^2 * var(r_m)))
    Both NaN where the market series is missing; NaN is treated as "no signal" by the
    factor loop rather than being filled, so a symbol is dropped from those factors only.
    """
    mkt = px.loc[px['symbol'] == 'NIFTY50', ['date', '_dr']].rename(columns={'_dr': '_mkt'})
    if mkt.empty or mkt['_mkt'].notna().sum() < BETA_MIN_OBS:
        print('[FactorBacktest] WARNING: no NIFTY50 series -- beta / idio_vol unavailable, '
              'the factors using them will be skipped.')
        px['beta'] = np.nan
        px['idio_vol'] = np.nan
        return px

    px = px.merge(mkt, on='date', how='left')
    px['_xy'] = px['_dr'] * px['_mkt']

    # Sample covariance via rolling SUMS rather than .rolling().cov():
    #     cov = (sum(xy) - sum(x)sum(y)/n) / (n-1)
    # Identical to pandas' ddof=1 result, but .rolling().cov() builds a MultiIndex covariance
    # matrix per window and then needs an .unstack() over 3M rows -- minutes vs seconds here.
    def _roll(col, how):
        r = px.groupby('symbol', sort=False)[col].rolling(BETA_WINDOW, min_periods=BETA_MIN_OBS)
        return getattr(r, how)().reset_index(level=0, drop=True)

    n = _roll('_dr', 'count')
    s_xy, s_x, s_y = _roll('_xy', 'sum'), _roll('_dr', 'sum'), _roll('_mkt', 'sum')
    cov = (s_xy - s_x * s_y / n) / (n - 1)
    var_m = _roll('_mkt', 'var')
    var_i = _roll('_dr', 'var')
    px['beta'] = cov / var_m.replace(0, np.nan)
    resid_var = var_i - px['beta'] ** 2 * var_m
    px['idio_vol'] = np.sqrt(resid_var.clip(lower=0)) * 100
    # NIFTY50 is a market proxy, not an investable constituent of this cross-section.
    px = px[px['symbol'] != 'NIFTY50']
    return px


def _fill_delisted(px: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """Add symbols that traded but are absent from stock_ohlcv (delisted/renamed).

    Reuses Backtester.load_bhavcopy_adjusted rather than UNIONing raw bhavcopy: bhavcopy is
    UNADJUSTED, so a naive union would fake a gap-down on every split. Failure here degrades
    to a survivorship-biased panel WITH A LOUD WARNING rather than aborting the run.
    """
    try:
        universe = read_df(
            "SELECT DISTINCT symbol FROM nse_universe_history "
            "WHERE date >= ? AND date <= ? AND series IN ('EQ','BE')",
            (start, end),
        )
        missing = sorted(set(universe['symbol']) - set(px['symbol'].unique()))
        if not missing:
            return px
        from backtester import Backtester
        bt = Backtester()
        try:
            extra = bt.load_bhavcopy_adjusted(missing, start, end)
        finally:
            bt.close()
        if extra is None or extra.empty:
            return px
        extra = extra.copy()
        extra['date'] = pd.to_datetime(extra['date']).dt.strftime('%Y-%m-%d')
        keep = [c for c in ('symbol', 'date', 'open', 'close', 'volume') if c in extra.columns]
        return pd.concat([px, extra[keep]], ignore_index=True)
    except Exception as e:                                  # noqa: BLE001
        print(f"[FactorBacktest] WARNING: survivorship fill FAILED ({str(e)[:110]}). "
              "Results are survivorship-biased and will read optimistic -- do not compare them "
              "against a filled run.")
        return px


# -- Simulation -------------------------------------------------------------------
def index_by_date(panel: pd.DataFrame) -> dict:
    """Group the eligible panel by date once. Reuse across factors in a sweep."""
    return {d: g for d, g in panel[panel['eligible']].groupby('date', sort=False)}


def run_backtest(panel: pd.DataFrame,
                 factor: str,
                 rebalance_days: int = 21,
                 top_k: int = 50,
                 cost_bps_per_side: float = DEFAULT_COST_BPS_PER_SIDE,
                 long_short: bool = False,
                 by_date: dict | None = None) -> dict:
    """Equal-weight top-K portfolio, rebalanced every `rebalance_days` SESSIONS.

    Rebalance cadence is counted in trading sessions, not calendar days, so holidays cannot
    silently shorten a holding period.

    Pass `by_date` (from index_by_date) when sweeping many factors over one panel -- the
    per-date grouping is the expensive step and is identical across factors.
    """
    if factor not in FACTORS:
        raise KeyError(f"unknown factor {factor!r}; known: {sorted(FACTORS)}")
    score_fn = FACTORS[factor]

    dates = sorted(panel.loc[panel['eligible'], 'date'].unique())
    if len(dates) < rebalance_days * 3:
        raise RuntimeError(f"only {len(dates)} eligible sessions; need >= {rebalance_days*3}")
    rebal_dates = dates[::rebalance_days]

    if by_date is None:
        by_date = index_by_date(panel)

    prev_w: dict[str, float] = {}
    periods: list[dict] = []
    clamped = 0

    for i in range(len(rebal_dates) - 1):
        d0, d1 = rebal_dates[i], rebal_dates[i + 1]
        cur = by_date.get(d0)
        if cur is None or len(cur) < top_k * 2:
            continue

        scored = cur.assign(_s=score_fn(cur)).dropna(subset=['_s', 'next_open'])
        if len(scored) < top_k * 2:
            continue
        scored = scored.sort_values('_s', ascending=False)

        longs = scored.head(top_k)['symbol'].tolist()
        shorts = scored.tail(top_k)['symbol'].tolist() if long_short else []

        w = {s: 1.0 / len(longs) for s in longs}
        if long_short:
            for s in shorts:
                w[s] = w.get(s, 0.0) - 1.0 / len(shorts)

        # Turnover = sum|dw| over the union. Full replacement -> 2.0 -> exactly one round trip.
        traded = sum(abs(w.get(s, 0.0) - prev_w.get(s, 0.0)) for s in set(w) | set(prev_w))
        cost = traded * cost_bps_per_side / 10_000.0

        entry = cur.set_index('symbol')['next_open']
        nxt = by_date.get(d1)
        if nxt is None:
            continue
        exit_px = nxt.set_index('symbol')['next_open']

        gross = 0.0
        for s, wt in w.items():
            e, x = entry.get(s), exit_px.get(s)
            if e is None or x is None or not (np.isfinite(e) and np.isfinite(x)) or e <= 0:
                # Position could not be exited at the next rebalance (delisted mid-period).
                # Treated as flat rather than dropped, so a name going dark is not silently
                # excluded from the P&L -- that is precisely the survivorship hole.
                continue
            r = (x / e - 1) * 100
            if abs(r) > RETURN_CLAMP_PCT:
                clamped += 1
                r = math.copysign(RETURN_CLAMP_PCT, r)
            gross += wt * r

        uni = ((exit_px / entry - 1) * 100).replace([np.inf, -np.inf], np.nan).dropna()
        uni = uni.clip(-RETURN_CLAMP_PCT, RETURN_CLAMP_PCT)

        periods.append({
            'date': d0,
            'gross_pct': gross,
            'cost_pct': cost * 100,
            'net_pct': gross - cost * 100,
            'universe_pct': float(uni.mean()) if len(uni) else np.nan,
            'turnover': traded / 2.0,        # one-way turnover, the conventional quote
            'n_names': len(w),
        })
        prev_w = w

    if not periods:
        raise RuntimeError('no completed rebalance periods -- widen the window or lower --top-k')
    return _summarize(pd.DataFrame(periods), factor, rebalance_days, top_k,
                      cost_bps_per_side, long_short, clamped)


def _summarize(df: pd.DataFrame, factor: str, rebalance_days: int, top_k: int,
               cost_bps: float, long_short: bool, clamped: int) -> dict:
    per_yr = 252.0 / rebalance_days
    net, uni = df['net_pct'], df['universe_pct']
    excess = (net - uni).dropna()

    def t_stat(s: pd.Series) -> float:
        s = s.dropna()
        if len(s) < 2 or s.std() == 0:
            return float('nan')
        return float(s.mean() / (s.std() / math.sqrt(len(s))))

    curve = (1 + net / 100).cumprod()
    dd = float((curve / curve.cummax() - 1).min() * 100)
    yrs = len(df) / per_yr
    cagr = float((curve.iloc[-1] ** (1 / yrs) - 1) * 100) if yrs > 0 and curve.iloc[-1] > 0 else float('nan')
    sharpe = (float(net.mean() / net.std() * math.sqrt(per_yr))
              if net.std() and net.std() > 0 else float('nan'))

    # Per-calendar-year excess. A factor that is real should not depend on one good year;
    # this is the cheapest check that separates a genuine effect from a lucky sub-period, and
    # it matters most for exactly the marginal |t|~2 results that are otherwise tempting.
    yr = df.assign(_y=pd.to_datetime(df['date']).dt.year,
                   _x=df['net_pct'] - df['universe_pct']).groupby('_y')['_x']
    by_year = {int(y): round(float(v), 3) for y, v in yr.mean().items()}
    years_positive = sum(1 for v in by_year.values() if v > 0)

    return {
        'factor': factor,
        'long_short': long_short,
        'excess_by_year_pct': by_year,
        'years_positive': f"{years_positive}/{len(by_year)}",
        'rebalance_days': rebalance_days,
        'top_k': top_k,
        'cost_bps_per_side': cost_bps,
        'periods': int(len(df)),
        'years': round(yrs, 2),
        'gross_per_period_pct': round(float(df['gross_pct'].mean()), 4),
        'cost_per_period_pct': round(float(df['cost_pct'].mean()), 4),
        'net_per_period_pct': round(float(net.mean()), 4),
        'universe_per_period_pct': round(float(uni.mean()), 4),
        'net_excess_vs_universe_pct': round(float(excess.mean()), 4),
        'excess_t_stat': round(t_stat(excess), 2),
        'pct_periods_beating_universe': round(float((excess > 0).mean() * 100), 1),
        'avg_oneway_turnover': round(float(df['turnover'].mean()), 3),
        'annual_cost_drag_pct': round(float(df['cost_pct'].mean() * per_yr), 2),
        'cagr_net_pct': round(cagr, 2),
        'sharpe_net': round(sharpe, 2),
        'max_drawdown_pct': round(dd, 2),
        'clamped_returns': clamped,
        '_periods_df': df,
    }


def _print(r: dict) -> None:
    ls = ' [LONG/SHORT]' if r['long_short'] else ''
    print(f"\n{'='*78}\n{r['factor']}{ls}  |  rebalance {r['rebalance_days']}d  |  "
          f"top-{r['top_k']}  |  {r['cost_bps_per_side']:.0f}bps/side\n{'='*78}")
    for k in ('periods', 'years', 'gross_per_period_pct', 'cost_per_period_pct',
              'net_per_period_pct', 'universe_per_period_pct', 'net_excess_vs_universe_pct',
              'excess_t_stat', 'pct_periods_beating_universe', 'avg_oneway_turnover',
              'annual_cost_drag_pct', 'cagr_net_pct', 'sharpe_net', 'max_drawdown_pct',
              'years_positive'):
        print(f"  {k:<32} {r[k]}")
    print(f"  {'excess_by_year_pct':<32} {r['excess_by_year_pct']}")
    if r['clamped_returns']:
        print(f"  {'clamped_returns':<32} {r['clamped_returns']}  <-- data-quality guard fired")
    t = r['excess_t_stat']
    if not (isinstance(t, float) and math.isnan(t)) and abs(t) < 2.0:
        print(f"\n  VERDICT: NOT significant (|t|={abs(t):.2f} < 2). Do not trade this.")
    elif r['net_excess_vs_universe_pct'] <= 0:
        print("\n  VERDICT: significant but NEGATIVE net of costs. Useful only as an exclusion.")
    else:
        print("\n  VERDICT: positive and significant net of costs -- worth a live paper test.")


def todays_picks(panel: pd.DataFrame, factor: str, top_k: int = 50) -> pd.DataFrame:
    """The top-K names by `factor` on the most recent eligible date.

    Same scoring path the backtest uses, so what you see here is exactly what was measured --
    no second implementation to drift. Entry price is the NEXT session's open, which is why
    `next_open` may be blank on the newest bar: that name is not yet tradeable.
    """
    if factor not in FACTORS:
        raise KeyError(f"unknown factor {factor!r}; known: {sorted(FACTORS)}")
    eligible = panel[panel['eligible']]
    if eligible.empty:
        raise RuntimeError('no eligible rows in panel')
    last = eligible['date'].max()
    cur = eligible[eligible['date'] == last].copy()
    cur['score'] = FACTORS[factor](cur)
    cur = cur.dropna(subset=['score']).sort_values('score', ascending=False).head(top_k)

    # Two ways this list can mislead someone who skips the docstring, both worth shouting about.
    if top_k < VALIDATED_MIN_TOP_K:
        print(f"[FactorBacktest] WARNING: top-{top_k} is NARROWER than the validated range "
              f"({VALIDATED_MIN_TOP_K}-100). Momentum concentrates into speculative microcaps at "
              "small K, and that configuration was NOT the one measured. Widen K or treat this "
              "as a watchlist, not a portfolio.")
    thin = cur[cur['adt20'] < THIN_LIQUIDITY_WARN] if 'adt20' in cur.columns else cur.iloc[:0]
    if len(thin):
        print(f"[FactorBacktest] WARNING: {len(thin)} of {len(cur)} names sit under "
              f"Rs {THIN_LIQUIDITY_WARN/1e7:.0f}cr ADT ({', '.join(thin['symbol'].head(8))}). "
              "The backtest's cost model assumes you are small relative to daily turnover; at "
              "this liquidity real slippage will exceed the 25bps/side assumed.")

    cols = ['symbol', 'date', 'close', 'next_open', 'score', 'r12_1', 'vol21', 'adt20']
    return cur[[c for c in cols if c in cur.columns]].reset_index(drop=True)


def factor_picks_payload(picks: pd.DataFrame, factor: str) -> dict:
    if picks.empty:
        raise RuntimeError('cannot persist an empty factor-picks snapshot')
    rows = []
    for row in picks.to_dict(orient='records'):
        clean = {}
        for key, value in row.items():
            if pd.isna(value):
                continue
            clean[key] = (
                value.isoformat() if hasattr(value, 'isoformat')
                else float(value) if isinstance(value, (np.floating, np.integer))
                else value
            )
        rows.append(clean)
    return {
        'factor': factor,
        'asOf': str(picks['date'].iloc[0])[:10],
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'validatedTopKMin': VALIDATED_MIN_TOP_K,
        'evidence': 'paper_trade_candidate',
        'caveat': 'Research screen only; not the canonical Alpha score or a buy recommendation.',
        'picks': rows,
    }


def persist_factor_picks(picks: pd.DataFrame, factor: str) -> dict:
    payload = factor_picks_payload(picks, factor)
    with transaction() as tx:
        tx.execute(
            'INSERT INTO app_settings (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            (FACTOR_PICKS_SETTING, json.dumps(payload)),
        )
    return payload


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--factor', default='all', help=f"one of {sorted(FACTORS)} or 'all'")
    p.add_argument('--start', default=DEFAULT_START)
    p.add_argument('--end', default=None)
    p.add_argument('--rebalance', type=int, default=21, help='trading sessions between rebalances')
    p.add_argument('--top-k', type=int, default=50)
    p.add_argument('--cost-bps', type=float, default=DEFAULT_COST_BPS_PER_SIDE)
    p.add_argument('--min-adt', type=float, default=DEFAULT_MIN_ADT)
    p.add_argument('--long-short', action='store_true')
    p.add_argument('--no-survivorship-fill', action='store_true',
                   help='measure the survivorship bias by leaving delisted names out')
    p.add_argument('--json', action='store_true')
    p.add_argument('--picks', action='store_true',
                   help="print today's top-K names for --factor instead of backtesting")
    p.add_argument('--persist-picks', action='store_true',
                   help='persist --picks output for cheap API/UI reads')
    a = p.parse_args()

    panel = load_price_panel(a.start, a.end, a.min_adt, not a.no_survivorship_fill)

    if a.picks or a.persist_picks:
        if a.factor == 'all':
            p.error("--picks/--persist-picks needs a specific --factor, not 'all'")
        picks = todays_picks(panel, a.factor, a.top_k)
        if a.persist_picks:
            payload = persist_factor_picks(picks, a.factor)
            print(json.dumps({'success': True, 'setting': FACTOR_PICKS_SETTING, 'count': len(payload['picks']), 'asOf': payload['asOf']}))
            return
        print(f"\n=== top {len(picks)} by {a.factor} as of {picks['date'].iloc[0]} ===")
        print(picks.to_string(index=False))
        print("\nEntry is the NEXT session's open. Single-factor, marginal evidence "
              "(see this module's docstring) -- paper-trade before committing capital.")
        return

    by_date = index_by_date(panel)          # grouped once, reused by every factor
    factors = sorted(FACTORS) if a.factor == 'all' else [a.factor]

    out = []
    for f in factors:
        try:
            r = run_backtest(panel, f, a.rebalance, a.top_k, a.cost_bps, a.long_short,
                             by_date=by_date)
        except Exception as e:                              # noqa: BLE001
            print(f"[FactorBacktest] {f}: FAILED -- {e}")
            continue
        out.append(r)
        if not a.json:
            _print(r)

    if a.json:
        print(json.dumps([{k: v for k, v in r.items() if not k.startswith('_')} for r in out],
                         indent=2, default=str))
    elif len(out) > 1:
        cols = ['factor', 'net_excess_vs_universe_pct', 'excess_t_stat', 'net_per_period_pct',
                'avg_oneway_turnover', 'annual_cost_drag_pct', 'sharpe_net', 'max_drawdown_pct']
        print(f"\n{'='*78}\nRANKED BY NET EXCESS vs UNIVERSE\n{'='*78}")
        print(pd.DataFrame([{c: r[c] for c in cols} for r in out])
              .sort_values('net_excess_vs_universe_pct', ascending=False)
              .to_string(index=False))
        print("\nNothing with |t| < 2 is evidence of anything. Sweep --cost-bps before "
              "acting on a result that sits near break-even.")


if __name__ == '__main__':
    main()
