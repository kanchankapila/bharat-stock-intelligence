#!/usr/bin/env python3
"""
Screener Combo Finder — reverse-engineers which precursor "screens" best predict which
stocks make a big move the NEXT session, then searches combinations of them.

Target: high_flyer_retrospective.detect_flyers's exact definition (a >=4% day move on
>=1.5x 20d volume, or a fresh 52-week high) -- imported, not redefined, so "made a high
that day" here is the literal same event this platform already tracks daily. Precursors are
all taken from the PRIOR trading day (never same-day) -- pairing a same-day gap/top-gainer
flag with the label it partly constitutes would trivially leak it.

Two tiers, reported separately, because they have very different amounts of history and
this platform has already been burned twice this session by treating a short, plausible-
looking result as reliable:

TIER 1 (deep, real statistical power): gap up/down, open=high/low, and top-gainer/loser-of-
the-day, all computed directly from stock_ohlcv -- thousands of trading days available.
This is the primary result.

TIER 2 (shallow, LOW-DATA): NiftyTrader live-screener filter matches (~22 days of history
in live_screener_appearances) and EOD screener category membership across Trendlyne/
MoneyControl/ETnow/et_marketstats (~49 days via screener_appearances -- values before
2026-07-31 are not point-in-time-reproducible, see screener_membership_snapshot's own
history). Reported as a directional lead only, matching factor_edge.py's convention for
young samples -- NOT a finding to act on.

Both tiers reuse the SAME day-level, benchmark-relative, cost-adjusted validation this
session already built for flyer_classifier.py/breakout_classifier.py -- fixing the exact gap
found in live_screener_optimizer.py's own combination search: its win_rate/avg_return is
computed per raw appearance row with no benchmark and no day-level significance test, which
silently inflates apparent reliability for any persistent (slow-changing) filter -- a stock
that qualifies for a fundamental filter today usually still qualifies tomorrow, so "1496
samples" can really be a handful of stocks re-counted for weeks. Here every observation is
aggregated to ONE row per (combination, day) before any spread/t-stat is computed, and the
comparison is against the SAME day's universe (not a pooled base rate across a possibly
different market regime).

Run:
    python screener_combo_finder.py --tier1
    python screener_combo_finder.py --tier2
    python screener_combo_finder.py --tier1 --tier2 --persist
"""

import polars as pl
import argparse
import datetime
import itertools
import json
import os
import sys

import numpy as np
import pandas as pd
from scipy import stats

from db_compat import connect, read_df, translate
from breakout_classifier import _load_ohlcv
from flyer_classifier import build_flyer_labels, _prev_trading_day_map, TRAIN_LOOKBACK_DAYS

GAP_THRESHOLD = 0.02     # >=2% gap at the open, vs prior close
TOP_PCT = 0.05           # top/bottom 5% of the universe by same-day return
MIN_PRICE = 20.0
MIN_ADTV = 5e7           # ~Rs5cr, matching this session's earlier backtests
COST_PCT = 0.15          # round-trip %, same level used for the flyer/breakout verdicts
MAX_COMBO_SIZE = 3
MIN_DAYS = 10
MIN_SIGNALS = 30


# ── shared validation core (day-level, benchmark-relative, cost-adjusted) ──────────────

def _day_level_backtest(tradeable: pd.DataFrame, mask: pd.Series, cost_pct: float = COST_PCT) -> dict | None:
    """tradeable needs columns [date, oc_ret] (realistic next-session open->close return).
    Aggregates to ONE row per day before computing anything -- the fix for the exact
    per-appearance-row inflation live_screener_optimizer.py's own metrics don't guard
    against (see module docstring)."""
    sub = tradeable[mask]
    if sub.empty:
        return None
    daily_basket = sub.groupby("date")["oc_ret"].mean()
    daily_universe = tradeable.groupby("date")["oc_ret"].mean().reindex(daily_basket.index)
    spread = (daily_basket - cost_pct / 100.0) - daily_universe
    spread = spread.dropna()
    if len(spread) < MIN_DAYS:
        return None
    t = stats.ttest_1samp(spread.values, 0.0)
    return {
        "n_days": int(len(spread)), "n_signals": int(len(sub)),
        "spread_pct": float(spread.mean() * 100), "t_stat": float(t.statistic), "p_value": float(t.pvalue),
    }


