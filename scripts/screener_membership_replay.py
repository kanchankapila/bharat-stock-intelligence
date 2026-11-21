"""Point-in-time screener membership, rebuilt from `screener_appearances` episodes (AF-20261106-04).

Two definitions, both computed from the same episode table so a comparison is paired:

  old  production's `load_today_appearances`: the episode appeared within the last 3 calendar days and is
       not yet exited (`exited_date IS NULL OR exited_date >= D`), plus `appeared_date <= D`, which changes
       nothing on the live date and is what bounds a past date.
  new  every episode open on D (`appeared_date <= D AND (exited_date IS NULL OR exited_date >= D)`), minus
       episodes whose provider stopped confirming them: an episode still open today needs the matching
       `*_screener_stocks.last_seen` to be within GRACE_DAYS of D. A sync refreshes `last_seen` on every
       current member, so a stale value is a dead sync, not a stable membership (measured 2026-11-21: every
       open episode has its row; MoneyControl and Trendlyne all seen on the latest sync).

The 20 screener ids that two providers share are dropped from BOTH arms: until AF-20261120-06's migration an
exit by one provider could close the other's episode, so those episodes are not trustworthy.
Read-only; never writes.
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/server"))

GRACE_DAYS = 3          # same width as production's own appeared_date window
OLD_WINDOW_DAYS = 3

STOCK_TABLES = {        # source -> (table, screener key column)
    "etnow": ("etnow_screener_stocks", "screener_id"),
    "moneycontrol": ("moneycontrol_screener_stocks", "scan_id"),
    "trendlyne": ("trendlyne_screener_stocks", "screener_id"),
    "et_marketstats": ("et_marketstats_screener_stocks", "screener_key"),
}


def load_episodes(con, since: dt.date) -> pd.DataFrame:
    """Episodes that can matter from `since` on: open now, or exited on/after `since`."""
    rows = con.execute(
        "SELECT LOWER(source) AS source, screener_id, symbol, appeared_date::date::text AS a, "
        "exited_date::date::text AS x FROM screener_appearances "
        "WHERE exited_date IS NULL OR exited_date::date >= ?", (since.isoformat(),)).fetchall()
    df = pd.DataFrame([tuple(r) for r in rows], columns=["source", "screener_id", "symbol", "a", "x"])
    df["a"] = pd.to_datetime(df["a"])
    df["x"] = pd.to_datetime(df["x"])
    return df


def shared_screener_ids(con) -> set[tuple[str, str]]:
    """(source, screener_id) pairs whose screener_id is also used by another provider."""
    rows = con.execute(
        "SELECT screener_id, LOWER(source) FROM screener_appearances GROUP BY 1, 2").fetchall()
    by_id: dict[str, set[str]] = {}
    for sid, src in map(tuple, rows):
        by_id.setdefault(sid, set()).add(src)
    return {(src, sid) for sid, srcs in by_id.items() if len(srcs) > 1 for src in srcs}


def load_last_seen(con) -> pd.DataFrame:
    """Latest confirmation date per (source, screener_id, symbol) for every membership still held."""
    frames = []
    for source, (table, key) in STOCK_TABLES.items():
        rows = con.execute(f"SELECT {key}, symbol, last_seen FROM {table}").fetchall()
        f = pd.DataFrame([tuple(r) for r in rows], columns=["screener_id", "symbol", "last_seen"])
        f["source"] = source
        frames.append(f)
    out = pd.concat(frames, ignore_index=True)
    out["last_seen"] = pd.to_datetime(out["last_seen"], errors="coerce")
    return out


def attach_last_seen(ep: pd.DataFrame, last_seen: pd.DataFrame) -> pd.DataFrame:
    return ep.merge(last_seen, on=["source", "screener_id", "symbol"], how="left")


def drop_shared(ep: pd.DataFrame, shared: set[tuple[str, str]]) -> pd.DataFrame:
    if not shared:
        return ep
    key = list(zip(ep["source"], ep["screener_id"]))
    return ep[[k not in shared for k in key]]


def old_arm(ep: pd.DataFrame, day: dt.date) -> pd.DataFrame:
    d = pd.Timestamp(day)
    m = (ep["a"] <= d) & (ep["a"] >= d - pd.Timedelta(days=OLD_WINDOW_DAYS)) & (ep["x"].isna() | (ep["x"] >= d))
    return ep[m]


def new_arm(ep: pd.DataFrame, day: dt.date, grace_days: int = GRACE_DAYS) -> pd.DataFrame:
    """`ep` must carry `last_seen` (attach_last_seen). Closed episodes stay members until their exit."""
    d = pd.Timestamp(day)
    is_open = (ep["a"] <= d) & (ep["x"].isna() | (ep["x"] >= d))
    still_open_now = ep["x"].isna()
    confirmed = ep["last_seen"].notna() & (ep["last_seen"] >= d - pd.Timedelta(days=grace_days))
    return ep[is_open & (~still_open_now | confirmed)]


def by_symbol(members: pd.DataFrame) -> dict[str, list[tuple[str, str]]]:
    out: dict[str, list[tuple[str, str]]] = {}
    for symbol, src, sid in zip(members["symbol"], members["source"], members["screener_id"]):
        out.setdefault(symbol, []).append((src, sid))
    return out


def features(members: pd.DataFrame, meta: dict, compute) -> pd.DataFrame:
    """Per-symbol screener features through the production `compute_features`."""
    rows = {s: compute(s, ids, meta) for s, ids in by_symbol(members).items()}
    return pd.DataFrame.from_dict(rows, orient="index")


def paired_stats(values) -> dict:
    a = np.asarray(values, dtype=float)
    a = a[np.isfinite(a)]
    n = len(a)
    if n < 2 or a.std(ddof=1) == 0:
        return {"dates": n, "mean": float(a.mean()) if n else None, "t": None}
    return {"dates": n, "mean": float(a.mean()), "t": float(a.mean() / (a.std(ddof=1) / np.sqrt(n)))}
