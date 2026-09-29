"""NSE listing master (`content/equities/EQUITY_L.csv`): every listed mainboard equity with its ISIN,
company name, listing date and face value. SME names (SM/ST series) are not in this file.

Two uses, both about identity, neither a feature:
  * ISINs for every name. Bhavcopy carries none; before this only NIFTY 500 names had one
    (nse_constituents).
  * Renames `symbolchange.csv` missed. An ISIN is the security; if EQUITY_L lists symbol S with
    ISIN X and X already belongs to a different instrument whose trading ENDED before S's began,
    the two ids are one company split by an unrecorded rename, and are merged the same way a
    recorded rename is (reference.apply_symbol_change). An ISIN held by two instruments that
    traded at the same time is a conflict and is reported, never merged.

The file has no history, so it is a snapshot applied on the day it is read.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import logging

import psycopg

from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver, apply_symbol_change, current_symbols

log = logging.getLogger(__name__)

URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
REQUIRED = ("SYMBOL", "ISIN NUMBER")


def _float(v: str) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_equity_list(text: str) -> list[dict]:
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = [h.strip().upper() for h in next(reader, [])]
    missing = [c for c in REQUIRED if c not in header]
    if missing:
        raise ValueError(f"EQUITY_L lacks columns {missing} (header {header})")
    col = {c: i for i, c in enumerate(header)}

    def get(row: list[str], name: str) -> str:
        return row[col[name]].strip() if name in col and col[name] < len(row) else ""

    out = []
    for row in reader:
        sym, isin = get(row, "SYMBOL").upper(), get(row, "ISIN NUMBER").upper()
        if not sym or not isin:
            continue
        try:
            listed = dt.datetime.strptime(get(row, "DATE OF LISTING").title(), "%d-%b-%Y").date()
        except ValueError:
            listed = None
        out.append({"symbol": sym, "name": get(row, "NAME OF COMPANY") or None, "series": get(row, "SERIES") or None,
                    "listing_date": listed, "isin": isin, "face_value": _float(get(row, "FACE VALUE"))})
    return out


class NseEquityMaster(Connector):
    name = "nse_equity_master"
    description = "NSE EQUITY_L listing master: ISIN + name for every mainboard equity; merges unrecorded renames by ISIN"
    per_date = False
    dedupes_unchanged = True
    # SME names (~a fifth of traded instruments) are absent from EQUITY_L, hence the floor
    health = Health(table="alpha.instrument", date_column="last_seen", sparse=True,
                    warn_after_sessions=30, fill_rates={"isin": 0.7})

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(URL, headers={"Referer": "https://www.nseindia.com/"})
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return parse_equity_list(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        res = SymbolResolver(conn)
        n, conflicts = 0, []
        with conn.cursor() as cur:
            for r in rows:
                iid = res.lookup(r["symbol"], on)
                if iid is None:                       # instruments come from bhavcopy, never from a list
                    continue
                cur.execute("SELECT instrument_id, first_seen, last_seen FROM alpha.instrument WHERE isin = %s", (r["isin"],))
                holder = cur.fetchone()
                if holder is not None and holder[0] != iid:
                    cur.execute("SELECT first_seen FROM alpha.instrument WHERE instrument_id = %s", (iid,))
                    first = cur.fetchone()[0]
                    if holder[2] < first:
                        old_sym = current_symbols(conn)[holder[0]]
                        iid = apply_symbol_change(conn, old_sym, r["symbol"], first)
                        res._load()
                        log.info("merged unrecorded rename %s -> %s (ISIN %s, from %s)", old_sym, r["symbol"], r["isin"], first)
                        n += 1
                    else:
                        conflicts.append(f"{r['symbol']}:{r['isin']}")
                        continue
                cur.execute("""UPDATE alpha.instrument SET isin = %s, name = COALESCE(%s, name)
                               WHERE instrument_id = %s AND (isin IS DISTINCT FROM %s OR name IS DISTINCT FROM COALESCE(%s, name))""",
                            (r["isin"], r["name"], iid, r["isin"], r["name"]))
                n += cur.rowcount
        if conflicts:
            log.warning("EQUITY_L: %d ISIN(s) held by an instrument that traded concurrently, left unmerged: %s",
                        len(conflicts), ", ".join(conflicts[:20]))
        return n
