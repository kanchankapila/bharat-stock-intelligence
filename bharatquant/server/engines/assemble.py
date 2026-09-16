"""Assembly layer — runs all engines, applies eligibility & no-trade filters,
builds the unified recommendation tables the API serves. Cached.
Single daily-feature pass shared by all engines.
"""
import logging
import numpy as np
import pandas as pd

from ..db import qdf
from ..cache import CACHE
from .. import config
from ..data import loaders
from . import indicators as ind
from . import intraday as intraday_eng
from . import swing as swing_eng
from . import long_term as long_eng

log = logging.getLogger("bq.assemble")

_TTL = 30 * 60        # 30 min for daily panels
MIN_TURNOVER = 3e6    # Rs 30 lakh 20d avg turnover absolute floor
MAX_GSM = ("GSM",)


def _filters(df, min_turnover=MIN_TURNOVER):
    if len(df) == 0:
        return df
    m = (df["turnover_20d"].fillna(0) >= min_turnover) & \
        (df["close"].fillna(0) >= config.MIN_PRICE)
    if "gsm_stage" in df.columns:
        m &= ~(df["gsm_stage"].isin(MAX_GSM))
    return df[m]


def _latest_date(df):
    mx = df["date"].max()
    if pd.isna(mx):
        return ""
    return str(mx.date() if hasattr(mx, "date") else mx)


def build_full_features(daily, univ, fund, val) -> pd.DataFrame:
    """One feature pass shared by swing + long-term + intraday context."""
    df = swing_eng.build_features(daily, univ, fund, val)       # swing extras + merges
    df = intraday_eng.build_daily_features(df)                  # d1_ret, gap, vol_surge, tiers
    df = intraday_eng.assign_tiers(df)
    df = long_eng.add_long_features(df)                          # 63d/252d ret, slope
    return df
def run_all(force: bool = False) -> dict:
    ck = "bq:board:v1"
    if not force:
        hit = CACHE.get(ck)
        if hit:
            return hit

    univ = loaders.universe()
    daily = loaders.daily_all(900)
    val = loaders.valuation_snapshot()
    fund = loaders.fundamentals_latest()
    intra_days = loaders.intraday_days_liquid(1)
    last_intra_day = intra_days.iloc[0]["day"].strftime("%Y-%m-%d") if len(intra_days) else None

    feat = build_full_features(daily, univ, fund, val)

    # ---- intraday board (live-session logic shared with research) ----
    i_board = pd.DataFrame()
    if last_intra_day:
        bars = loaders.intraday_session(last_intra_day)
        if len(bars):
            i_board = intraday_eng.intraday_board(feat, bars)
            if len(i_board):
                i_board["date"] = last_intra_day

    # ---- swing ----
    swing = swing_eng.score(feat)
    swing = _filters(swing) if len(swing) else swing
    cols = ["symbol", "close", "ret_1d", "ret_5d", "final", "bq_rank", "stop",
            "target", "risk_reward", "rsi14", "atr14", "turnover_20d", "date", "sector"]
    swing_out = swing[[c for c in cols if c in swing.columns]].copy()
    if len(swing_out):
        swing_out["name"] = swing_out["symbol"].map(univ.set_index("symbol")["name"])

    # ---- long-term (scores the same feature frame; no second full build) ----
    lt = long_eng.score(feat)
    lt = _filters(lt)
    lt["name"] = lt["symbol"].map(univ.set_index("symbol")["name"])

    swing_top = swing_out.dropna(subset=["final"]).nlargest(10, "final") if len(swing_out) else swing_out
    i_top = i_board.nsmallest(10, "co_rank") if len(i_board) else i_board
    lt_top = lt.dropna(subset=["final"]).nlargest(10, "final") if len(lt) else lt

    result = {
        "as_of": _latest_date(feat),
        "intraday_day": last_intra_day,
        "universe": int(len(feat)),
        "computed_at": pd.Timestamp.now().isoformat(),
        "intraday": _rows(i_top),
        "swing": _rows(swing_top),
        "long_term": _rows(lt_top),
        "regime": _regime(),
        "breadth": _breadth(),
    }
    CACHE.set(ck, result, ttl_seconds=_TTL)
    return result
def _rows(tbl):
    if len(tbl) == 0:
        return []
    return [_sanitize(r) for r in tbl.to_dict("records")]