def search_combinations(tradeable: pd.DataFrame, feature_cols: list, max_size: int = MAX_COMBO_SIZE) -> list:
    """Exhaustive search (feature counts here are small enough -- a decision tree, like
    live_screener_optimizer.py uses for its much larger NiftyTrader filter set, would be
    overkill and less transparent). Ranked by t-stat, not raw win rate/avg return -- a big
    average on 12 signal-days is not a finding."""
    results = []
    for size in range(1, max_size + 1):
        for combo in itertools.combinations(feature_cols, size):
            mask = pd.Series(True, index=tradeable.index)
            for f in combo:
                mask &= tradeable[f].astype(bool)
            stat = _day_level_backtest(tradeable, mask)
            if stat and stat["n_signals"] >= MIN_SIGNALS:
                stat["filters"] = list(combo)
                results.append(stat)
    return sorted(results, key=lambda r: r["t_stat"], reverse=True)


def _load_open_close_adtv(ohlcv: pd.DataFrame) -> pd.DataFrame:
    oc = ohlcv[["symbol", "date", "open", "close", "volume"]].copy()
    oc["oc_ret"] = (oc["close"] - oc["open"]) / oc["open"].replace(0, np.nan)
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()
    adtv = (close * volume).rolling(20).mean().stack(future_stack=True).rename("adtv").reset_index()
    adtv.columns = ["date", "symbol", "adtv"]
    return oc, adtv


# ── Tier 1: OHLCV-derived precursors, full history ──────────────────────────────────────

def compute_tier1_precursors(ohlcv: pd.DataFrame) -> pd.DataFrame:
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    open_ = ohlcv.pivot_table(index="date", columns="symbol", values="open").sort_index()
    high = ohlcv.pivot_table(index="date", columns="symbol", values="high").sort_index()
    low = ohlcv.pivot_table(index="date", columns="symbol", values="low").sort_index()

    prev_close = close.ffill().shift(1)
    ret = close.ffill().pct_change()
    gap_pct = (open_ - prev_close) / prev_close.replace(0, np.nan)
    rank = ret.rank(axis=1, pct=True)

    # A flat/zero-range day (circuit-locked, or simply no real trading) trivially satisfies
    # BOTH "opened at the high" and "opened at the low" at once -- a degenerate case, not a
    # real "opened strong and held" signal. Require the day actually had a meaningful range
    # (>=0.5% of price) before either flag can fire, same reasoning ohlcv_adjust.py already
    # uses to reject circuit-locked bars as ambiguous (2026-08-01 session).
    has_range = ((high - low) >= 0.005 * open_) & open_.notna() & high.notna() & low.notna()

    flags = {
        "gap_up":       gap_pct >= GAP_THRESHOLD,
        "gap_down":     gap_pct <= -GAP_THRESHOLD,
        "open_eq_high": has_range & ((high - open_) <= 0.001 * open_),
        "open_eq_low":  has_range & ((open_ - low) <= 0.001 * open_),
        "top_gainer":   rank >= (1 - TOP_PCT),
        "top_loser":    rank <= TOP_PCT,
    }
    parts = []
    for name, frame in flags.items():
        long = frame.fillna(False).astype(int).stack(future_stack=True).rename(name).reset_index()
        long.columns = ["date", "symbol", name]
        parts.append(long.set_index(["date", "symbol"]))
    return pd.concat(parts, axis=1).reset_index()


