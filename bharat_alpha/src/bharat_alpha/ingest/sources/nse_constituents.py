"""NSE index constituent lists -> instrument industry (sector) labels and ISINs.

Used for sector caps in portfolio construction. The file has no history, so the label is the
CURRENT one applied to every date — a mild look-ahead for backtests (industry classifications
change rarely). It is used only as a risk-bucket constraint, never as an alpha feature.

The URL pattern and the `Symbol` column were live-verified by the legacy
index_membership_fetcher.py. `Industry` / `ISIN Code` are matched by name, tolerating spelling
variants; a file without them is an error, not an empty success.
"""
from __future__ import annotations

import csv
import datetime as dt
import io

import psycopg

from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver

URL = "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv"


def _col(fields: list[str], *needles: str) -> str | None:
    for f in fields:
        k = f.strip().lower()
        if any(n in k for n in needles):
            return f
    return None


def parse_constituents(text: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    fields = reader.fieldnames or []
    sym, ind, isin = _col(fields, "symbol"), _col(fields, "industry", "sector"), _col(fields, "isin")
    if sym is None or ind is None:
        raise ValueError(f"constituent file lacks Symbol/Industry columns: {fields}")
    out = []
    for r in reader:
        s = (r.get(sym) or "").strip().upper()
        if s:
            out.append({"symbol": s, "industry": (r.get(ind) or "").strip() or None,
                        "isin": ((r.get(isin) or "").strip() or None) if isin else None})
    return out


class NseConstituents(Connector):
    name = "nse_constituents"
    description = "NIFTY 500 constituent list: industry labels (sector caps) and ISINs"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.instrument", date_column="last_seen", sparse=True,
                    warn_after_sessions=30, fill_rates={"sector": 0.2})

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(URL, headers={"Referer": "https://www.nseindia.com/"})
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return parse_constituents(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        res = SymbolResolver(conn)
        n = 0
        with conn.cursor() as cur:
            for r in rows:
                iid = res.lookup(r["symbol"], on)
                if iid is None:
                    continue
                cur.execute("""UPDATE alpha.instrument SET sector = COALESCE(%s, sector),
                                   isin = COALESCE(isin, %s)
                               WHERE instrument_id = %s
                                 AND (sector IS DISTINCT FROM COALESCE(%s, sector) OR (isin IS NULL AND %s IS NOT NULL))""",
                            (r["industry"], r["isin"], iid, r["industry"], r["isin"]))
                n += cur.rowcount
        return n
