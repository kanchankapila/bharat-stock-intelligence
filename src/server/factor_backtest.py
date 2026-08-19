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
import sys

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

# Missing-exit convention (2026-08-10). A position whose next-rebalance price is absent used to
# contribute exactly 0% to the strategy while being silently DROPPED from the benchmark two
# lines later -- two different conventions for the same event, in adjacent statements, and the
# one applied to the strategy was the optimistic one. Both legs now use this single figure.
# -100 is the conservative bound (the name is written off, which is what a delisting is); a
# data gap gets punished the same way on both sides, so the comparison stays honest either way.
# Deliberately NOT subject to RETURN_CLAMP_PCT -- the clamp is a bad-bar guard for *observed*
# prices, and clamping a write-off to -50% would quietly re-introduce the optimism. Sweep it
# with --missing-exit-pct; every occurrence is counted and reported so the sensitivity is
# visible rather than assumed.
MISSING_EXIT_PCT = -100.0

# Vendor value history is a recent backfill, not an observed point-in-time series (see
# _add_valuation). A restated trailing EPS silently rewrites the past, so these are barred
# from the persisted paper screen until that sensitivity is quantified. --allow-provisional
# overrides, loudly.
PROVISIONAL_FACTORS = frozenset({
    'value_earnings_yield', 'value_book_to_price', 'value_composite', 'value_x_momentum',
    # Whole 5-year series backfilled in one 2026-08-11 call, so every historical score is a
    # present-day recomputation. Strictly worse than the valuation case above, which at least
    # accumulates forward. See _add_mojo_indigraph.
    'mojo_indigraph',
})

# The configuration momentum_12_1 was actually validated at (t>2 only at K=50 and K=100).
# Below this, momentum concentrates into speculative microcaps -- a different strategy from
# the one measured, so --picks says so out loud rather than implying the backtest covers it.
VALIDATED_MIN_TOP_K = 50
THIN_LIQUIDITY_WARN = 50_000_000     # Rs 5cr ADT: below this, 25bps/side is optimistic
FACTOR_PICKS_PREFIX = 'factor_picks_'
# The two factors with positive, cost-adjusted, survivorship-free evidence (see RESULTS in the
# module docstring). value_book_to_price is listed first because it is the STRONGER of the two
# on every axis measured -- t 2.67 vs 2.08, Sharpe 1.47 vs 1.10, turnover 0.28 vs 0.35 (1.65%
# vs 2.10% annual cost drag) and max drawdown -17.9% vs -19.5%. Both are DECAYING; that caveat
# travels with the payload and must stay in front of anyone reading these picks.
PERSISTED_PICK_FACTORS = ('value_book_to_price', 'momentum_12_1')


# -- Factor definitions -----------------------------------------------------------
# Each takes the panel and returns a score where HIGHER = more attractive to go long.
# Keep these pure and vectorized; anything needing a DB read belongs in load_price_panel.
# feature_store columns tested as candidate factors (2026-08-12). Pre-registered before running
# -- see the exclusions below, decided by inspection of the schema, not by which ones looked good.
# Excluded and why: ret_*/ret_12m_ex1m/sma*/ema*/vwap/obv/atr_14/bb_upper/bb_lower/macd/
# macd_signal (raw un-normalised levels or already-covered by momentum_*/reversal_* factors
# above); rsi_14/rsi_28/bb_pct (near-duplicates of the panel's OWN rsi14/bb_pos, already tested
# as screener_overbought/oversold/below_lower_bb); above_sma200 (binary, dominated by the
# continuous dist_sma200_pct below); pcr_oi/pcr_vol (100% NULL, see measurement-history.md);
# delivery_pct (duplicate of the already-tested raw factor); trend_1d/1w/1m/vol_regime (text,
# not numeric); nifty_vix/nifty_pe/advance_decline_ratio/nifty_ret_*/us_10y_yield/dxy/
# crude_ret_5d/gold_ret_5d/sp500_ret_5d (market-level -- identical value for every symbol on a
# date, zero cross-sectional variance, a category error as a stock-selection factor, same
# finding as macro_asset_prices in measurement-history.md); target_ret_*/target_dir_* (these ARE
# the forward-return labels, not features -- testing them would be pure look-ahead).
FEATURE_STORE_FACTORS = [
    'dist_sma20_pct', 'dist_sma200_pct', 'macd_hist', 'adx', 'di_plus', 'di_minus',
    'stoch_k', 'stoch_d', 'cci', 'williams_r', 'atr_pct', 'bb_width',
    'volume_ratio_20d', 'volume_ratio_5d', 'obv_slope', 'vwap_dist_pct', 'mtf_alignment_score',
    'debt_to_equity', 'roe', 'op_margins', 'rev_growth', 'eps_growth', 'piotroski_f',
    'news_sentiment_score', 'news_impact_count',
]

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

    # -- The platform's own differentiated data (2026-08-10) ----------------------
    # Everything above is computable by anyone with a price feed and a valuation vendor. These
    # are the datasets this platform collects that most screens do not have, and that have
    # enough history to actually test (insider 11y, bhavcopy delivery 5y). Until now they were
    # only ever consumed by the 39-day ranker, where nothing is statistically measurable.
    # Lakonishok/Lee (2001): insider trading predicts, concentrated in smaller firms.
    'insider_net':      lambda d: d['insider_net'],

    # -- feature_store technical/fundamental/news columns (2026-08-12), pre-registered as raw
    # values (no assumed sign -- these are exploratory, not literature-backed like the block
    # above). See FEATURE_STORE_FACTORS / _add_feature_store for the exclusion rationale.
    **{f'fs_{c}': (lambda d, c=c: d[c]) for c in FEATURE_STORE_FACTORS},

    # -- PEAD (post-earnings-announcement drift), pre-registered (2026-08-13). Bernard/Thomas
    # (1989): stocks whose most recent result beat estimates continue drifting UP for weeks;
    # misses continue drifting down. pead_model.py's own compute_pead_score() is NOT usable --
    # its two required inputs (eps_growth_yoy/eps_growth_qoq) are effectively 100% NULL across
    # the entire panel (measured live: 0 populated on all but the 2 most recent dates, out of
    # ~2,150-2,200 symbols/day) -- dead schema, same shape as feature_store's rev_growth/
    # eps_growth pair. earnings_category_yoy/_qoq (mc_earnings_fetcher.py's
    # _backfill_rapid_features, BP=+2/PT=+1/LR=0/WP=-1/NT=-2) are the only genuinely populated
    # (~88-90% of symbols daily, 60+ days deep) earnings-surprise signal on this panel, so that
    # is what gets tested here, not pead_score.
    'earnings_beat_yoy': lambda d: d['earnings_category_yoy'],
    'earnings_beat_qoq': lambda d: d['earnings_category_qoq'],

    # -- Contested SCREENER families, reconstructed from price so their direction is
    # MEASURED rather than read off the screener's wording. Each is signed so that a
    # POSITIVE net excess means "this screener family is bullish".
    # A: does being overbought predict up or down? (mean-reversion vs momentum)
    'screener_overbought': lambda d: d['rsi14'],
    'screener_oversold':   lambda d: -d['rsi14'],
    # B: does sitting near the 52-week low predict up (cheap) or down (breaking down)?
    'screener_near_52w_low': lambda d: d['prox_52w_low'],
    # C: does trading below the lower Bollinger band predict up (snap-back) or down?
    'screener_below_lower_bb': lambda d: -d['bb_pos'],
    # D: the one screener setup measurement.md records as significantly POSITIVE (unlike A/C
    # above) -- reconstructed from price so it gets the same test as the rest of this family
    # instead of resting on the screener-membership read. Signed like screener_oversold: top-K
    # selects the MOST-gapped-down names, so positive net excess means "gap-down is bullish".
    'gap_down': lambda d: -d['gap_pct'],
    'gap_up':   lambda d: d['gap_pct'],
    # The level of delivery % was already tested and failed. These are the CHANGE forms.
    'delivery_spike':   lambda d: d['deliv_spike'],
    'delivery_trend':   lambda d: d['deliv_trend'],
    'ticket_size':      lambda d: d['ticket_ratio'],

    # -- Vendor composite (2026-08-12) --------------------------------------------
    # MarketsMojo's own standing bullish/bearish call, graded against what actually happened.
    # See _add_mojo_indigraph for the restatement caveat -- a POSITIVE result here is
    # provisional, a NEGATIVE one is trustworthy. Signed so positive excess means "the vendor's
    # bullish call is right"; a significantly negative t means the vendor is inverted, which is
    # the answer this repo already has for its own short-horizon technical signals.
    'mojo_indigraph':   lambda d: d['mojo_indigraph'],

    # -- Industry-relative (sector-neutral) forms, 2026-08-12 ---------------------
    # PRE-REGISTERED: these four, at 21d rebalance / top-50 / 25bps, decided before looking at
    # any result. Written down because "I tried 4" and "I tried 40 and show you 4" need
    # different multiple-testing bars and only the first is defensible.
    #
    # Hypothesis (Asness/Porter/Stevens 2000, "Predicting Stock Returns Using Industry-Relative
    # Firm Characteristics"; Asness 1997 for the momentum form): a raw cross-sectional value
    # sort is substantially a SECTOR bet -- banks and metals screen cheap on B/P structurally,
    # software never does -- so it can win or lose for reasons that have nothing to do with
    # picking the better firm. Demeaning within sector isolates the stock-selection question.
    #
    # This is a genuinely different CONSTRUCTION of an already-tested input, which is the bar
    # measurement.md sets for re-testing ("state what changed... a different construction").
    # It is not a re-run of value_book_to_price, and it is not a reweighting of the existing
    # engines, which that file rules out separately.
    # `value_book_to_price_secmapped` is not a fifth hypothesis, it is the UNIVERSE
    # CONTROL, and the comparison is invalid without it. The _sn factors score NaN wherever
    # sector is unmapped, so they pick top-50 from ~69% of the panel while their raw parents
    # pick from 100%. A smaller pool alone changes the result, so "raw beat sector-neutral"
    # could just mean "bigger pool beat smaller pool". This is the raw factor restricted to
    # exactly the _sn universe: raw-vs-this isolates the universe effect, this-vs-_sn isolates
    # neutralisation. Keep it registered -- re-deriving why the naive comparison is wrong is
    # exactly the wasted day this repo keeps paying for.
    'value_book_to_price_secmapped': lambda d: d['book_to_price'].where(d['sector'].notna()),
    'value_book_to_price_sn':  lambda d: _z_within(d['book_to_price'], d['sector']),
    'value_earnings_yield_sn': lambda d: _z_within(d['earnings_yield'], d['sector']),
    'value_composite_sn':      lambda d: (_z_within(d['earnings_yield'], d['sector'])
                                          + _z_within(d['book_to_price'], d['sector'])),
    'momentum_12_1_sn':        lambda d: _z_within(d['r12_1'], d['sector']),

    # -- Multi-screener persistence breadth (2026-08-12) --------------------------
    # See _add_screener_breadth's docstring for the full pre-registration and coverage caveat
    # (only ~2.5 months of screener_appearances history -- treat 21d-rebalance results here as
    # low-power; 5d is the primary read).
    'screener_breadth': lambda d: d['screener_breadth'],
}


