"""Next-session engine: decisions at the close of day d (optionally refined by d+1's 09:08 pre-open
auction), traded from d+1's OPEN to d+1's CLOSE.

The legacy platform's single validated edge lives here: the "capitulation" triple — on day d
the stock gapped down >= 2%, opened at its low (with a real range), and finished in the bottom
5% of the day — followed by a positive next-session open->close spread (t=+3.48, p=0.0005,
5/6 years, 2021-2026). It is capacity-limited (median ≈ ₹0.46 cr deployable per signal-day),
which is why every evaluation here reports capacity next to returns.

Definitions follow legacy screener_combo_finder.py (thresholds, the >= 0.5% range requirement,
bottom-5% on close-to-close return, ₹5 cr ADT / ₹20 floors) so the rule can be re-measured on
this system's survivorship-free, adjusted data. One deliberate difference: the bottom-5% rank is
taken WITHIN the tradeable universe (legacy ranked every symbol, then filtered), so an illiquid
name cannot crowd a tradeable one out of the tail.

Evaluation is DAY-LEVEL: one row per session (basket mean open->close, minus round-trip
intraday costs, minus the same session's equal-weight universe mean), then the t-stat across
sessions. Pooling signal rows would re-count persistent names (legacy live_screener_optimizer
inflation).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy import stats

from bharat_alpha.costs import INTRADAY_COSTS
from bharat_alpha.marketdata import Panel

GAP = 0.02
TOP_PCT = 0.05
OPEN_TOL = 0.001
MIN_RANGE = 0.005
MIN_ADT_INR = 5e7
MIN_PRICE_INR = 20.0
MAX_PARTICIPATION = 0.02
SERIES = ("EQ", "BE", "BZ")


def session_universe(p: Panel) -> pd.DataFrame:
    adt20 = p.turnover.rolling(20, min_periods=15).mean()
    return p.traded & p.series.isin(list(SERIES)) & (p.raw_close >= MIN_PRICE_INR) & (adt20 >= MIN_ADT_INR)


def day_flags(p: Panel, universe: pd.DataFrame) -> dict[str, pd.DataFrame]:
    prev = p.close.ffill().shift(1)                       # adjusted, so ex-dates are not "gaps"
    gap = p.open / prev - 1
    ret = p.close / prev - 1
    rank = ret.where(universe).rank(axis=1, pct=True)
    has_range = (p.high - p.low) >= MIN_RANGE * p.open
    f = {
        "gap_down": gap <= -GAP,
        "gap_up": gap >= GAP,
        "open_eq_low": has_range & ((p.open - p.low) <= OPEN_TOL * p.open),
        "open_eq_high": has_range & ((p.high - p.open) <= OPEN_TOL * p.open),
        "top_loser": rank <= TOP_PCT,
        "top_gainer": rank >= 1 - TOP_PCT,
    }
    return {k: v.fillna(False) & universe for k, v in f.items()}


def capitulation(flags: dict[str, pd.DataFrame]) -> pd.DataFrame:
    return flags["gap_down"] & flags["open_eq_low"] & flags["top_loser"]


def next_session_oc(p: Panel) -> pd.DataFrame:
    """Row d = open->close return of session d+1 (the trade a decision at d's close makes)."""
    return (p.close / p.open - 1).shift(-1)


@dataclass
class DayLevelResult:
    daily: pd.DataFrame
    n_days: int
    n_signals: int
    mean_net_spread: float
    t: float
    p: float
    pct_days_positive: float
    years_positive: str
    median_capacity_inr: float

    def summary(self) -> dict:
        return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in self.__dict__.items() if k != "daily"}


