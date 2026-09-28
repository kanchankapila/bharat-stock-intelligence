"""Import mapped legacy columns into alpha.external_fact, point in time.

knowable_at per entry (see legacy.MapEntry.knowable):
  capture:<col>    the row's capture timestamp, never earlier than the observed date's EOD
  timestamp:<col>  the row's own event timestamp
  eod_plus:<h>     the observed date's 15:30 IST close + h hours

`eod_plus` tables have no capture time, and in the legacy platform they are MUTABLE: fetchers
UPDATE past dates in place (recurring-bugs: `ELSE NULL` / backfill classes). Their history
therefore cannot prove what was known when, so by default they are imported FORWARD ONLY:
rows observed before the first import are skipped unless `allow_history=True` is passed
explicitly (and then every such fact is optimistic, which the evidence screen should be told).
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

import pandas as pd
import psycopg
from psycopg import sql

from bharat_alpha.db import read_df, upsert
from bharat_alpha.legacy import MapEntry
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import IST

CLOSE = dt.time(15, 30)


def _as_ts(v) -> dt.datetime | None:
    if v is None:
        return None
    t = pd.Timestamp(v)
    if pd.isna(t):
        return None
    if t.tzinfo is None:
        t = t.tz_localize(IST)
    return t.to_pydatetime()


def _as_date(v) -> dt.date | None:
    t = _as_ts(v)
    return t.astimezone(IST).date() if t else None


def knowable_at(entry: MapEntry, observed: dt.date, row: dict) -> dt.datetime | None:
    kind, _, arg = entry.knowable.partition(":")
    eod = dt.datetime.combine(observed, CLOSE, tzinfo=IST)
    if kind == "capture":
        cap = _as_ts(row.get(arg))
        return max(cap, eod) if cap else None          # no capture time -> not provably knowable
    if kind == "timestamp":
        return _as_ts(row.get(arg))
    if kind == "eod_plus":
        return eod + dt.timedelta(hours=float(arg))
    return None


def write_change_only(conn: psycopg.Connection, rows: list[dict]) -> int:
    """rows: {source, instrument_id, field, value, observed_date, knowable_at}; stores a row only
    when the value differs from the latest stored value for that (source, instrument, field)."""
    if not rows:
        return 0
    sources = sorted({r["source"] for r in rows})
    latest = read_df(conn, """SELECT DISTINCT ON (source, instrument_id, field) source, instrument_id, field, value
                              FROM alpha.external_fact WHERE source = ANY(%s)
                              ORDER BY source, instrument_id, field, knowable_at DESC""", (sources,))
    last = {(s, int(i), f): v for s, i, f, v in latest.itertuples(index=False)}
    new = []
    for r in sorted(rows, key=lambda x: x["knowable_at"]):
        k = (r["source"], r["instrument_id"], r["field"])
        if last.get(k, object()) != r["value"]:
            new.append(r)
            last[k] = r["value"]
    return upsert(conn, "alpha.external_fact", new, key=("source", "instrument_id", "field", "knowable_at"), update=())


def import_entries(conn: psycopg.Connection, legacy: psycopg.Connection, entries: list[MapEntry],
                   since: dt.date | None = None, allow_history: bool = False) -> dict:
    by_table: dict[str, list[MapEntry]] = defaultdict(list)
    for e in entries:
        if e.enabled and e.status == "ready":
            by_table[e.table].append(e)
    res = SymbolResolver(conn)
    stats: dict = {}
    for table, es in by_table.items():
        src = f"legacy:{table}"
        e0 = es[0]
        first = read_df(conn, "SELECT min(knowable_at) AS t FROM alpha.external_fact WHERE source=%s", (src,)).t[0]
        floor = since
        if e0.knowable.startswith("eod_plus") and not allow_history:
            # forward only: nothing observed before this table's first import
            first_date = pd.Timestamp(first).date() if first is not None else dt.datetime.now(IST).date()
            floor = max(floor or first_date, first_date)
        kind, _, arg = e0.knowable.partition(":")
        extra = [arg] if kind in ("capture", "timestamp") and arg not in (e0.date_col,) else []
        cols = [e0.symbol_col, e0.date_col, *extra, *[e.column for e in es]]
        q = sql.SQL("SELECT {cols} FROM {t}").format(
            cols=sql.SQL(", ").join(map(sql.Identifier, cols)), t=sql.Identifier("public", table))
        params: list = []
        if floor is not None:
            q = q + sql.SQL(" WHERE {d} >= %s").format(d=sql.Identifier(e0.date_col))
            params.append(floor if kind != "timestamp" else floor.isoformat())
        with legacy.cursor() as cur:
            cur.execute(q, params)
            fetched = cur.fetchall()
        rows, skipped = [], 0
        for t in fetched:
            r = dict(zip(cols, t))
            observed = _as_date(r[e0.date_col])
            iid = res.lookup(str(r[e0.symbol_col] or "").upper(), observed) if observed else None
            kat = knowable_at(e0, observed, r) if observed else None
            if iid is None or kat is None:
                skipped += 1
                continue
            for e in es:
                v = r[e.column]
                if v is None:
                    continue
                rows.append({"source": src, "instrument_id": iid, "field": e.column, "value": float(v),
                             "observed_date": observed, "knowable_at": kat})
        stats[table] = {"rows_read": len(fetched), "unresolved_or_unknowable": skipped,
                        "facts_written": write_change_only(conn, rows), "since": str(floor) if floor else None}
    conn.commit()
    return stats
