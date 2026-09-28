"""Point-in-time feature construction.

Contract: a feature row for decision date t uses only information knowable by EOD of t
(`knowable_at <= eod(t)`); the trade is entered at the NEXT session's open. Price features
use the adjusted panel up to and including t's close; external facts are joined as-of their
knowable_at, never their event date.

Cross-sectional normalisation happens PER DATE across instruments (rank -> Gaussian), never
per instrument across time. (Legacy stored per-symbol RobustScaler output in its feature
store; a per-symbol affine transform reorders the cross-section and every rank-IC measured
on it was wrong — AF-20260910-18.)
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import numpy as np
import pandas as pd
import psycopg
from scipy.special import ndtri

from bharat_alpha.config import get_settings
from bharat_alpha.db import read_df
from bharat_alpha.marketdata import Panel

FEATURE_SET_VERSION = "fs1"


PIPELINE_CUTOFF_HOUR_IST = 19   # the daily run starts after this; later facts belong to the next date


def _known_date(ts: pd.Series) -> pd.Series:
    """Decision date on which a fact with this knowable_at is first usable. Anything that
    became known after the daily run's cutoff is usable only from the next date, so a backtest
    never sees a fact the live pipeline could not have seen (train/serve skew)."""
    local = pd.to_datetime(ts, utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    late = local.dt.hour >= PIPELINE_CUTOFF_HOUR_IST
    return local.dt.normalize() + pd.to_timedelta(late.astype(int), unit="D")


def _rolling_mean(df: pd.DataFrame, w: int, minp: float = 0.75) -> pd.DataFrame:
    return df.rolling(w, min_periods=max(2, int(w * minp))).mean()


def _rolling_std(df: pd.DataFrame, w: int, minp: float = 0.75) -> pd.DataFrame:
    return df.rolling(w, min_periods=max(3, int(w * minp))).std()


def price_features(p: Panel) -> dict[str, pd.DataFrame]:
    c = p.close.ffill(limit=5)
    ret = p.close / p.close.shift(1) - 1          # NaN across a non-traded day: no fabricated 0
    logret = np.log1p(ret)
    f: dict[str, pd.DataFrame] = {}
    for w in (5, 21, 63, 126):
        f[f"ret_{w}"] = c / c.shift(w) - 1
    f["mom_12_1"] = c.shift(21) / c.shift(252) - 1
    f["mom_6_1"] = c.shift(21) / c.shift(126) - 1
    vol21 = _rolling_std(logret, 21)
    vol63 = _rolling_std(logret, 63)
    f["vol_21"] = vol21
    f["vol_63"] = vol63
    f["vol_ratio"] = vol21 / vol63
    f["downside_vol_63"] = _rolling_std(logret.where(logret < 0), 63, 0.3)
    f["max_ret_21"] = ret.rolling(21, min_periods=15).max()
    tr = pd.concat([p.high - p.low, (p.high - c.shift(1)).abs(), (p.low - c.shift(1)).abs()]).groupby(level=0).max()
    tr = tr.reindex(p.close.index)
    f["atr_pct_14"] = _rolling_mean(tr, 14) / c
    hi252 = c.rolling(252, min_periods=120).max()
    lo252 = c.rolling(252, min_periods=120).min()
    f["dist_52w_high"] = c / hi252 - 1
    f["dist_52w_low"] = c / lo252 - 1
    f["dist_sma50"] = c / _rolling_mean(c, 50) - 1
    f["dist_sma200"] = c / c.rolling(200, min_periods=150).mean() - 1
    gain = ret.clip(lower=0).ewm(alpha=1 / 14, min_periods=14).mean()
    loss = (-ret.clip(upper=0)).ewm(alpha=1 / 14, min_periods=14).mean()
    f["rsi_14"] = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    sma20, sd20 = _rolling_mean(c, 20), _rolling_std(c, 20)
    f["bb_pct"] = (c - (sma20 - 2 * sd20)) / (4 * sd20)
    f["gap_mean_21"] = (p.open / c.shift(1) - 1).rolling(21, min_periods=15).mean()
    f["close_loc_21"] = ((c - p.low) / (p.high - p.low).replace(0, np.nan)).rolling(21, min_periods=15).mean()
    f["vwap_dist"] = c / p.vwap - 1
    # liquidity & participation
    adt20 = _rolling_mean(p.turnover, 20)
    f["log_adt_20"] = np.log(adt20)
    f["turnover_ratio_5_60"] = _rolling_mean(p.turnover, 5) / _rolling_mean(p.turnover, 60)
    f["amihud_21"] = (ret.abs() / p.turnover.replace(0, np.nan) * 1e7).rolling(21, min_periods=15).mean()
    # delivery (exchange-reported, the one flow proxy with full point-in-time history)
    f["deliv_pct"] = p.deliv_pct
    f["deliv_pct_5"] = _rolling_mean(p.deliv_pct, 5)
    f["deliv_z_60"] = (f["deliv_pct_5"] - _rolling_mean(p.deliv_pct, 60)) / _rolling_std(p.deliv_pct, 60)
    return f


def market_context(conn: psycopg.Connection, p: Panel) -> pd.DataFrame:
    """Per-date market features (same value for every instrument on a date)."""
    idx = p.close.index
    c = p.close
    ret = c / c.shift(1) - 1
    eq = ret.mean(axis=1)
    ctx = pd.DataFrame(index=idx)
    ctx["mkt_ret_21"] = (1 + eq).rolling(21, min_periods=15).apply(np.prod, raw=True) - 1
    ctx["mkt_vol_21"] = eq.rolling(21, min_periods=15).std()
    sma50 = c.rolling(50, min_periods=40).mean()
    ctx["breadth_sma50"] = (c > sma50).sum(axis=1) / sma50.notna().sum(axis=1).replace(0, np.nan)
    ctx["xs_dispersion_21"] = (c / c.shift(21) - 1).std(axis=1)
    start, end = idx.min().date(), idx.max().date()
    ix = read_df(conn, "SELECT index_name, trade_date, close FROM alpha.index_daily WHERE trade_date BETWEEN %s AND %s "
                       "AND index_name IN ('INDIA VIX', 'NIFTY 500')", (start, end))
    if not ix.empty:
        ix["trade_date"] = pd.to_datetime(ix["trade_date"])
        w = ix.pivot(index="trade_date", columns="index_name", values="close").reindex(idx)
        if "INDIA VIX" in w:
            ctx["vix"] = w["INDIA VIX"]
            ctx["vix_chg_5"] = w["INDIA VIX"] / w["INDIA VIX"].shift(5) - 1
        if "NIFTY 500" in w:
            ctx["n500_ret_63"] = w["NIFTY 500"] / w["NIFTY 500"].shift(63) - 1
    fl = read_df(conn, """
        SELECT DISTINCT ON (trade_date, category) trade_date, category, net_cr FROM alpha.market_flow
        WHERE trade_date BETWEEN %s AND %s ORDER BY trade_date, category, source""", (start, end))
    if not fl.empty:
        fl["trade_date"] = pd.to_datetime(fl["trade_date"])
        w = fl.pivot(index="trade_date", columns="category", values="net_cr").reindex(idx)
        for cat in ("FII", "DII"):
            if cat in w:
                ctx[f"{cat.lower()}_net_5"] = w[cat].rolling(5, min_periods=3).sum()
                ctx[f"{cat.lower()}_net_21"] = w[cat].rolling(21, min_periods=15).sum()
    return ctx


def fo_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    idx = p.close.index
    fo = read_df(conn, """
        SELECT instrument_id, trade_date, expiry, close, underlying, open_interest FROM alpha.fo_daily
        WHERE trade_date BETWEEN %s AND %s""", (idx.min().date(), idx.max().date()))
    if fo.empty:
        return {}
    fo["trade_date"] = pd.to_datetime(fo["trade_date"])
    fo["expiry"] = pd.to_datetime(fo["expiry"])
    fo = fo.sort_values(["instrument_id", "trade_date", "expiry"])
    near = fo.groupby(["instrument_id", "trade_date"]).first().reset_index()
    tot_oi = fo.groupby(["instrument_id", "trade_date"])["open_interest"].sum()
    days = (near["expiry"] - near["trade_date"]).dt.days.clip(lower=1)
    near["basis_ann"] = (near["close"] / near["underlying"] - 1) * 365 / days
    basis = near.pivot(index="trade_date", columns="instrument_id", values="basis_ann").reindex(idx)
    oi = tot_oi.unstack("instrument_id").reindex(idx)
    return {
        "fo_basis_ann": basis,
        "fo_oi_chg_5": oi / oi.shift(5) - 1,
        "fo_listed": oi.notna().astype(float).where(p.traded),
    }


FRONT_MIN_DAYS = 7          # expiry-week IV is dominated by gamma and pin noise: roll to the next


def option_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    idx = p.close.index
    od = read_df(conn, """
        SELECT instrument_id, trade_date, expiry, atm_iv, skew, call_oi, put_oi, call_vol, put_vol
        FROM alpha.option_daily WHERE trade_date BETWEEN %s AND %s""", (idx.min().date(), idx.max().date()))
    if od.empty:
        return {}
    od["trade_date"] = pd.to_datetime(od["trade_date"])
    od["expiry"] = pd.to_datetime(od["expiry"])
    od = od.sort_values(["instrument_id", "trade_date", "expiry"])
    live = od[(od["expiry"] - od["trade_date"]).dt.days >= FRONT_MIN_DAYS]
    g = live.groupby(["instrument_id", "trade_date"])
    front, nxt = g.nth(0).set_index(["instrument_id", "trade_date"]), g.nth(1).set_index(["instrument_id", "trade_date"])
    tot = od.groupby(["instrument_id", "trade_date"])[["call_oi", "put_oi", "call_vol", "put_vol"]].sum()

    def wide(s: pd.Series) -> pd.DataFrame:
        return s.unstack("instrument_id").reindex(index=idx)

    iv = wide(front["atm_iv"])
    rv = _rolling_std(np.log1p(p.close / p.close.shift(1) - 1), 21) * np.sqrt(252)   # same as vol_21, annualised
    ratio = lambda a, b: np.log(wide(tot[a]).replace(0, np.nan) / wide(tot[b]).replace(0, np.nan))  # noqa: E731
    return {
        "opt_iv_atm": iv,
        "opt_iv_rv": iv - rv.reindex(columns=iv.columns),
        "opt_iv_term": wide(nxt["atm_iv"]).reindex(columns=iv.columns) - iv,
        "opt_iv_chg_5": iv - iv.shift(5),
        "opt_skew": wide(front["skew"]),
        "opt_pcr_oi": ratio("put_oi", "call_oi"),
        "opt_pcr_vol": ratio("put_vol", "call_vol"),
    }


def event_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    """Days to the next announced results date, using only announcements knowable by t."""
    idx = p.close.index
    ev = read_df(conn, """SELECT instrument_id, event_date, knowable_at FROM alpha.corporate_event
                          WHERE event_type = 'results'""")
    ins = read_df(conn, """SELECT instrument_id, knowable_at, side, quantity * price AS value FROM alpha.deal
                           WHERE deal_type = 'insider' AND price IS NOT NULL""")
    out: dict[str, pd.DataFrame] = {}
    if not ev.empty:
        ev["event_date"] = pd.to_datetime(ev["event_date"])
        ev["known"] = _known_date(ev["knowable_at"])
        d2r = pd.DataFrame(np.inf, index=idx, columns=p.close.columns)
        tvals = idx.to_numpy()
        for r in ev.itertuples():
            if r.instrument_id not in d2r.columns:
                continue
            # an announcement is usable on sessions in [known, event_date)
            lo, hi = np.searchsorted(tvals, np.datetime64(r.known)), np.searchsorted(tvals, np.datetime64(r.event_date))
            if hi <= lo:
                continue
            days = (np.datetime64(r.event_date) - tvals[lo:hi]).astype("timedelta64[D]").astype(float)
            col = d2r[r.instrument_id].to_numpy()
            col[lo:hi] = np.minimum(col[lo:hi], days)
            d2r[r.instrument_id] = col
        out["days_to_results"] = d2r.replace(np.inf, np.nan).clip(upper=60)
    if not ins.empty:
        ins["known"] = _known_date(ins["knowable_at"])
        ins["signed"] = np.where(ins["side"] == "BUY", 1.0, -1.0) * ins["value"].astype(float)
        daily = ins.groupby(["known", "instrument_id"])["signed"].sum().unstack().reindex(idx).fillna(0.0)
        daily = daily.reindex(columns=p.close.columns, fill_value=0.0)
        adt = p.turnover.rolling(60, min_periods=20).mean()
        out["insider_net_63_adt"] = daily.rolling(63, min_periods=1).sum() / adt
    return out


def fundamental_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    fields = ("return_on_equity", "debt_to_equity", "price_to_book", "pe_ratio", "piotroski_score", "revenue_growth")
    df = read_df(conn, "SELECT instrument_id, field, value, knowable_at FROM alpha.fundamental WHERE field = ANY(%s) "
                       "AND source = 'investsights_fundamentals'", (list(fields),))
    if df.empty:
        return {}
    df["known"] = _known_date(df["knowable_at"])
    out = {}
    for f, g in df.groupby("field"):
        w = g.pivot_table(index="known", columns="instrument_id", values="value", aggfunc="last")
        # as-of join: forward-fill the latest KNOWN value onto trading dates (max 1 year stale)
        w = w.reindex(w.index.union(p.close.index)).sort_index().ffill(limit=260).reindex(p.close.index)
        out[f"fund_{f}"] = w.reindex(columns=p.close.columns)
    if "fund_pe_ratio" in out:
        out["fund_earnings_yield"] = 1 / out.pop("fund_pe_ratio").where(lambda x: x > 0)
    if "fund_price_to_book" in out:
        out["fund_book_yield"] = 1 / out.pop("fund_price_to_book").where(lambda x: x > 0)
    return out


REVISION_WINDOW = 63


def _asof_panel(df: pd.DataFrame, p: Panel, field: str, max_stale: int = 260) -> pd.DataFrame | None:
    g = df[df["field"] == field]
    if g.empty:
        return None
    w = g.pivot_table(index="known", columns="instrument_id", values="value", aggfunc="last")
    w = w.reindex(w.index.union(p.close.index)).sort_index().ffill(limit=max_stale).reindex(p.close.index)
    return w.reindex(columns=p.close.columns)


def estimate_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    """Analyst-estimate levels and REVISIONS, point in time (value as known on t vs as known
    REVISION_WINDOW sessions earlier)."""
    df = read_df(conn, "SELECT instrument_id, field, value, knowable_at FROM alpha.fundamental "
                       "WHERE source='mc_estimates'")
    if df.empty:
        return {}
    df["known"] = _known_date(df["knowable_at"])
    out: dict[str, pd.DataFrame] = {}
    buy = _asof_panel(df, p, "est_buy_pct")
    if buy is not None:
        out["est_buy_pct"] = buy
        out["est_buy_pct_chg"] = buy - buy.shift(REVISION_WINDOW)
    n = _asof_panel(df, p, "est_n_analysts")
    if n is not None:
        out["est_log_n_analysts"] = np.log1p(n)
    tgt = _asof_panel(df, p, "est_target_mean")
    if tgt is not None:
        out["est_target_upside"] = tgt / p.raw_close - 1       # vendor targets are in unadjusted rupees
        out["est_target_rev"] = tgt / tgt.shift(REVISION_WINDOW) - 1
    eps = _asof_panel(df, p, "est_eps_next")
    if eps is not None:
        rev = eps / eps.shift(REVISION_WINDOW) - 1
        # "next period" rolls forward when a period reports; a sign flip or a >100% jump is far
        # more likely a rollover or a restated base than a revision, so it is unknown, not huge
        same_sign = np.sign(eps) == np.sign(eps.shift(REVISION_WINDOW))
        out["est_eps_rev"] = rev.where(same_sign & (rev.abs() <= 1.0))
    return out


def universe_mask(p: Panel) -> pd.DataFrame:
    s = get_settings()
    adt20 = p.turnover.rolling(20, min_periods=15).mean()
    history = p.traded.cumsum()
    ok_series = p.series.isin(list(s.equity_series))
    return (p.traded & ok_series & (p.raw_close >= s.min_price_inr) & (adt20 >= s.min_adt_inr)
            & (history >= s.min_history_days))


def cs_rank_gauss(x: pd.DataFrame, mask: pd.DataFrame) -> pd.DataFrame:
    """Per-date rank within the eligible universe mapped to a standard normal; NaN stays NaN."""
    x = x.where(mask)
    r = x.rank(axis=1, method="average")
    n = x.notna().sum(axis=1)
    u = r.sub(0.5).div(n, axis=0)
    return pd.DataFrame(ndtri(u.clip(1e-6, 1 - 1e-6).to_numpy()), index=x.index, columns=x.columns).where(x.notna())


@dataclass
class FeatureFrame:
    data: pd.DataFrame          # long: index (date, instrument_id), columns = features
    stock_features: list[str]
    context_features: list[str]
    universe: pd.DataFrame      # wide bool mask

    @property
    def columns(self) -> list[str]:
        return self.stock_features + self.context_features


def build_features(conn: psycopg.Connection, p: Panel, dates: pd.DatetimeIndex | None = None) -> FeatureFrame:
    mask = universe_mask(p)
    raw: dict[str, pd.DataFrame] = {}
    raw.update(price_features(p))
    raw.update(fo_features(conn, p))
    raw.update(option_features(conn, p))
    raw.update(event_features(conn, p))
    raw.update(fundamental_features(conn, p))
    raw.update(estimate_features(conn, p))
    from bharat_alpha.legacy.screen import external_panels   # legacy columns that passed the evidence screen

    raw.update(external_panels(conn, p, only_admitted=True))
    sel = dates if dates is not None else p.close.index
    m = mask.loc[sel]
    stacked = {}
    for name, w in raw.items():
        w = w.reindex(index=p.close.index, columns=p.close.columns)
        z = cs_rank_gauss(w.loc[sel], m)
        if z.notna().to_numpy().sum() == 0:
            continue                                   # no coverage at all: not a feature today
        stacked[name] = z.stack(future_stack=True)
    long = pd.DataFrame(stacked)
    long.index.names = ["date", "instrument_id"]
    elig = m.stack(future_stack=True)
    long = long.loc[elig[elig].index.intersection(long.index)]
    ctx = market_context(conn, p).loc[sel]
    ctx_cols = [c for c in ctx.columns if ctx[c].notna().any()]
    long = long.join(ctx[ctx_cols], on="date")
    return FeatureFrame(long.sort_index(), sorted(stacked), ctx_cols, mask)


def panel_window(end: dt.date, lookback_sessions: int, conn: psycopg.Connection) -> tuple[dt.date, dt.date]:
    d = read_df(conn, "SELECT trade_date FROM alpha.trading_day WHERE trade_date <= %s ORDER BY 1 DESC LIMIT %s",
                (end, lookback_sessions))
    return d.trade_date.min(), d.trade_date.max()