def _sanitize(obj):
    """Recursively make a dict/list JSON-safe (replace inf/nan, numpy/types)."""
    import datetime
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        v = float(obj)
        return round(v, 4) if np.isfinite(v) else None
    if isinstance(obj, float):
        return round(obj, 4) if np.isfinite(obj) else None
    if isinstance(obj, np.ndarray):
        return _sanitize(obj.tolist())
    if isinstance(obj, (pd.Timestamp, datetime.date, datetime.datetime)):
        return obj.isoformat() if hasattr(obj, "isoformat") else str(obj)
    return obj


def _regime():
    r = loaders.regimes(15)
    return str(r.iloc[-1]["regime"]) if len(r) else "UNKNOWN"


def _breadth():
    try:
        b = qdf("""
            SELECT breadth_score FROM intraday_breadth_snapshots
            WHERE snapshot_at = (SELECT max(snapshot_at) FROM intraday_breadth_snapshots);
        """)
        return float(b.iloc[0]["breadth_score"]) if len(b) else 0.5
    except Exception:
        return 0.5


def stock_detail(symbol: str, lookback: int = 600) -> dict:
    univ = loaders.universe()
    daily = loaders.daily_all(lookback)
    feat = build_full_features(daily, univ, None, None)
    row = feat[feat["symbol"] == symbol]
    if len(row) == 0:
        return {"found": False}
    last = row.groupby("symbol").tail(1).iloc[0]
    pe = loaders.pe_history(symbol)
    pb = loaders.pb_history(symbol)
    news = loaders.news_for_symbol(symbol)
    opt = loaders.options_oi_recent(120)
    fut = loaders.futures_oi_recent(30)
    deliv = loaders.delivery_recent(120)
    intra_days = loaders.intraday_days_liquid(1)
    bars = []
    if len(intra_days):
        bars = loaders.intraday_session(intra_days.iloc[0]["day"].strftime("%Y-%m-%d"))
        if len(bars):
            bars = bars[bars["symbol"] == symbol]
    fund = loaders.fundamentals_latest()
    fund_row = fund[fund["symbol"] == symbol].head(1)
    univ_row = univ[univ["symbol"] == symbol].head(1)

    return {
        "found": True,
        "profile": _sanitize_dict(univ_row.to_dict("records")[0]) if len(univ_row) else {},
        "fundamentals": _sanitize_dict(fund_row.to_dict("records")[0]) if len(fund_row) else {},
        "price": float(last["close"]) if pd.notna(last["close"]) else None,
        "prev_close": float(last["prev_close"]) if pd.notna(last["prev_close"]) else None,
        "ret_1d": float(last["ret_1d"]) if pd.notna(last.get("ret_1d")) else None,
        "ret_5d": float(last["ret_5d"]) if pd.notna(last.get("ret_5d")) else None,
        "ret_21d": float(last["ret_21d"]) if pd.notna(last.get("ret_21d")) else None,
        "atr14": float(last["atr14"]) if pd.notna(last.get("atr14")) else None,
        "tier": str(last["tier"]),
        "series": _series(daily[daily["symbol"] == symbol]),
        "pe": _sanitize(pe.to_dict("records")),
        "pb": _sanitize(pb.to_dict("records")),
        "options_oi": _sanitize(opt[opt["symbol"] == symbol].to_dict("records")),
        "futures_oi": _sanitize(fut[fut["symbol"] == symbol].to_dict("records")),
        "delivery": _sanitize(deliv[deliv["symbol"] == symbol].to_dict("records")),
        "news": _sanitize(news.to_dict("records")),
        "intraday_bars": _series(bars, intraday=True),
    }


def _sanitize_dict(d):
    return _sanitize(d) if d else {}


def _series(df, intraday=False):
    if len(df) == 0:
        return []
    out = df.sort_values("datetime") if intraday else df.sort_values("date")
    recs = []
    for _, r in out.iterrows():
        if intraday:
            recs.append({"t": str(r["datetime"].tz_convert("Asia/Kolkata").strftime("%H:%M")),
                         "open": float(r["open"]), "high": float(r["high"]),
                         "low": float(r["low"]), "close": float(r["close"]),
                         "volume": int(r["volume"])})
        else:
            d = r["date"]
            ds = str(d.date() if hasattr(d, "date") else d)
            recs.append({"date": ds, "open": float(r["open"]),
                         "high": float(r["high"]), "low": float(r["low"]),
                         "close": float(r["close"]), "volume": int(r["volume"])})
    return recs