def day_level(selection: pd.DataFrame, fwd_oc: pd.DataFrame, universe: pd.DataFrame, p: Panel,
              cost: float = INTRADAY_COSTS.round_trip()) -> DayLevelResult:
    """selection: wide bool (which names are bought at d+1's open, decided at d)."""
    # winsorise per session (inward cutoffs) before any mean: one corrupt print must not decide
    # the verdict; ranking-based selection is unaffected
    from bharat_alpha.labels import winsorize_rows

    fwd_oc = winsorize_rows(fwd_oc.where(universe), 0.01)
    sel = selection & universe & fwd_oc.notna()
    uni = fwd_oc
    adt = p.turnover.rolling(20, min_periods=15).mean()
    rows = []
    for d in sel.index[sel.any(axis=1)]:
        names = sel.columns[sel.loc[d].to_numpy()]
        basket = float(fwd_oc.loc[d, names].mean())
        rows.append({"date": d, "n": len(names), "basket": basket, "universe": float(uni.loc[d].mean()),
                     "capacity_inr": float((adt.loc[d, names] * MAX_PARTICIPATION).sum())})
    daily = pd.DataFrame(rows)
    if daily.empty:
        return DayLevelResult(daily, 0, 0, float("nan"), float("nan"), float("nan"), float("nan"), "", float("nan"))
    daily = daily.set_index("date")
    daily["net_spread"] = daily["basket"] - cost - daily["universe"]
    x = daily["net_spread"]
    t, pv = (stats.ttest_1samp(x, 0.0) if len(x) > 2 else (float("nan"), float("nan")))
    years = x.groupby(x.index.year).mean()
    return DayLevelResult(daily, len(x), int(daily["n"].sum()), float(x.mean()), float(t), float(pv),
                          float((x > 0).mean()), f"{int((years > 0).sum())}/{len(years)}",
                          float(daily["capacity_inr"].median()))


def top_k_selection(scores: pd.DataFrame, k: int) -> pd.DataFrame:
    r = scores.rank(axis=1, ascending=False, method="first")
    return (r <= k).fillna(False)


def preopen_features(conn, p: Panel) -> dict[str, pd.DataFrame]:
    """Row d = the pre-open auction of session d+1, only when it was captured BEFORE d+1's
    09:15 open. Using these moves the decision from d's close to 09:14 on d+1 — still before the
    open-price entry, so it is not look-ahead. NaN wherever no capture exists (all of history
    before collection started)."""
    from bharat_alpha.db import read_df
    from bharat_alpha.ingest.sources.nse_preopen import usable_before_open

    df = read_df(conn, "SELECT instrument_id, trade_date, iep_gap, imbalance, knowable_at FROM alpha.preopen_snapshot "
                       "WHERE trade_date BETWEEN %s AND %s", (p.dates.min().date(), p.dates.max().date()))
    if df.empty:
        return {}
    df = df[[usable_before_open(k, d) for k, d in zip(df.knowable_at, df.trade_date)]]
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    out = {}
    for col in ("iep_gap", "imbalance"):
        w = df.pivot(index="trade_date", columns="instrument_id", values=col)
        w = w.reindex(index=p.dates, columns=p.close.columns)
        out[f"po_{col}"] = w.shift(-1)                   # session d+1's auction, on row d
    return out


def session_features(p: Panel, flags: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """Day-d state of each name (all knowable at d's close). Flags enter as 0/1 so a model can
    learn the rule and its interactions; continuous versions let it learn the thresholds."""
    prev = p.close.ffill().shift(1)
    rng = (p.high - p.low).replace(0, np.nan)
    ret = p.close / prev - 1
    logret = np.log1p(ret)
    f = {
        "s_gap": p.open / prev - 1,
        "s_ret_1": ret,
        "s_intraday": p.close / p.open - 1,
        "s_open_loc": (p.open - p.low) / rng,
        "s_close_loc": (p.close - p.low) / rng,
        "s_range_pct": rng / p.open,
        "s_ret_5": p.close / p.close.shift(5) - 1,
        "s_ret_21": p.close / p.close.shift(21) - 1,
        "s_vol_21": logret.rolling(21, min_periods=15).std(),
        "s_turnover_ratio": p.turnover / p.turnover.rolling(20, min_periods=15).mean(),
        "s_deliv_pct": p.deliv_pct,
        "s_dist_52w_low": p.close / p.close.rolling(252, min_periods=120).min() - 1,
        "s_log_adt": np.log(p.turnover.rolling(20, min_periods=15).mean()),
    }
    for k, v in flags.items():
        f[f"flag_{k}"] = v.astype(float)
    f["flag_capitulation"] = capitulation(flags).astype(float)
    return f
