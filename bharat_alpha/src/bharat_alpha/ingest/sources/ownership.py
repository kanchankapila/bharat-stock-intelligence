"""Quarterly shareholding pattern (promoter / FII / MF / insurance / DII / public %, promoter
pledge %), imported from the legacy platform's `marketsmojo_shareholding_history`.

That table has the quarter (`period_date`) but no filing date, and its `fetched_at` is the
LATEST fetch (the writer overwrites it). Point-in-time comes from the regulation instead:
SEBI LODR Reg. 31(1)(b) requires the shareholding pattern within 21 days of quarter end, so a
quarter's figures are public by EOD of quarter_end + 21 days. A row fetched earlier than that
was public when fetched, so

    knowable_at = min(EOD(quarter_end + 21d), EOD(fetched_at))

Bounded, stated risk: a company that files LATE is stamped at the deadline, i.e. before its
data existed. Late filing draws exchange fines and is rare; its effect on a cross-sectional
rank feature is a handful of names for a few days per quarter.

The first import of a (stock, field, quarter) wins: a later fetch can only move `fetched_at`
later, never make the data earlier-known, so re-imports never restamp history.
"""
from __future__ import annotations

import datetime as dt
import math

import psycopg

from bharat_alpha.db import read_df, upsert
from bharat_alpha.timeutil import eod_knowable_at

SOURCE = "legacy_shareholding"
FILING_DEADLINE_DAYS = 21


def field_name(category: str) -> str:
    """legacy slug -> field: 'fii_holdings_pct' -> 'own_fii_holdings_pct'."""
    c = category.strip().lower()
    return "own_" + (c if c.endswith("_pct") else c + "_pct")


def knowable_for(period_end: dt.date, fetched: dt.date | None) -> dt.datetime:
    deadline = eod_knowable_at(period_end + dt.timedelta(days=FILING_DEADLINE_DAYS))
    if fetched is None:
        return deadline
    return min(deadline, eod_knowable_at(max(fetched, period_end)))


def _date(v) -> dt.date | None:
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def import_legacy_shareholding(conn: psycopg.Connection, legacy: psycopg.Connection) -> dict:
    with legacy.cursor() as cur:
        cur.execute("SELECT symbol, category, period_date, value, fetched_at FROM public.marketsmojo_shareholding_history")
        hist = cur.fetchall()
    cur_syms = read_df(conn, """SELECT DISTINCT ON (instrument_id) instrument_id, symbol FROM alpha.symbol_history
                                ORDER BY instrument_id, valid_from DESC""")
    s2i = dict(zip(cur_syms.symbol, cur_syms.instrument_id.astype(int)))
    have = read_df(conn, "SELECT instrument_id, field, period_end FROM alpha.fundamental WHERE source=%s", (SOURCE,))
    seen = {(int(i), f, pe) for i, f, pe in have.itertuples(index=False)}
    rows, unresolved, bad = [], 0, 0
    for sym, cat, period, value, fetched in hist:
        iid = s2i.get(str(sym or "").upper())
        pe = _date(period)
        if iid is None:
            unresolved += 1
            continue
        v = float(value) if value is not None else None
        if pe is None or v is None or not math.isfinite(v) or not 0 <= v <= 100:
            bad += 1
            continue
        key = (iid, field_name(cat), pe)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"source": SOURCE, "instrument_id": iid, "field": key[1], "period_end": pe, "value": v,
                     "knowable_at": knowable_for(pe, _date(fetched))})
    n = upsert(conn, "alpha.fundamental", rows, key=("source", "instrument_id", "field", "knowable_at"), update=())
    conn.commit()
    return {"rows_read": len(hist), "rows_written": n, "unresolved_symbol": unresolved, "invalid": bad}