def run_tier1(persist: bool) -> dict | None:
    cutoff = (datetime.date.today() - datetime.timedelta(days=TRAIN_LOOKBACK_DAYS)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    if ohlcv.empty:
        print("[Tier1] No OHLCV data.")
        return None
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()

    labels = build_flyer_labels(close, volume)
    precursors = compute_tier1_precursors(ohlcv)
    feature_cols = [c for c in precursors.columns if c not in ("date", "symbol")]

    prev_of = _prev_trading_day_map(list(close.index))
    labels = labels[labels["date"].isin(prev_of)].copy()
    labels["feat_date"] = labels["date"].map(prev_of)
    precursors = precursors.rename(columns={"date": "feat_date"})
    df = labels.merge(precursors, on=["symbol", "feat_date"], how="inner")

    oc, adtv = _load_open_close_adtv(ohlcv)
    df = df.merge(oc[["symbol", "date", "oc_ret"]], on=["symbol", "date"], how="inner")
    df = df.merge(adtv, left_on=["symbol", "feat_date"], right_on=["symbol", "date"], how="left", suffixes=("", "_adtv"))
    price_asof = oc.rename(columns={"date": "feat_date", "close": "feat_close"})[["symbol", "feat_date", "feat_close"]]
    df = df.merge(price_asof, on=["symbol", "feat_date"], how="left")
    tradeable = df[(df["adtv"] >= MIN_ADTV) & (df["feat_close"] >= MIN_PRICE)].dropna(subset=["oc_ret"])

    print(f"[Tier1] {len(tradeable)} tradeable rows, {tradeable['date'].nunique()} days, "
          f"{tradeable['symbol'].nunique()} symbols, base flyer rate {tradeable['flew'].mean():.3f}")

    results = search_combinations(tradeable, feature_cols)
    print(f"\n[Tier1] Top combinations by day-level t-stat (>= Rs{MIN_ADTV/1e7:.0f}cr ADTV, "
          f"{COST_PCT}% round-trip cost, next-session open->close):")
    print(f"{'filters':<45} {'days':>5} {'sig.':>6} {'spread%':>9} {'t-stat':>7} {'p':>8}")
    for r in results[:15]:
        print(f"{','.join(r['filters']):<45} {r['n_days']:>5} {r['n_signals']:>6} "
              f"{r['spread_pct']:>8.4f}% {r['t_stat']:>7.2f} {r['p_value']:>8.4f}")

    if not results:
        print("[Tier1] No combination cleared the minimum sample thresholds.")
        return None
    best = results[0]
    is_edge = bool(best["p_value"] < 0.05 and best["spread_pct"] > 0)
    print(f"\n[Tier1] VERDICT: {'REAL EDGE' if is_edge else 'NO PROVEN EDGE'} "
          f"— best combo {best['filters']} spread={best['spread_pct']:.4f}% t={best['t_stat']:.2f} p={best['p_value']:.4f}")

    verdict = {"as_of": datetime.date.today().isoformat(), "tier": 1, "low_data": False,
               "n_days_history": int(tradeable["date"].nunique()), "cost_pct_used": COST_PCT,
               "top_combinations": results[:10], "best": best, "is_edge": is_edge}
    if persist:
        _persist("screener_combo_finder_tier1", verdict)
    return verdict


# ── Tier 2: NiftyTrader live filters + EOD screener category membership, short history ──

def _load_niftytrader_flags() -> pd.DataFrame:
    df = read_df(
        "SELECT o.symbol, o.appeared_at::date AS date, o.filter_key "
        "FROM live_screener_outcomes o"
    )
    if df.empty:
        return df
    df["v"] = 1
    wide = df.drop_duplicates(["symbol", "date", "filter_key"]).pivot_table(
        index=["symbol", "date"], columns="filter_key", values="v", fill_value=0).reset_index()
    wide.columns = ["symbol", "date"] + [f"nt_{c}" for c in wide.columns[2:]]
    return wide


def _load_eod_screener_category_flags() -> pd.DataFrame:
    """One row per (symbol, date) with a bull/bear membership flag per inferred_category,
    from screener_appearances joined to screener_master. NOTE: appeared_date/exited_date on
    screener_appearances predate the 2026-07-31 point-in-time snapshot fix and are not
    reconstructable exactly as of a historical date -- treated here as a coarse "was this
    stock a member around this date" signal, not an exact PIT record. That imprecision is
    part of why this whole tier is reported as low-data/directional only."""
    df = read_df("""
        SELECT sa.symbol, sa.appeared_date, sa.exited_date,
               sm.inferred_category, sm.inferred_sentiment
        FROM screener_appearances sa
        JOIN screener_master sm ON sm.source = sa.source AND sm.scan_id = sa.screener_id
        WHERE sa.appeared_date >= (CURRENT_DATE - INTERVAL '60 days')
    """)
    if df.empty:
        return df
    # appeared_date/exited_date come back as tz-aware Timestamps (native TIMESTAMPTZ
    # columns) -- normalize to plain YYYY-MM-DD strings so they compare correctly against
    # stock_ohlcv's plain DATE-derived date strings below, rather than raising or silently
    # never matching (same class of TEXT-vs-TIMESTAMPTZ mismatch documented repeatedly
    # elsewhere in this codebase's history).
    df["appeared_date"] = pd.to_datetime(df["appeared_date"]).dt.strftime("%Y-%m-%d")
    df = df.dropna(subset=["appeared_date"])  # a null appeared_date can't be placed on any date
    exited_dt = pd.to_datetime(df["exited_date"])
    df["exited_date"] = exited_dt.dt.strftime("%Y-%m-%d").where(exited_dt.notna(), "9999-12-31")
    dates = read_df("SELECT DISTINCT date::text AS date FROM stock_ohlcv "
                     "WHERE date >= (CURRENT_DATE - INTERVAL '60 days')")["date"].tolist()
    rows = []
    for r in df.itertuples(index=False):
        sentiment = "bull" if r.inferred_sentiment == "bullish" else (
            "bear" if r.inferred_sentiment == "bearish" else None)
        if not sentiment:
            continue
        for d in dates:
            if r.appeared_date <= d <= r.exited_date:
                rows.append((r.symbol, d, f"eod_{r.inferred_category}_{sentiment}"))
    if not rows:
        return pd.DataFrame()
    long = pd.DataFrame(rows, columns=["symbol", "date", "cat"]).drop_duplicates()
    long["v"] = 1
    wide = long.pivot_table(index=["symbol", "date"], columns="cat", values="v", fill_value=0).reset_index()
    return wide


def run_tier2(persist: bool) -> dict | None:
    nt = _load_niftytrader_flags()
    eod = _load_eod_screener_category_flags()
    if nt.empty and eod.empty:
        print("[Tier2] No live-screener or EOD-screener membership data available.")
        return None

    merged = nt if eod.empty else (eod if nt.empty else nt.merge(eod, on=["symbol", "date"], how="outer"))
    feature_cols = [c for c in merged.columns if c not in ("symbol", "date")]
    for c in feature_cols:
        merged[c] = merged[c].fillna(0).astype(int)
    merged["date"] = merged["date"].astype(str)

    cutoff = (datetime.date.today() - datetime.timedelta(days=90)).isoformat()
    ohlcv = _load_ohlcv(cutoff)
    close = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    volume = ohlcv.pivot_table(index="date", columns="symbol", values="volume").sort_index()
    labels = build_flyer_labels(close, volume)
    prev_of = _prev_trading_day_map(list(close.index))
    labels = labels[labels["date"].isin(prev_of)].copy()
    labels["feat_date"] = labels["date"].map(prev_of)

    df = labels.merge(merged.rename(columns={"date": "feat_date"}), on=["symbol", "feat_date"], how="inner")
    if df.empty:
        print("[Tier2] No overlap between screener membership dates and flyer labels.")
        return None

    oc, adtv = _load_open_close_adtv(ohlcv)
    df = df.merge(oc[["symbol", "date", "oc_ret"]], on=["symbol", "date"], how="inner")
    df = df.merge(adtv, left_on=["symbol", "feat_date"], right_on=["symbol", "date"], how="left", suffixes=("", "_adtv"))
    price_asof = oc.rename(columns={"date": "feat_date", "close": "feat_close"})[["symbol", "feat_date", "feat_close"]]
    df = df.merge(price_asof, on=["symbol", "feat_date"], how="left")
    tradeable = df[(df["adtv"] >= MIN_ADTV) & (df["feat_close"] >= MIN_PRICE)].dropna(subset=["oc_ret"])

    n_days = tradeable["date"].nunique()
    print(f"\n[Tier2] LOW-DATA — {n_days} distinct days, {len(feature_cols)} candidate filters/categories. "
          f"Directional lead only, not a validated finding.")
    if n_days < MIN_DAYS:
        print(f"[Tier2] Fewer than {MIN_DAYS} days available -- skipping combination search entirely "
              f"(a t-stat on this few days would be meaningless).")
        return {"as_of": datetime.date.today().isoformat(), "tier": 2, "low_data": True,
                "n_days_history": int(n_days), "top_combinations": [], "best": None, "is_edge": False}

    results = search_combinations(tradeable, feature_cols, max_size=2)  # depth 2 only -- data is thin
    print(f"{'filters':<50} {'days':>5} {'sig.':>6} {'spread%':>9} {'t-stat':>7} {'p':>8}")
    for r in results[:15]:
        print(f"{','.join(r['filters']):<50} {r['n_days']:>5} {r['n_signals']:>6} "
              f"{r['spread_pct']:>8.4f}% {r['t_stat']:>7.2f} {r['p_value']:>8.4f}")

    best = results[0] if results else None
    verdict = {"as_of": datetime.date.today().isoformat(), "tier": 2, "low_data": True,
               "n_days_history": int(n_days), "cost_pct_used": COST_PCT,
               "top_combinations": results[:10], "best": best, "is_edge": False}
    print(f"\n[Tier2] Not scored as edge/no-edge — {n_days} days is not enough history to trust a "
          f"significance test either way. Re-run once more history accumulates.")
    if persist:
        _persist("screener_combo_finder_tier2", verdict)
    return verdict


def _persist(key: str, verdict: dict) -> None:
    conn = connect()
    cur = conn.cursor()
    cur.execute(translate(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
        (key, json.dumps(verdict)))
    conn.commit()
    print(f"Persisted to app_settings.{key}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reverse-engineer screener combinations that predict next-session flyers")
    parser.add_argument("--tier1", action="store_true")
    parser.add_argument("--tier2", action="store_true")
    parser.add_argument("--persist", action="store_true")
    args = parser.parse_args()
    if not (args.tier1 or args.tier2):
        args.tier1 = args.tier2 = True
    if args.tier1:
        run_tier1(persist=args.persist)
    if args.tier2:
        run_tier2(persist=args.persist)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
