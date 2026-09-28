"""NSE full security-wise bhavcopy (sec_bhavdata_full_DDMMYYYY.csv).

The spine of the system: point-in-time universe (delisted names are present on the days they
traded), unadjusted OHLC, NSE's adjusted PREV_CLOSE (-> corporate-action factors), and
delivery quantity — all from the exchange itself. Consistent schema back to 2021-01-04.
"""
from __future__ import annotations

import csv
import datetime as dt
import io

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import eod_knowable_at

# Host as live-verified by the legacy fetcher (nse_bhavcopy_fetcher.py), not re-probed here.
URL = "https://archives.nseindia.com/products/content/sec_bhavdata_full_{ddmmyyyy}.csv"
# EQ rolling, BE/BZ trade-to-trade, SM/ST SME. Gilts, SGBs, ETFs' odd series excluded.
EQUITY_SERIES = {"EQ", "BE", "BZ", "SM", "ST"}
_NUM = {
    "PREV_CLOSE": "prev_close", "OPEN_PRICE": "open", "HIGH_PRICE": "high", "LOW_PRICE": "low",
    "LAST_PRICE": "last", "CLOSE_PRICE": "close", "AVG_PRICE": "vwap", "TTL_TRD_QNTY": "volume",
    "TURNOVER_LACS": "turnover_lacs", "NO_OF_TRADES": "trades", "DELIV_QTY": "deliv_qty",
    "DELIV_PER": "deliv_pct",
}


def _num(v: str) -> float | None:
    v = (v or "").strip()
    if v in ("", "-", "NA"):
        return None
    try:
        return float(v.replace(",", ""))
    except ValueError:
        return None


def parse_bhavcopy(text: str, equity_only: bool = True) -> list[dict]:
    rows: list[dict] = []
    for raw in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        r = {(k or "").strip(): (v or "").strip() for k, v in raw.items()}
        sym, series = r.get("SYMBOL", ""), r.get("SERIES", "")
        if not sym or not series or (equity_only and series not in EQUITY_SERIES):
            continue
        try:
            d = dt.datetime.strptime(r["DATE1"], "%d-%b-%Y").date()
        except (KeyError, ValueError):
            continue
        row = {"symbol": sym.upper(), "series": series, "trade_date": d}
        for src, dst in _NUM.items():
            row[dst] = _num(r.get(src, ""))
        rows.append(row)
    return rows


class NseBhavcopy(Connector):
    name = "nse_bhavcopy"
    description = "NSE security-wise full bhavcopy: OHLC, prev_close, volume, turnover, delivery"
    health = Health(
        table="alpha.daily_bar", date_column="trade_date", warn_after_sessions=1, fail_after_sessions=2,
        fill_rates={"close": 0.99, "open": 0.99, "prev_close": 0.99, "deliv_pct": 0.85},
        scope_sql="source = 'nse_bhavcopy'",
    )

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(URL.format(ddmmyyyy=on.strftime("%d%m%Y")), headers={"Referer": "https://www.nseindia.com/"})
        if resp.status_code == 404:
            raise NotPublished(f"no bhavcopy for {on}")
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        rows = parse_bhavcopy(raw)
        wrong = {r["trade_date"] for r in rows} - {on}
        if wrong:
            raise ValueError(f"bhavcopy for {on} contains dates {sorted(wrong)}")
        return rows

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        return write_bars(conn, rows, on, source=self.name)


def write_bars(conn: psycopg.Connection, rows: list[dict], on: dt.date, source: str) -> int:
    resolver = SymbolResolver(conn)
    knowable = eod_knowable_at(on)
    out: dict[int, dict] = {}
    for r in rows:
        iid = resolver.resolve(r["symbol"], on)
        # A symbol can print in two series on one day (e.g. EQ->BE move). Keep the more liquid.
        prev = out.get(iid)
        if prev and (prev["volume"] or 0) >= (r["volume"] or 0):
            continue
        tl = r.get("turnover_lacs")
        out[iid] = {
            "instrument_id": iid, "trade_date": on, "series": r["series"],
            "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
            "last": r["last"], "prev_close": r["prev_close"], "vwap": r["vwap"],
            "volume": r["volume"], "turnover_inr": tl * 1e5 if tl is not None else None,
            "trades": r["trades"], "deliv_qty": r["deliv_qty"], "deliv_pct": r["deliv_pct"],
            "source": source, "knowable_at": knowable,
        }
    n = upsert(conn, "alpha.daily_bar", out.values(), key=("instrument_id", "trade_date"))
    if n:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO alpha.trading_day(trade_date, n_instruments) VALUES (%s,%s) "
                "ON CONFLICT (trade_date) DO UPDATE SET n_instruments = EXCLUDED.n_instruments",
                (on, n),
            )
    return n