def _z(s: pd.Series) -> pd.Series:
    """Cross-sectional z-score within the current date group (NaN-safe)."""
    sd = s.std()
    if not sd or not np.isfinite(sd) or sd == 0:
        return pd.Series(0.0, index=s.index)
    return (s - s.mean()) / sd


# A sector needs this many scorable names on a date before its within-sector z-score means
# anything. With 2 names the z-scores are +-0.707 by construction whatever the inputs, so a
# thin sector would inject pure noise into the top-K sort at full weight. Such groups score
# NaN (dropped from selection), never 0 -- 0 is a real, middle-of-the-pack score here, and
# coercing to it is the same "fabricate the worst/most-average value" mistake recurring-bugs.md
# flags for float(x or 0) on model output.
MIN_SECTOR_MEMBERS = 5


def _z_within(s: pd.Series, groups: pd.Series) -> pd.Series:
    """Z-score computed WITHIN each group (sector) rather than across the whole date.

    This is the industry-relative construction of Asness/Porter/Stevens (2000): a raw value
    sort largely re-expresses "which sectors are structurally cheap" (banks and metals always
    screen cheap on B/P; software never does), so the cross-sectional winner may be a sector
    bet wearing a stock-selection label. Demeaning inside the sector asks the different and
    narrower question this repo has not tested: among comparable firms, does the cheaper one
    outperform?
    """
    out = pd.Series(np.nan, index=s.index, dtype=float)
    vals = pd.to_numeric(s, errors='coerce')
    for _, idx in groups.groupby(groups, dropna=True).groups.items():
        g = vals.loc[idx]
        ok = g[np.isfinite(g)]
        if len(ok) < MIN_SECTOR_MEMBERS:
            continue
        sd = ok.std()
        if not sd or not np.isfinite(sd) or sd == 0:
            continue
        out.loc[idx] = (g - ok.mean()) / sd
    return out


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
    # num_trades/deliv_qty come along because the LEVEL of delivery % was already tested and
    # was not significant -- but a level is a stock CHARACTERISTIC (some names always deliver
    # 70%), not an event. The change against a name's own baseline is the part that could
    # carry information, and it had never been built. Same query, three more columns.
    deliv = read_df(
        "SELECT symbol, date, deliv_pct, deliv_qty, num_trades, turnover_lacs "
        "FROM nse_universe_history "
        "WHERE date >= ? AND date <= ? AND deliv_pct IS NOT NULL",
        (start, end),
    )
    if not deliv.empty:
        deliv['date'] = pd.to_datetime(deliv['date']).dt.strftime('%Y-%m-%d')
        px = px.merge(deliv, on=['symbol', 'date'], how='left')
    else:
        for c in ('deliv_pct', 'deliv_qty', 'num_trades', 'turnover_lacs'):
            px[c] = np.nan

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

    # Reconstructions of the three contested SCREENER families, so their direction can be
    # measured over 5 years of price history instead of argued from the screener's name.
    # screener_appearances only has ~50 dates, which cannot settle a directional question;
    # the underlying conditions are pure price and therefore testable over the full panel.
    px['_lo252'] = gs['close'].rolling(252, min_periods=120).min().reset_index(level=0, drop=True)
    # 1.0 = sitting exactly on the 52-week low. Used to test "near 52w low" screeners.
    px['prox_52w_low'] = px['_lo252'] / px['close']
    # Wilder RSI(14) via EWM, the standard smoothing. >70 overbought, <30 oversold.
    _d = px['close'] - gs['close'].shift(1)
    px['_up'] = _d.clip(lower=0)
    px['_dn'] = (-_d).clip(lower=0)
    gr = px.groupby('symbol', sort=False)
    _au = gr['_up'].ewm(alpha=1 / 14, adjust=False).mean().reset_index(level=0, drop=True)
    _ad = gr['_dn'].ewm(alpha=1 / 14, adjust=False).mean().reset_index(level=0, drop=True)
    px['rsi14'] = 100.0 - 100.0 / (1.0 + _au / _ad.replace(0, np.nan))
    # Position inside the 20d Bollinger band: -1 = on the lower band, +1 = on the upper.
    _ma20 = gr['close'].rolling(20, min_periods=15).mean().reset_index(level=0, drop=True)
    _sd20 = gr['close'].rolling(20, min_periods=15).std().reset_index(level=0, drop=True)
    px['bb_pos'] = (px['close'] - _ma20) / (2.0 * _sd20.replace(0, np.nan))

    # Overnight gap: today's open vs the prior session's close, as %. measurement.md flags
    # "Gap Down <= -2%" as the one significantly positive setup found anywhere in this repo
    # (every other common bullish setup -- Gap Up, breakout, volume shocker -- is inverted),
    # but it has only ever been read off the screener's own membership, never reconstructed
    # from price like screener_oversold/near_52w_low/below_lower_bb above. Doing that here
    # gives it the same 5-year, survivorship-free, cost-aware test instead of a screener-name
    # argument. Uses `open`/prior `close`, both already known before date D's own close, so
    # this needs no extra look-ahead care beyond what the harness already provides.
    px['gap_pct'] = (px['open'] / g['close'].shift(1) - 1) * 100

    # Delivery/participation CHANGE vs each name's own baseline. All three are differenced
    # against the same symbol's trailing history, so a structurally high-delivery stock scores
    # 0 unless something actually changed -- which is the whole point of differencing.
    px['deliv_spike'] = px['deliv_pct'] - (
        gs['deliv_pct'].rolling(60, min_periods=30).mean().reset_index(level=0, drop=True))
    px['deliv_trend'] = (
        gs['deliv_pct'].rolling(21, min_periods=10).mean().reset_index(level=0, drop=True)
        - gs['deliv_pct'].rolling(63, min_periods=30).mean().reset_index(level=0, drop=True))
    # Average ticket size: turnover per trade. A rise means fewer, larger orders -- the crude
    # public-data proxy for institutional participation, since this platform has no order book
    # (tick_data and order_book_snapshots are both empty).
    px['_ticket'] = (px['turnover_lacs'] * 1e5) / px['num_trades'].replace(0, np.nan)
    gt = px.groupby('symbol', sort=False)          # rebuilt: _ticket did not exist when gs was
    px['ticket_ratio'] = px['_ticket'] / (
        gt['_ticket'].rolling(60, min_periods=30).mean().reset_index(level=0, drop=True))

    px = _add_valuation(px, start, end)
    px = _add_insider(px, start, end)
    px = _add_mojo_indigraph(px, start, end)
    px = _add_sector(px)
    px = _add_beta_and_idio_vol(px)
    px = _add_screener_breadth(px)
    px = _add_feature_store(px, start, end)
    px = _add_earnings_category(px, start, end)
    px = px.drop(columns=['_dr', '_hi252', '_mkt', '_ticket'], errors='ignore')

    # TWO different eligibilities, and conflating them is what made the live screen stale:
    #   signal_eligible -- the factor and the liquidity filter are known as of this close.
    #                      True on the NEWEST bar. This is what "what do I buy" asks.
    #   eligible        -- additionally the next session's open exists, i.e. the trade can be
    #                      priced end to end. Never true on the newest bar, by construction.
    #                      This is what the BACKTEST needs and must keep using.
    # todays_picks used `eligible`, so post-close it could only ever return the PREVIOUS
    # session -- whose entry open had already traded hours earlier.
    px['signal_eligible'] = px['adt20'] >= min_adt
    px['eligible'] = px['signal_eligible'] & px['next_open'].notna() & (px['next_open'] > 0)
    print(f"[FactorBacktest] eligible (>=Rs {min_adt/1e7:.0f}cr ADT & tradeable next open): "
          f"{int(px['eligible'].sum()):,} symbol-days "
          f"({int(px['signal_eligible'].sum()):,} signal-eligible)")
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
                  "value factors will be skipped.", file=sys.stderr)
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


