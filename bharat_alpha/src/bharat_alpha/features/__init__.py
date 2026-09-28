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
    ctx = ctx.join(participant_positioning(conn, idx))
    ctx = ctx.join(global_cues(conn, idx))
    return ctx


def global_cues(conn: psycopg.Connection, idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Overnight global moves, computed on each series' own calendar, then placed on the NSE
    session their knowable_at allows (the US close of D -> the NSE session after D)."""
    ms = read_df(conn, "SELECT series, obs_date, value, knowable_at FROM alpha.macro_series WHERE obs_date BETWEEN %s AND %s",
                 (idx.min().date() - dt.timedelta(days=30), idx.max().date()))
    out = pd.DataFrame(index=idx)
    if ms.empty:
        return out
    metrics: dict[str, pd.Series] = {}
    for s, g in ms.sort_values("obs_date").groupby("series"):
        v = g.set_index(_known_date(g["knowable_at"]).to_numpy())["value"]
        v = v[~v.index.duplicated(keep="last")]
        if s in ("SP500", "NASDAQCOM"):
            name = "us_spx" if s == "SP500" else "us_ndx"
            metrics[f"{name}_ret_1"] = np.log(v).diff()
            metrics[f"{name}_ret_5"] = np.log(v).diff(5)
        elif s == "VIXCLS":
            metrics["us_vix"] = v
            metrics["us_vix_chg_5"] = v / v.shift(5) - 1
        elif s == "DGS10":
            metrics["us_10y_chg_5"] = v.diff(5)
        elif s in ("DTWEXBGS", "DCOILBRENTEU", "DEXINUS"):
            metrics[{"DTWEXBGS": "usd_broad_ret_5", "DCOILBRENTEU": "brent_ret_5", "DEXINUS": "usdinr_ret_5"}[s]] = \
                np.log(v).diff(5)
    for name, m in metrics.items():
        out[name] = m.reindex(m.index.union(idx)).sort_index().ffill(limit=5).reindex(idx)
    return out


def participant_positioning(conn: psycopg.Connection, idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Who is net long index futures, and how FIIs lean in index options, as of each session.
    Rows are placed on the session their knowable_at allows (the evening file -> next session)."""
    po = read_df(conn, "SELECT participant, instrument, long_oi, short_oi, knowable_at FROM alpha.participant_oi "
                       "WHERE trade_date BETWEEN %s AND %s", (idx.min().date() - dt.timedelta(days=10), idx.max().date()))
    out = pd.DataFrame(index=idx)
    if po.empty:
        return out
    po["known"] = _known_date(po["knowable_at"])

    def series(who: str, inst: str, side: str) -> pd.Series:
        s = po[(po.participant == who) & (po.instrument == inst)].set_index("known")[side]
        return s[~s.index.duplicated(keep="last")].reindex(s.index.union(idx)).sort_index().ffill(limit=3).reindex(idx)

    def net(who: str, inst: str) -> pd.Series:
        lo, sh = series(who, inst, "long_oi"), series(who, inst, "short_oi")
        return (lo - sh) / (lo + sh).replace(0, np.nan)

    for who in ("FII", "PRO", "CLIENT"):
        out[f"{who.lower()}_idxfut_net"] = net(who, "fut_idx")
    out["fii_idxfut_net_chg_5"] = out["fii_idxfut_net"] - out["fii_idxfut_net"].shift(5)
    call = series("FII", "opt_idx_call", "long_oi") - series("FII", "opt_idx_call", "short_oi")
    put = series("FII", "opt_idx_put", "long_oi") - series("FII", "opt_idx_put", "short_oi")
    gross = sum(series("FII", i, s) for i in ("opt_idx_call", "opt_idx_put") for s in ("long_oi", "short_oi"))
    out["fii_idxopt_bias"] = (call - put) / gross.replace(0, np.nan)      # >0: long calls / short puts
    return out


def ban_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    """F&O ban status as of each session. A date with no processed ban file is unknown (NaN),
    not 'not banned'; a date with a file marks every other name 0."""
    idx = p.close.index
    days = read_df(conn, "SELECT trade_date, knowable_at FROM alpha.fo_ban_day WHERE trade_date BETWEEN %s AND %s",
                   (idx.min().date(), idx.max().date()))
    if days.empty:
        return {}
    bans = read_df(conn, "SELECT trade_date, instrument_id FROM alpha.fo_ban WHERE trade_date BETWEEN %s AND %s",
                   (idx.min().date(), idx.max().date()))
    known = pd.DatetimeIndex(_known_date(days["knowable_at"]))
    covered = pd.Series(True, index=known).reindex(idx, fill_value=False)
    flag = pd.DataFrame(0.0, index=idx, columns=p.close.columns)
    if not bans.empty:
        bans["known"] = _known_date(days.set_index("trade_date").loc[bans["trade_date"], "knowable_at"]).to_numpy()
        hit = bans[bans["known"].isin(idx) & bans["instrument_id"].isin(flag.columns)]
        for d, i in zip(hit["known"], hit["instrument_id"]):
            flag.at[d, i] = 1.0
    flag = flag.where(covered, axis=0)
    f = flag.fillna(0)
    run = f.apply(lambda s: s.groupby((s != s.shift()).cumsum()).cumsum())    # consecutive sessions in ban
    return {
        "fo_ban": flag,
        "fo_ban_days": run.where(flag.notna()),
        "fo_ban_exit": ((flag == 0) & (flag.shift(1) == 1)).astype(float).where(flag.notna()),
    }


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


EAR_HOLD = 63                    # post-announcement drift horizon in the literature: about one quarter
EAR_BASE = (25, 5)               # abnormal-volume baseline: sessions -25..-6 before the reaction day
RESCHEDULE_DAYS = 30             # two intimations this close for one stock = one meeting, rescheduled


MARKET_CLOSE_IST = dt.time(15, 30)


def _results_dates(ev: pd.DataFrame) -> pd.DataFrame:
    """One reaction date per results announcement.

    An exchange FILING ('results_filed', exact time) wins: filed before the close, the reaction
    starts that day; filed after, the next day. Otherwise board-meeting intimations are used, and
    when several for one stock fall within RESCHEDULE_DAYS the later-ANNOUNCED one is the meeting
    that happened. A filing supersedes every intimation within RESCHEDULE_DAYS of it."""
    if "event_type" not in ev:
        ev = ev.assign(event_type="results")
    filed = ev[ev["event_type"] == "results_filed"].copy()
    local = pd.to_datetime(filed["knowable_at"], utc=True).dt.tz_convert("Asia/Kolkata")
    after = local.dt.time >= MARKET_CLOSE_IST
    filed["event_date"] = local.dt.tz_localize(None).dt.normalize() + pd.to_timedelta(after.astype(int), unit="D")
    keep = [(int(i), d) for i, d in zip(filed["instrument_id"], filed["event_date"])]
    pinned: dict[int, list] = {}
    for i, d in keep:
        pinned.setdefault(i, []).append(d)
    ev = ev[ev["event_type"] == "results"].sort_values(["instrument_id", "event_date"])
    for iid, g in ev.groupby("instrument_id"):
        near = pinned.get(int(iid), [])
        cluster: list = []
        for r in g.itertuples():
            if any(abs((r.event_date - d).days) <= RESCHEDULE_DAYS for d in near):
                continue
            if cluster and (r.event_date - cluster[0].event_date).days > RESCHEDULE_DAYS:
                keep.append((int(iid), max(cluster, key=lambda x: x.knowable_at).event_date))
                cluster = []
            cluster.append(r)
        if cluster:
            keep.append((int(iid), max(cluster, key=lambda x: x.knowable_at).event_date))
    return pd.DataFrame(keep, columns=["instrument_id", "event_date"])


def earnings_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    """Earnings-announcement return (EAR) and volume shock. EAR = the stock's return over the
    reaction day (first session on/after the results date) and the next, minus the cross-sectional
    median; it is first usable at the close of day +1 and carried EAR_HOLD sessions. The drift
    that follows a surprise is what it is meant to capture; the gate decides whether it does here."""
    ev = read_df(conn, "SELECT instrument_id, event_type, event_date, knowable_at FROM alpha.corporate_event "
                       "WHERE event_type IN ('results', 'results_filed')")
    if ev.empty:
        return {}
    ev["event_date"] = pd.to_datetime(ev["event_date"])
    ev = _results_dates(ev)
    idx, cols = p.close.index, p.close.columns
    ret = p.close / p.close.shift(1) - 1
    ar = ret.sub(ret.median(axis=1), axis=0).to_numpy()
    vol = p.volume.where(p.traded).to_numpy(dtype=float)
    ear = np.full(ar.shape, np.nan)
    shock = np.full(ar.shape, np.nan)
    age = np.full(ar.shape, np.nan)
    pos = {c: j for j, c in enumerate(cols)}
    for r in ev.sort_values("event_date").itertuples():
        j = pos.get(r.instrument_id)
        s0 = int(np.searchsorted(idx.to_numpy(), np.datetime64(r.event_date)))
        if j is None or s0 < EAR_BASE[0] or s0 + 1 >= len(idx):
            continue
        e = ar[s0, j] + ar[s0 + 1, j]
        if not np.isfinite(e):
            continue
        base = np.nanmean(vol[s0 - EAR_BASE[0]:s0 - EAR_BASE[1], j])
        end = min(s0 + 1 + EAR_HOLD, len(idx))
        ear[s0 + 1:end, j] = e                       # a later announcement overwrites from its own day +1
        with np.errstate(divide="ignore", invalid="ignore"):
            shock[s0 + 1:end, j] = np.log(np.nanmean(vol[s0:s0 + 2, j]) / base)
        age[s0 + 1:end, j] = np.arange(end - s0 - 1)
    frame = lambda a: pd.DataFrame(a, index=idx, columns=cols)  # noqa: E731
    return {"earn_ear": frame(ear), "earn_vol_shock": frame(np.where(np.isfinite(shock), shock, np.nan)),
            "earn_age": frame(age)}


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


OWNERSHIP_MAX_STALE = 130        # a quarter's pattern is superseded ~91 days later; 2 quarters stale = unknown
QUARTER_GAP_DAYS = (80, 100)     # a QoQ change needs the IMMEDIATELY preceding quarter, not a gap


def ownership_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    """Quarterly shareholding levels and quarter-on-quarter changes, as of each filing's
    knowable_at (see ingest.sources.ownership for how that is bounded)."""
    from bharat_alpha.ingest.sources.ownership import SOURCE

    df = read_df(conn, "SELECT instrument_id, field, period_end, value, knowable_at FROM alpha.fundamental "
                       "WHERE source = %s", (SOURCE,))
    if df.empty:
        return {}
    df = df.sort_values(["instrument_id", "field", "period_end"])
    prev = df.groupby(["instrument_id", "field"])[["period_end", "value"]].shift(1)
    gap = (pd.to_datetime(df["period_end"]) - pd.to_datetime(prev["period_end"])).dt.days
    chg = (df["value"] - prev["value"]).where(gap.between(*QUARTER_GAP_DAYS))
    df["known"] = _known_date(df["knowable_at"])
    both = pd.concat([df, df.assign(field=df["field"] + "_qoq", value=chg).dropna(subset=["value"])])
    return {f: w for f in both["field"].unique()
            if (w := _asof_panel(both, p, f, OWNERSHIP_MAX_STALE)) is not None}


YOY_GAP_DAYS = (350, 380)         # the same quarter one year earlier, not a neighbouring one
RESULTS_MAX_STALE = 130


def results_features(conn: psycopg.Connection, p: Panel) -> dict[str, pd.DataFrame]:
    """Year-on-year change in reported quarterly EPS scaled by price (a standardised-surprise
    proxy: the seasonal random-walk expectation) and revenue growth, as of each quarter's
    knowable_at (see ingest.sources.nse_results)."""
    from bharat_alpha.ingest.sources.nse_results import SOURCE

    df = read_df(conn, "SELECT instrument_id, field, period_end, value, knowable_at FROM alpha.fundamental "
                       "WHERE source = %s AND field IN ('res_eps', 'res_revenue_lakh')", (SOURCE,))
    if df.empty:
        return {}
    df["period_end"] = pd.to_datetime(df["period_end"])
    rows = []
    for (iid, field), g in df.sort_values("period_end").groupby(["instrument_id", "field"]):
        by_pe = g.set_index("period_end")
        for pe, r in by_pe.iterrows():
            prior = by_pe[(pe - by_pe.index).days.to_series(index=by_pe.index).between(*YOY_GAP_DAYS)]
            if prior.empty:
                continue
            base = prior["value"].iloc[-1]
            if field == "res_eps":
                rows.append((iid, "eps_yoy", r["value"] - base, r["knowable_at"]))
            elif base > 0:
                rows.append((iid, "res_revenue_yoy", r["value"] / base - 1, r["knowable_at"]))
    if not rows:
        return {}
    ch = pd.DataFrame(rows, columns=["instrument_id", "field", "value", "knowable_at"])
    ch["known"] = _known_date(ch["knowable_at"])
    out = {}
    eps = _asof_panel(ch, p, "eps_yoy", RESULTS_MAX_STALE)
    if eps is not None:
        out["res_eps_yoy_px"] = eps / p.raw_close.where(p.raw_close > 0)    # EPS is in unadjusted rupees
    rev = _asof_panel(ch, p, "res_revenue_yoy", RESULTS_MAX_STALE)
    if rev is not None:
        out["res_revenue_yoy"] = rev.clip(-1, 5)
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
    raw.update(ban_features(conn, p))
    raw.update(option_features(conn, p))
    raw.update(event_features(conn, p))
    raw.update(earnings_features(conn, p))
    raw.update(fundamental_features(conn, p))
    raw.update(estimate_features(conn, p))
    raw.update(ownership_features(conn, p))
    raw.update(results_features(conn, p))
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
