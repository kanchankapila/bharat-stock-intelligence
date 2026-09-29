"""Quarterly shareholding pattern, collected FORWARD from MarketsMojo
(`Stocks_Shareholding/get_results`) — the same endpoint that produced the legacy
`marketsmojo_shareholding_history` table `ingest.sources.ownership` imports.

Without this, ownership features stop the day the legacy import stops: `ownership.py` is an
importer, not a connector, so every `own_*` fact is frozen at the legacy table's last quarter.

Point-in-time is the SEBI rule, not the fetch time, and is shared with the importer
(`ownership.knowable_for`): SEBI LODR Reg. 31(1)(b) gives 21 days after quarter end, and a row
seen earlier than that was public when seen. **The first sighting of a (stock, field, quarter)
wins across BOTH sources** — a quarter already imported from the legacy table is never rewritten
here, so re-running can only add quarters, never restamp history.

Response shape and its quirk are from the legacy fetcher, live-verified 2026-08-11:
`data.shareholding_graphs.data` is a list of blocks; the Promoter block nests TWO series (holding
%, then pledged %) inside its `data`, while every other block's `data` is a flat list of points.
Points are `{"name": 202506, "y": 12.34}` — `name` is the reporting month, stamped to that
month's last day. Keyed on MarketsMojo's sid from alpha.provider_id (ambiguous ids excluded),
never constructed from the symbol.
"""
from __future__ import annotations

import datetime as dt
import re
from calendar import monthrange

import psycopg

from bharat_alpha.db import read_df, upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import FetchError, HttpClient
from bharat_alpha.ingest.sources.ownership import field_name, knowable_for
from bharat_alpha.reference.provider_ids import provider_keys

URL = "https://frapi.marketsmojo.com/Stocks_Shareholding/get_results"
SOURCE = "mojo_shareholding"
_TITLE = re.compile(r"[^a-z0-9]+")


def slug(title: str) -> str:
    """'Shareholding - FII Holdings' -> 'fii_holdings'."""
    t = title.replace("Shareholding", "").replace("-", " ").strip().lower()
    return _TITLE.sub("_", t).strip("_")


def quarter_end(yyyymm) -> dt.date | None:
    try:
        year, month = divmod(int(yyyymm), 100)
    except (TypeError, ValueError):
        return None
    if not (1 <= month <= 12) or year < 1990:
        return None
    return dt.date(year, month, monthrange(year, month)[1])


def parse_shareholding(payload) -> list[dict]:
    """-> [{field, period_end, value}]. Unknown block shapes are skipped, never guessed."""
    if not isinstance(payload, dict) or str(payload.get("code")) != "200":
        return []
    blocks = (((payload.get("data") or {}).get("shareholding_graphs") or {}).get("data")) or []
    out = []
    for block in blocks:
        title = (block or {}).get("title") or ""
        data = (block or {}).get("data") or []
        if not title or not data:
            continue
        base = slug(title)
        series_list = data if isinstance(data[0], list) else [data]
        for i, series in enumerate(series_list):
            if base == "promoter_holding" and i == 1:
                cat = "promoter_pledged_pct"          # the Promoter block's second series is the pledge
            elif i == 0:
                cat = f"{base}_pct"
            else:
                continue                               # an unexpected extra series is not guessed at
            for point in series:
                pe, v = quarter_end((point or {}).get("name")), (point or {}).get("y")
                if pe is None or v is None:
                    continue
                try:
                    val = float(v)
                except (TypeError, ValueError):
                    continue
                if 0.0 <= val <= 100.0:                # a holding percentage; anything else is not one
                    out.append({"field": field_name(cat), "period_end": pe, "value": val})
    return out


class MojoShareholding(Connector):
    name = SOURCE
    description = "MarketsMojo quarterly shareholding: promoter/FII/MF/insurance/DII holding % and promoter pledge %"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.fundamental", date_column="knowable_at", scope_sql=f"source = '{SOURCE}'",
                    sparse=True, warn_after_sessions=70, fill_rates={"value": 0.99})   # quarterly

    def __init__(self, limit: int | None = None):
        self.limit = limit
        self.ids: list[tuple[int, str]] = []

    def prepare(self, conn: psycopg.Connection, on: dt.date) -> None:
        self.ids = sorted(provider_keys(conn, "marketsmojo").items())[: self.limit]

    def fetch(self, client: HttpClient, on: dt.date) -> dict[int, dict]:
        out = {}
        for iid, sid in self.ids:
            try:
                r = client.get(URL, params={"sid": sid, "exchange": "0"})
            except FetchError:
                continue
            if r.ok:
                try:
                    out[iid] = r.json()
                except ValueError:
                    continue
        return out

    def parse(self, raw: dict[int, dict], on: dt.date) -> list[dict]:
        return [{"instrument_id": int(iid), **row} for iid, payload in raw.items()
                for row in parse_shareholding(payload)]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        # First sighting wins, across this source AND the legacy import: a quarter already known
        # keeps its original knowable_at, so a re-run adds quarters and never restamps history.
        from bharat_alpha.ingest.sources.ownership import SOURCE as LEGACY

        known = read_df(conn, """SELECT instrument_id, field, period_end FROM alpha.fundamental
                                 WHERE source IN (%s, %s) AND period_end IS NOT NULL""", (SOURCE, LEGACY))
        seen = {(int(i), f, pe) for i, f, pe in known.itertuples(index=False)}
        new = []
        for r in rows:
            k = (r["instrument_id"], r["field"], r["period_end"])
            if k in seen:
                continue
            seen.add(k)
            new.append({"source": SOURCE, "instrument_id": r["instrument_id"], "field": r["field"],
                        "period_end": r["period_end"], "value": r["value"],
                        "knowable_at": knowable_for(r["period_end"], on)})
        return upsert(conn, "alpha.fundamental", new,
                      key=("source", "instrument_id", "field", "knowable_at"), update=())


def import_legacy_mojo_ids(conn: psycopg.Connection, legacy: psycopg.Connection) -> dict:
    """nse_stocks.stockid -> alpha.provider_id('marketsmojo'). Ambiguous ids are dropped and
    reported by store_provider_ids, never resolved by whichever row came last."""
    from bharat_alpha.reference.provider_ids import store_provider_ids

    with legacy.cursor() as cur:
        cur.execute("SELECT stockid, symbol FROM public.nse_stocks WHERE stockid IS NOT NULL AND stockid <> ''")
        pairs = [(str(k), s) for k, s in cur.fetchall()]
    return store_provider_ids(conn, "marketsmojo", pairs, "legacy_master")