def _mojo_score(blob):
    """`details` JSON blob -> float score, or NaN.

    Never coerces a bad value to 0.0. A 0 is a legitimate NEUTRAL indigraph reading, so
    fabricating one on a parse failure would plant a real signal value where there is no data --
    the `float(x or 0)` class in recurring-bugs.md, made worse here because the fabricated value
    is not an obvious sentinel. NaN also has to be caught explicitly rather than via truthiness,
    since `nan or 0` evaluates to `nan`, and `json.loads` happily returns `float('nan')` for a
    bare NaN token.
    """
    try:
        v = float(json.loads(blob).get('score'))
    except (TypeError, ValueError, AttributeError, json.JSONDecodeError):
        return np.nan
    return v if math.isfinite(v) else np.nan


def _add_mojo_indigraph(px: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """MarketsMojo's own composite technical call (`indigraph`), as a continuous score.

    This is the ONE genuinely deep thing the 2026-08-11 MarketsMojo onboarding added: median 742
    dated observations PER SYMBOL over 1,792 symbols (the other four tables are 5-35 per symbol
    and cannot support a factor test). Nothing else on this platform stores a historical series
    for these indicators -- technical_signals/unified_signals hold only the latest value,
    overwritten each run -- so this is the first time a vendor's standing directional call can be
    graded against what actually happened.

    THE CAVEAT THAT MUST TRAVEL WITH ANY RESULT FROM THIS COLUMN, and it is bigger than
    _add_valuation's: the entire 5-year series arrived in a SINGLE call on 2026-08-11
    (count(distinct fetched_at) = 1). A score dated 2021 is the vendor's TODAY computation of
    2021, not what it published then. If MarketsMojo ever revised its formula, the whole history
    silently reflects the new one. Two rows in the sibling fintrend table are dated in the FUTURE
    (2026-08-14), which is direct evidence the series is generated rather than observed. So a
    POSITIVE result here is provisional and must not be traded on until a forward, point-in-time
    capture confirms it; a NEGATIVE result is trustworthy, since restatement bias would if
    anything flatter the factor. It is in PROVISIONAL_FACTORS for exactly this reason.

    The score lives in the `details` JSON blob. It is parsed in pandas rather than with a `->>`
    operator so this stays dialect-neutral (see recurring-bugs.md: Postgres-only SQL in a
    db_compat query fails silently to {} on the SQLite path rather than erroring).
    """
    try:
        df = read_df(
            "SELECT symbol, date, details FROM marketsmojo_technical_history "
            "WHERE indicator = 'indigraph' AND date >= ? AND date <= ? AND details IS NOT NULL",
            (start, end),
        )
    except Exception as e:                                          # noqa: BLE001
        print(f"[FactorBacktest] WARNING: marketsmojo_technical_history unavailable "
              f"({str(e)[:80]}); mojo factors will be skipped.", file=sys.stderr)
        px['mojo_indigraph'] = np.nan
        return px
    if df.empty:
        print("[FactorBacktest] WARNING: marketsmojo indigraph returned 0 rows; "
              "mojo factors will be skipped.")
        px['mojo_indigraph'] = np.nan
        return px

    df['mojo_indigraph'] = df['details'].map(_mojo_score)
    df = df.drop(columns=['details'])
    df = df[df['mojo_indigraph'].notna()]
    df['date'] = pd.to_datetime(df['date']).dt.strftime('%Y-%m-%d')
    # One row per (symbol, date) is the table's own PK, but a defensive dedupe keeps a vendor
    # re-issue from silently fanning out the panel on merge.
    df = df.drop_duplicates(['symbol', 'date'])
    px = px.merge(df, on=['symbol', 'date'], how='left')
    n = int(px['mojo_indigraph'].notna().sum())
    print(f"[FactorBacktest] mojo indigraph: {n:,} panel rows scored across "
          f"{px.loc[px['mojo_indigraph'].notna(), 'symbol'].nunique()} symbols")
    return px


def _add_sector(px: pd.DataFrame) -> pd.DataFrame:
    """Attach GICS-style sector from nse_stocks for the industry-relative factors.

    TWO caveats that must travel with any result computed off this column:

    1. It is a CURRENT snapshot, not point-in-time. nse_stocks has one sector per symbol with
       no effective-dated history, so a firm that reclassified is labelled by where it sits
       today, over its whole 12.6-year history. Sector membership is far more stable than
       price or fundamentals, so this is mild -- but it is a look-ahead, not zero.
    2. It is a SURVIVING-universe snapshot. Delisted names that _fill_delisted correctly keeps
       in the panel are mostly absent from nse_stocks, so they score NaN and drop out of
       selection. That does NOT reintroduce survivorship bias into the returns (the benchmark
       is computed over the eligible universe independently, and a held name that later
       delists is still exited at MISSING_EXIT_PCT), but it does mean the sector-neutral
       factors pick from a slightly more-surviving subset than the raw ones. Coverage is
       printed below so the size of that gap is visible rather than assumed.

    Industry (240 values) is deliberately NOT used: median industry has ~10 symbols across the
    whole panel and only 84 of 235 reach 8, so per-date industry groups fall under
    MIN_SECTOR_MEMBERS constantly. 14 sectors (24-454 symbols each) is the granularity this
    data actually supports.
    """
    try:
        sec = read_df("SELECT symbol, sector FROM nse_stocks WHERE sector IS NOT NULL")
    except Exception as e:                                      # noqa: BLE001
        print(f"[FactorBacktest] WARNING: nse_stocks unavailable ({str(e)[:80]}); "
              "sector-neutral factors will be skipped.", file=sys.stderr)
        px['sector'] = np.nan
        return px
    if sec.empty:
        px['sector'] = np.nan
        return px
    px = px.merge(sec.drop_duplicates('symbol'), on='symbol', how='left')
    n_sym = px['symbol'].nunique()
    n_cov = px.loc[px['sector'].notna(), 'symbol'].nunique()
    print(f"[FactorBacktest] sector: {n_cov}/{n_sym} symbols mapped "
          f"({n_cov/max(n_sym,1)*100:.1f}%), {px['sector'].nunique()} sectors")
    return px


# -- Insider ----------------------------------------------------------------------
# SEBI PIT Reg 7(2): the insider discloses to the company within 2 trading days, the company
# to the exchange within 2 more. So a transaction dated D is not public until ~D+4 trading
# days, worst case. `insider_trades.date_iso` is the TRANSACTION date, not the disclosure
# date, so using it directly would trade on information the market could not yet see. 7
# calendar days is deliberately conservative: erring long makes the factor HARDER to work,
# which is the correct direction to err when you are the one hoping it works.
INSIDER_DISCLOSURE_LAG_DAYS = 7
INSIDER_WINDOW_DAYS = 90
# Only genuine open-market transactions. ESOP allotments, gifts, pledges and inter-se
# promoter transfers are not discretionary buy/sell decisions and carry no directional view;
# including them is the most common way this factor gets built wrong. Note the double space --
# it is in the vendor data, not a typo here.
INSIDER_BUY_TYPE = 'Acquisition -  Market Purchase'
INSIDER_SELL_TYPE = 'Disposal -  Market Sale'


def _add_insider(px: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """Net open-market insider buying over a trailing window, scaled by traded value.

    COVERAGE IS THE MAIN CAVEAT and it is not small. Only 91-347 distinct symbols carry any
    filing in a given year, and `insider_transactions_fetcher.py` has a documented history of
    dying partway through the alphabet. So a zero could mean "no insider traded" (real, and
    informative) or "this fetcher never reached this symbol" (fake, and not informative), and
    the two are indistinguishable per-row. Handled by defining the factor ONLY on symbols that
    have at least one filing somewhere in the sample -- within that set a zero is a real zero.
    That makes this a test of "among covered names, does insider buying predict", which is the
    honest question the data can answer, not "does it predict across the whole universe".

    pct_transacted (% of float) would be the better scale but is populated on 261 of 50,658
    rows -- 2026 only -- so it is unusable historically. Value/ADT is the fallback.
    """
    lag = pd.Timedelta(days=INSIDER_DISCLOSURE_LAG_DAYS)
    try:
        tr = read_df(
            'SELECT symbol, date_iso, "typeOfTransaction" AS ttype, "valueInr" AS val '
            'FROM insider_trades WHERE date_iso >= ? AND date_iso <= ? '
            'AND date_iso IS NOT NULL AND "valueInr" IS NOT NULL',
            # widen the read by the lag so a filing just before `start` still lands in-window
            ((pd.Timestamp(start) - pd.Timedelta(days=INSIDER_WINDOW_DAYS + 30)).strftime('%Y-%m-%d'), end),
        )
    except Exception as e:                                      # noqa: BLE001
        print(f"[FactorBacktest] WARNING: insider_trades unavailable ({str(e)[:80]}); skipped.", file=sys.stderr)
        px['insider_net'] = np.nan
        return px

    tr = tr[tr['ttype'].isin([INSIDER_BUY_TYPE, INSIDER_SELL_TYPE])].copy()
    if tr.empty:
        px['insider_net'] = np.nan
        return px

    tr['signed'] = np.where(tr['ttype'] == INSIDER_BUY_TYPE, tr['val'], -tr['val'])
    # Shift to the date the market could first have SEEN it. A plain date+lag lands on a
    # weekend or holiday ~2/7 of the time, and an exact-date merge would then silently DROP
    # that filing -- so snap FORWARD to the first real trading day on or after visibility.
    tr['vis'] = pd.to_datetime(tr['date_iso']) + lag
    tdates = pd.DataFrame({'date': sorted(px['date'].unique())})
    tdates['_d'] = pd.to_datetime(tdates['date'])
    tr = pd.merge_asof(tr.sort_values('vis'), tdates.sort_values('_d'),
                       left_on='vis', right_on='_d', direction='forward')
    tr = tr[tr['date'].notna()]        # filings whose visibility falls past the panel end
    if tr.empty:
        px['insider_net'] = np.nan
        return px
    daily = tr.groupby(['symbol', 'date'], as_index=False)['signed'].sum()

    covered = set(tr['symbol'].unique())
    px = px.merge(daily, on=['symbol', 'date'], how='left')
    # 0 for a covered symbol on a quiet day is a REAL zero; NaN for an uncovered symbol stays
    # NaN so it is excluded from ranking rather than ranked as neutral-and-therefore-mediocre.
    is_cov = px['symbol'].isin(covered)
    px['signed'] = np.where(is_cov, px['signed'].fillna(0.0), np.nan)

    gi = px.groupby('symbol', sort=False)
    flow = gi['signed'].rolling(INSIDER_WINDOW_DAYS, min_periods=20).sum() \
                       .reset_index(level=0, drop=True)
    # Scale by the same window's median traded value so a Rs 5cr promoter buy in a smallcap
    # outranks a Rs 5cr buy in Reliance, which is the entire economic content of the signal.
    scale = gi['turnover'].rolling(INSIDER_WINDOW_DAYS, min_periods=20).median() \
                          .reset_index(level=0, drop=True)
    px['insider_net'] = np.where(is_cov & (scale > 0), flow / scale, np.nan)
    px = px.drop(columns=['signed'])
    n = int(pd.Series(px['insider_net']).notna().sum())
    print(f"[FactorBacktest] insider: {len(tr):,} open-market filings, "
          f"{len(covered)} covered symbols, insider_net on {n:,} rows "
          f"(disclosure lag {INSIDER_DISCLOSURE_LAG_DAYS}d)")
    return px


def _add_screener_breadth(px: pd.DataFrame) -> pd.DataFrame:
    """Multi-screener persistence/breadth: how many INDEPENDENT screeners (any of the 4
    providers, any sentiment label) currently have this symbol in an active membership span.

    Pre-registered 2026-08-12, before looking at any result: does a stock confirmed by many
    screeners at once carry more signal than membership on any single one? This is a genuinely
    different construction from the two adjacent things measurement.md already tested and
    rejected -- "every individual screener" (one screener at a time, 0/552 survive FDR) and
    "screener bullish consensus" (same-day agreement among BULLISH-LABELED screeners only,
    IC -0.027 t=-2.36, and the labels themselves are known-inverted). This factor ignores the
    keyword-derived sentiment label entirely and counts raw independent-source confirmation.

    screener_appearances stores MEMBERSHIP SPANS, not daily re-insertions: one row per
    (screener_id, symbol) continuous membership, with appeared_date/exited_date marking when
    it started/ended (exited_date IS NULL means still active as of the last sync). Breadth as
    of date D is the count of spans with appeared_date <= D <= COALESCE(exited_date, D),
    computed via a difference array (a +1 event on appeared_date, a -1 event the day after
    exited_date) rather than a per-row date-range join, then asof-merged onto the price panel
    per symbol.

    COVERAGE CAVEAT, and it matters here more than in most factors: the table only has 52
    distinct capture dates spanning 2026-05-30 to today (~2.5 months) -- span-filling gives
    daily-resolution breadth within that window, but the window itself is short. At 21d
    rebalance this yields only ~3-5 independent periods; treat any 21d result here as
    low-power. 5d rebalance (~10-15 periods) is the more honest primary read. Absence from
    every screener is treated as a real 0 (not NaN) for any symbol once its first screener
    event has occurred anywhere in the table -- these 4 providers run thousand-screener
    catalogs against the full liquid universe, unlike insider_trades' documented per-fetcher
    coverage gaps above, so a true absence is informative, not a missing-data artifact.
    """
    try:
        ev = read_df(
            'SELECT symbol, appeared_date, exited_date FROM screener_appearances '
            'WHERE appeared_date IS NOT NULL'
        )
    except Exception as e:                                      # noqa: BLE001
        print(f"[FactorBacktest] WARNING: screener_appearances unavailable ({str(e)[:80]}); skipped.", file=sys.stderr)
        px['screener_breadth'] = np.nan
        return px
    if ev.empty:
        px['screener_breadth'] = np.nan
        return px

    ev['appeared_date'] = pd.to_datetime(ev['appeared_date']).dt.tz_localize(None).dt.normalize()
    starts = ev[['symbol', 'appeared_date']].rename(columns={'appeared_date': 'date'})
    starts['delta'] = 1

    ended = ev[ev['exited_date'].notna()].copy()
    ended['exited_date'] = pd.to_datetime(ended['exited_date']).dt.tz_localize(None).dt.normalize()
    ends = ended[['symbol', 'exited_date']].rename(columns={'exited_date': 'date'})
    ends['date'] = ends['date'] + pd.Timedelta(days=1)   # still active ON exited_date itself
    ends['delta'] = -1

    events = pd.concat([starts, ends], ignore_index=True)
    daily = events.groupby(['symbol', 'date'], as_index=False)['delta'].sum()
    # cumsum needs symbol-then-date order, but merge_asof needs the frame sorted purely by
    # 'on' (date) -- do the cumsum on a symbol-sorted copy, then re-sort by date alone for
    # the merge itself. Both frames must satisfy merge_asof's global-by-'on' sort requirement;
    # 'by=symbol' handles the grouping, it does not relax that requirement.
    daily = daily.sort_values(['symbol', 'date'])
    daily['breadth'] = daily.groupby('symbol', sort=False)['delta'].cumsum()
    daily = daily.sort_values('date')

    px['_pxdate'] = pd.to_datetime(px['date'])
    left = px[['symbol', '_pxdate']].reset_index().rename(columns={'index': '_orig_idx'})
    left = left.sort_values('_pxdate')
    merged = pd.merge_asof(
        left, daily.rename(columns={'date': '_pxdate'}),
        on='_pxdate', by='symbol', direction='backward',
    )
    px['screener_breadth'] = merged.set_index('_orig_idx')['breadth'].reindex(px.index)
    px = px.drop(columns=['_pxdate'])

    n = int(px['screener_breadth'].notna().sum())
    n_dates = ev['appeared_date'].nunique()
    print(f"[FactorBacktest] screener_breadth: {len(ev):,} membership spans, "
          f"{n_dates} distinct capture dates, breadth defined on {n:,} panel rows")
    return px


BETA_WINDOW = 252
BETA_MIN_OBS = 120


def _add_feature_store(px: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """Merge the candidate `feature_store` technical/fundamental/news columns onto the panel.

    feature_store.date is the trading day the row's close-of-day features describe, same
    point-in-time convention as every other same-day column already on `px` (r21, vol21, ...),
    so a plain (symbol, date) merge is correct -- portfolio formation on date D still enters at
    D's next_open, same as everything else in this harness.
    """
    cols = ', '.join(FEATURE_STORE_FACTORS)
    try:
        fs = read_df(
            f"SELECT symbol, date, {cols} FROM feature_store "
            "WHERE timeframe = 'D' AND date >= ? AND date <= ?",
            (start, end),
        )
    except Exception as e:                                      # noqa: BLE001
        print(f"[FactorBacktest] WARNING: feature_store unavailable ({str(e)[:80]}); skipped.", file=sys.stderr)
        for c in FEATURE_STORE_FACTORS:
            px[c] = np.nan
        return px

    fs['date'] = pd.to_datetime(fs['date']).dt.strftime('%Y-%m-%d')
    px = px.merge(fs, on=['symbol', 'date'], how='left')
    coverage = ', '.join(f"{c}={int(px[c].notna().sum()):,}" for c in FEATURE_STORE_FACTORS)
    print(f"[FactorBacktest] feature_store: {len(fs):,} rows merged, {fs['date'].nunique()} "
          f"distinct dates. Coverage -- {coverage}")
    return px


def _add_earnings_category(px: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """Merge earnings_category_yoy/_qoq from technical_signals onto the panel.

    Same point-in-time convention as _add_feature_store: technical_signals.date is the trading
    day the row's close-of-day features describe (mc_earnings_fetcher.py's
    _backfill_rapid_features writes same-day), so a plain (symbol, date) merge is correct --
    portfolio formation on date D still enters at D's next_open like everything else in this
    harness. technical_signals.date is TEXT, not a native date column.
    """
    try:
        ec = read_df(
            "SELECT symbol, date, earnings_category_yoy, earnings_category_qoq "
            "FROM technical_signals WHERE date >= ? AND date <= ?",
            (start, end),
        )
    except Exception as e:                                      # noqa: BLE001
        print(f"[FactorBacktest] WARNING: earnings_category unavailable ({str(e)[:80]}); skipped.", file=sys.stderr)
        px['earnings_category_yoy'] = np.nan
        px['earnings_category_qoq'] = np.nan
        return px

    ec['date'] = pd.to_datetime(ec['date']).dt.strftime('%Y-%m-%d')
    px = px.merge(ec, on=['symbol', 'date'], how='left')
    print(f"[FactorBacktest] earnings_category: {len(ec):,} rows merged, {ec['date'].nunique()} "
          f"distinct dates. Coverage -- yoy={int(px['earnings_category_yoy'].notna().sum()):,}, "
          f"qoq={int(px['earnings_category_qoq'].notna().sum()):,}")
    return px


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
              "against a filled run.", file=sys.stderr)
        return px


# -- Simulation -------------------------------------------------------------------
def index_by_date(panel: pd.DataFrame) -> dict:
    """Group the eligible panel by date once. Reuse across factors in a sweep.

    SELECTION only. Exits must be priced from index_exit_prices() below, never from this --
    see that function for why.
    """
    return {d: g for d, g in panel[panel['eligible']].groupby('date', sort=False)}


def index_exit_prices(panel: pd.DataFrame) -> dict:
    """date -> Series(symbol -> next_open) over the FULL panel, not just eligible rows.

    Exits have to be priced off every row that has a tradeable next open, because `eligible`
    is `adt20 >= min_adt AND next_open exists` -- a LIQUIDITY screen, not a survival test. A
    name whose 20-day turnover dips under the floor for one session is still quoted and still
    sellable; it has simply stopped qualifying for NEW positions.

    Pricing exits off the eligible-only slice made every such name look unexitable, so it took
    MISSING_EXIT_PCT = -100%, a total write-off, in both the portfolio and the benchmark.
    Measured 2026-08-11: **0.618% of the eligible universe drops out per session** (median
    0.465%, p95 1.11%), so the benchmark carried a -0.618%/day phantom drag. That reconstructs
    the bug exactly -- true equal-weighted universe +0.1072%/day, minus 0.618%, equals
    -0.511%/day against the -0.5177%/day the harness reported. Over 1,391 sessions it printed
    a -99.9% universe for a market that roughly tripled.

    It does not cancel out of the excess figures either, which is the damaging part: the drag
    scales with how much a factor tilts toward names that lose liquidity, so illiquidity-tilted
    factors (delivery %, low-vol, deep value) were penalised against the benchmark and
    large-cap-tilted ones flattered. Any factor verdict produced before this fix needs re-running.

    MISSING_EXIT_PCT is now reserved for what it was documented to mean: a name with no price
    anywhere in the panel at the exit date, i.e. genuinely delisted or gone dark.
    """
    return {d: g.set_index('symbol')['next_open']
            for d, g in panel[panel['next_open'].notna() & (panel['next_open'] > 0)]
                        .groupby('date', sort=False)}


def index_last_alive(panel: pd.DataFrame) -> dict:
    """Last date each symbol has a usable price anywhere in the panel.

    Exists to tell the TWO reasons an exit price can be missing apart, which the harness
    previously conflated into a -100% write-off:

      * the symbol is genuinely gone (delisted / went dark)          -> MISSING_EXIT_PCT is right
      * the symbol simply has no bar on that ONE date and trades on  -> a write-off is fabricated

    Measured 2026-08-12 over 473,672 eligible name-periods: **0.039% per session are unpriced at
    the exit date but demonstrably alive afterwards, and ZERO are genuinely gone** -- i.e. the
    write-off was firing on 100% false positives. That is ~9.9pp/yr of phantom drag, applied to
    the benchmark every period. It is diluted at a 21-session rebalance (12 hits/yr) and dominates
    at 1 (252 hits/yr), which is why `universe_annualised_pct` read -16.77%/yr at `--rebalance 1`
    against +21.26%/yr at 5 -- factor-independent (-16.77 vs -16.74 for two unrelated factors),
    the signature of a benchmark bug rather than a factor result.

    Same family as the 2026-08-11 `index_exit_prices()` fix in measurement.md's banner: a
    liquidity/observation gap being read as a survival event.

    Keyed on `next_open`, NOT `close`, and the difference is the whole test: a delisted name's
    FINAL bar still has a close, so a close-based map would report it alive on the very date it
    can no longer be sold and would suppress the write-off that genuinely belongs there. The
    exit price is always a next_open, so survival has to be measured in the same currency --
    "is there any date from here on at which this name could be sold".
    """
    ok = panel[panel['next_open'].notna() & (panel['next_open'] > 0)]
    return ok.groupby('symbol')['date'].max().to_dict()


def run_backtest(panel: pd.DataFrame,
                 factor: str,
                 rebalance_days: int = 21,
                 top_k: int = 50,
                 cost_bps_per_side: float = DEFAULT_COST_BPS_PER_SIDE,
                 long_short: bool = False,
                 by_date: dict | None = None,
                 missing_exit_pct: float = MISSING_EXIT_PCT,
                 exit_by_date: dict | None = None,
                 last_alive: dict | None = None) -> dict:
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
    if exit_by_date is None:
        exit_by_date = index_exit_prices(panel)
    if last_alive is None:
        last_alive = index_last_alive(panel)

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
        # Exit off the FULL panel, not by_date (eligible-only) -- a name that fell under the
        # liquidity floor is still quoted and still sellable. See index_exit_prices().
        exit_px = exit_by_date.get(d1)
        if exit_px is None:
            continue

        gross = 0.0
        missing = 0
        unpriced_alive = 0
        wt_total = sum(abs(v) for v in w.values())
        wt_used = 0.0
        for s, wt in w.items():
            e, x = entry.get(s), exit_px.get(s)
            if e is None or not np.isfinite(e) or e <= 0:
                continue                      # never entered -- not a position, not a loss
            if x is None or not np.isfinite(x):
                if last_alive.get(s, '') >= d1:
                    # Alive, just unobserved on THIS date -- no bar, not a delisting. Writing it
                    # off at -100% here is what put ~9.9pp/yr of phantom drag into the benchmark
                    # (see index_last_alive). Drop it from the period instead and renormalise, so
                    # it is neither a fabricated loss nor a silent 0% that flatters the result.
                    unpriced_alive += 1
                    continue
                # Genuinely gone (no price anywhere in the panel from here on): delisted or dark.
                # Written off at MISSING_EXIT_PCT rather than held flat -- 0% was the survivorship
                # hole wearing a different hat. The benchmark below applies the SAME rule to the
                # SAME names, so neither leg gets a convention the other does not.
                missing += 1
                gross += wt * missing_exit_pct
                wt_used += abs(wt)
                continue
            r = (x / e - 1) * 100
            if abs(r) > RETURN_CLAMP_PCT:
                clamped += 1
                r = math.copysign(RETURN_CLAMP_PCT, r)
            gross += wt * r
            wt_used += abs(wt)
        # Renormalise over the weight actually priced. Without this, dropping an unpriced-but-alive
        # name would implicitly park its weight in cash at 0%, which is a return assumption, not an
        # abstention.
        if wt_used > 0 and wt_used < wt_total:
            gross *= wt_total / wt_used

        # reindex(entry.index), not dropna(): a name present at entry and absent at exit must stay
        # in the benchmark and take the same write-off, otherwise the comparison universe is
        # quietly survivorship-filtered while the strategy is not. Clip first (bad-bar guard on
        # observed prices), fill after, so the write-off is not clamped to -50%.
        uni = ((exit_px.reindex(entry.index) / entry - 1) * 100).replace([np.inf, -np.inf], np.nan)
        uni = uni.clip(-RETURN_CLAMP_PCT, RETURN_CLAMP_PCT)
        # Fill ONLY the genuinely-gone names. The rest stay NaN and drop out of .mean() -- the same
        # alive-but-unpriced rule the strategy leg above applies, so the two remain symmetric.
        gone = pd.Series({s: last_alive.get(s, '') < d1 for s in entry.index}, dtype=bool)
        uni = uni.mask(uni.isna() & gone.reindex(uni.index).fillna(True), missing_exit_pct)

        periods.append({
            'date': d0,
            'gross_pct': gross,
            'cost_pct': cost * 100,
            'net_pct': gross - cost * 100,
            'universe_pct': float(uni.mean()) if len(uni) else np.nan,
            'turnover': traded / 2.0,        # one-way turnover, the conventional quote
            'n_names': len(w),
            'missing_exits': missing,
        })
        prev_w = w

    if not periods:
        raise RuntimeError('no completed rebalance periods -- widen the window or lower --top-k')
    return _summarize(pd.DataFrame(periods), factor, rebalance_days, top_k,
                      cost_bps_per_side, long_short, clamped, missing_exit_pct)


def _summarize(df: pd.DataFrame, factor: str, rebalance_days: int, top_k: int,
               cost_bps: float, long_short: bool, clamped: int,
               missing_exit_pct: float = MISSING_EXIT_PCT) -> dict:
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

    # Is the BENCHMARK itself plausible? Every factor number here is an excess over `uni`, so a
    # broken benchmark silently rescales every verdict -- and that is not hypothetical. Until
    # 2026-08-11 exits were priced from the eligible-only slice, so any name dipping under the
    # Rs 1cr ADT floor for one session took MISSING_EXIT_PCT = -100%. The harness reported the
    # universe at -4.66%/month, i.e. **-99.9% over 5.5 years, for a market that roughly tripled**,
    # and nothing objected: the number was printed next to authoritative-looking t-stats and was
    # believed for a day. Indian equities have never compounded anywhere near this badly, so a
    # universe outside these bounds means the harness is broken, not that the market collapsed.
    uni_annual = float(((1 + uni.mean() / 100) ** per_yr - 1) * 100) if uni.notna().any() else float('nan')
    benchmark_sane = bool(np.isfinite(uni_annual) and -40.0 <= uni_annual <= 80.0)

    return {
        'factor': factor,
        'long_short': long_short,
        'excess_by_year_pct': by_year,
        'years_positive': f"{years_positive}/{len(by_year)}",
        'rebalance_days': rebalance_days,
        'top_k': top_k,
        'cost_bps_per_side': cost_bps,
        # Sensitivity handle for the delisting convention: if this is 0 the assumption is
        # irrelevant to the result; if it is large, re-run with --missing-exit-pct before
        # quoting any number from this run.
        'missing_exit_pct': missing_exit_pct,
        'missing_exits': int(df['missing_exits'].sum()) if 'missing_exits' in df else 0,
        'periods': int(len(df)),
        'years': round(yrs, 2),
        'gross_per_period_pct': round(float(df['gross_pct'].mean()), 4),
        'cost_per_period_pct': round(float(df['cost_pct'].mean()), 4),
        'net_per_period_pct': round(float(net.mean()), 4),
        'universe_per_period_pct': round(float(uni.mean()), 4),
        'universe_annualised_pct': round(uni_annual, 2),
        'benchmark_sane': benchmark_sane,
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
              'net_per_period_pct', 'universe_per_period_pct', 'universe_annualised_pct',
              'net_excess_vs_universe_pct',
              'excess_t_stat', 'pct_periods_beating_universe', 'avg_oneway_turnover',
              'annual_cost_drag_pct', 'cagr_net_pct', 'sharpe_net', 'max_drawdown_pct',
              'years_positive'):
        print(f"  {k:<32} {r[k]}")
    print(f"  {'excess_by_year_pct':<32} {r['excess_by_year_pct']}")
    if r['clamped_returns']:
        print(f"  {'clamped_returns':<32} {r['clamped_returns']}  <-- data-quality guard fired")

    # Every number above is an excess over the benchmark, so an implausible benchmark makes all
    # of them meaningless -- print that FIRST and refuse to give a verdict, rather than letting
    # a broken universe sit quietly beside an authoritative-looking t-stat. That is exactly how
    # a -99.9%-over-5.5-years universe went unchallenged for a day on 2026-08-11.
    if not r.get('benchmark_sane', True):
        print(f"\n  !! BENCHMARK IMPLAUSIBLE: universe annualises to "
              f"{r.get('universe_annualised_pct')}%. Indian equities have never done this.\n"
              f"     The harness is broken, not the market -- every excess figure above is void.\n"
              f"     Check exit pricing first (index_exit_prices): a name that merely fell under\n"
              f"     the ADT floor must be sold at its price, not written off at "
              f"{r['missing_exit_pct']}%.")
        return

    t = r['excess_t_stat']
    if not (isinstance(t, float) and math.isnan(t)) and abs(t) < 2.0:
        print(f"\n  VERDICT: NOT significant (|t|={abs(t):.2f} < 2). Do not trade this.")
    elif r['net_excess_vs_universe_pct'] <= 0:
        print("\n  VERDICT: significant but NEGATIVE net of costs. Useful only as an exclusion.")
    else:
        print("\n  VERDICT: positive and significant net of costs -- worth a live paper test.")


def picks_entry_state(panel: pd.DataFrame, signal_date) -> tuple[str, str | None]:
    """(entry_status, entry_session) for a list generated off `signal_date`.

    'pending_next_open' -- the entry open has NOT traded yet; the list is actionable.
    'entry_passed'      -- the session this list would have entered on is already history;
                           the list is a record, not a trade. This is the state the old
                           `eligible`-based selection produced on EVERY scheduled post-close
                           run, silently, with only `asOf` shown in the UI.
    """
    later = [d for d in panel['date'].unique() if d > signal_date]
    if not later:
        return 'pending_next_open', None
    return 'entry_passed', str(min(later))[:10]


def todays_picks(panel: pd.DataFrame, factor: str, top_k: int = 50) -> pd.DataFrame:
    """The top-K names by `factor` on the most recent SIGNAL-eligible date.

    Same scoring path the backtest uses, so what you see here is exactly what was measured --
    no second implementation to drift. Selection uses `signal_eligible` (factor + liquidity
    known as of the close), NOT `eligible` (which also demands a known next open and is
    therefore never true on the newest bar). Entry is still the next session's open; whether
    that open has already traded is reported by picks_entry_state, not silently ignored.
    """
    if factor not in FACTORS:
        raise KeyError(f"unknown factor {factor!r}; known: {sorted(FACTORS)}")
    if factor in PROVISIONAL_FACTORS:
        print(f"[FactorBacktest] WARNING: {factor} is built on vendor value history that is a "
              "recent BACKFILL, not an observed point-in-time series. A restated trailing EPS "
              "rewrites its own past, so this ranking may embed information that did not exist "
              "on the dates it claims. Research only.")
    universe = panel[panel['signal_eligible']]
    if universe.empty:
        raise RuntimeError('no signal-eligible rows in panel')
    last = universe['date'].max()
    cur = universe[universe['date'] == last].copy()
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


def factor_picks_payload(picks: pd.DataFrame, factor: str,
                         entry_status: str = 'pending_next_open',
                         entry_session: str | None = None) -> dict:
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
        # Entry state travels WITH the list. Without it the UI can only show `asOf`, which
        # looks equally fresh whether the entry open is still ahead or three days behind.
        'entryStatus': entry_status,
        'entrySession': entry_session,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'validatedTopKMin': VALIDATED_MIN_TOP_K,
        'evidence': 'paper_trade_candidate',
        'caveat': 'Research screen only; not the canonical Alpha score or a buy recommendation.',
        'picks': rows,
    }


def factor_picks_setting(factor: str) -> str:
    """app_settings key for a factor's persisted picks.

    Was a single hardcoded constant, which meant persisting a SECOND factor silently
    overwrote the first (2026-08-10). Keyed on the factor name instead. The formula
    reproduces the original key exactly for momentum_12_1, so this is backward compatible
    and no migration or re-seed is needed.
    """
    return f'{FACTOR_PICKS_PREFIX}{factor}'


def persist_factor_picks(picks: pd.DataFrame, factor: str,
                         entry_status: str = 'pending_next_open',
                         entry_session: str | None = None) -> dict:
    payload = factor_picks_payload(picks, factor, entry_status, entry_session)
    with transaction() as tx:
        tx.execute(
            'INSERT INTO app_settings (key, value) VALUES (?, ?) '
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            (factor_picks_setting(factor), json.dumps(payload)),
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
    p.add_argument('--missing-exit-pct', type=float, default=MISSING_EXIT_PCT,
                   help='return booked when a position cannot be exited (delisting). '
                        'Applied identically to strategy and benchmark; sweep it.')
    p.add_argument('--allow-provisional', action='store_true',
                   help=f'permit persisting a PROVISIONAL_FACTORS screen ({sorted(PROVISIONAL_FACTORS)}) '
                        'whose vendor history is a backfill rather than point-in-time')
    a = p.parse_args()

    if a.persist_picks and a.factor in PROVISIONAL_FACTORS and not a.allow_provisional:
        p.error(f"{a.factor} is built on backfilled vendor value history, which may embed "
                "restatements that did not exist on the dates it claims. Quantify that "
                "sensitivity, or pass --allow-provisional to persist it anyway.")

    panel = load_price_panel(a.start, a.end, a.min_adt, not a.no_survivorship_fill)

    if a.picks or a.persist_picks:
        if a.factor == 'all':
            p.error("--picks/--persist-picks needs a specific --factor, not 'all'")
        picks = todays_picks(panel, a.factor, a.top_k)
        entry_status, entry_session = picks_entry_state(panel, picks['date'].iloc[0])
        if a.persist_picks:
            payload = persist_factor_picks(picks, a.factor, entry_status, entry_session)
            print(json.dumps({'success': True, 'setting': factor_picks_setting(a.factor),
                              'count': len(payload['picks']), 'asOf': payload['asOf'],
                              'entryStatus': entry_status, 'entrySession': entry_session}))
            return
        print(f"\n=== top {len(picks)} by {a.factor} as of {picks['date'].iloc[0]} ===")
        print(picks.to_string(index=False))
        if entry_status == 'entry_passed':
            print(f"\nWARNING: the entry open for this list ({entry_session}) has ALREADY "
                  "traded. This is a record of a past signal, not an actionable list.")
        else:
            print("\nEntry is the NEXT session's open (not yet traded).")
        print("Single-factor, marginal evidence (see this module's docstring) -- paper-trade "
              "before committing capital.")
        return

    by_date = index_by_date(panel)          # grouped once, reused by every factor
    exit_by_date = index_exit_prices(panel)  # full-panel exit prices, likewise
    last_alive = index_last_alive(panel)     # survival map, likewise
    factors = sorted(FACTORS) if a.factor == 'all' else [a.factor]

    out = []
    for f in factors:
        try:
            r = run_backtest(panel, f, a.rebalance, a.top_k, a.cost_bps, a.long_short,
                             by_date=by_date, missing_exit_pct=a.missing_exit_pct,
                             exit_by_date=exit_by_date, last_alive=last_alive)
        except Exception as e:                              # noqa: BLE001
            print(f"[FactorBacktest] {f}: FAILED -- {e}", file=sys.stderr)
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
