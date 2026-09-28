"""NSE pre-open call auction snapshot (`/api/market-data-pre-open?key=ALL`), taken ~09:08-09:14 IST.

The auction (09:00-09:08) sets each stock's opening price. Its indicative equilibrium price
(IEP) and buy/sell imbalance are the only information about the open that exists before the
open. NSE publishes no history, so the table only grows by forward collection. `knowable_at`
is the fetch time; a snapshot taken after 09:15 is still stored, but `usable_before_open`
keeps it out of every pre-open feature.

Field names and fallbacks follow the legacy preopen_fetcher.py, which parsed this endpoint live
(metadata.iep / previousClose / lastPrice; detail.preOpenMarket.totalBuyQuantity /
totalSellQuantity / finalQuantity). The endpoint needs TLS impersonation (see ingest.http).
"""
from __future__ import annotations

import datetime as dt

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import IST, ist_now

URL = "https://www.nseindia.com/api/market-data-pre-open"
MARKET_OPEN = dt.time(9, 15)


def _f(v) -> float | None:
    try:
        f = float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def parse_preopen(payload: dict | list) -> list[dict]:
    data = payload.get("data", []) if isinstance(payload, dict) else payload
    out = []
    for item in data or []:
        meta = item.get("metadata") or {}
        pom = (item.get("detail") or {}).get("preOpenMarket") or {}
        sym = (meta.get("symbol") or "").strip().upper()
        iep = _f(meta.get("iep"))
        prev = _f(meta.get("previousClose") or meta.get("prevClose"))
        if not sym or iep is None or not prev:
            continue
        buy = _f(pom.get("totalBuyQuantity") or meta.get("totalBuyQuantity"))
        sell = _f(pom.get("totalSellQuantity") or meta.get("totalSellQuantity"))
        tot = (buy or 0) + (sell or 0)
        out.append({"symbol": sym, "iep": iep, "prev_close": prev, "iep_gap": iep / prev - 1,
                    "buy_qty": buy, "sell_qty": sell,
                    "imbalance": ((buy or 0) - (sell or 0)) / tot if tot else None,
                    "auction_qty": _f(pom.get("finalQuantity") or pom.get("totalTradedVolume"))})
    return out


class NsePreopen(Connector):
    name = "nse_preopen"
    description = "NSE pre-open auction: IEP, gap vs previous close, buy/sell imbalance (forward-only)"
    per_date = False
    dedupes_unchanged = True       # a second capture the same morning is ignored by design
    health = Health(table="alpha.preopen_snapshot", date_column="trade_date", warn_after_sessions=1,
                    fail_after_sessions=3, fill_rates={"iep": 0.99, "imbalance": 0.8})

    def __init__(self, fetched_at: dt.datetime | None = None):
        self.fetched_at = fetched_at

    def fetch(self, client: HttpClient, on: dt.date) -> dict:
        self.fetched_at = ist_now()
        if self.fetched_at.date() != on:
            raise NotPublished(f"pre-open for {on} can only be captured on {on} (now {self.fetched_at.date()})")
        resp = client.get(URL, params={"key": "ALL"},
                          headers={"Accept": "application/json, text/plain, */*",
                                   "Referer": "https://www.nseindia.com/market-data/pre-open-market-cm-and-emerge-market"})
        resp.raise_for_status()
        return resp.json()

    def parse(self, raw, on: dt.date) -> list[dict]:
        return parse_preopen(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        seen = (self.fetched_at or ist_now()).astimezone(IST)
        res = SymbolResolver(conn)
        out = []
        for r in rows:
            iid = res.lookup(r["symbol"], on - dt.timedelta(days=1)) or res.lookup(r["symbol"], on)
            if iid is None:
                continue             # never create an instrument from a pre-open print
            out.append({"source": self.name, "instrument_id": iid, "trade_date": on,
                        **{k: r[k] for k in ("iep", "prev_close", "iep_gap", "buy_qty", "sell_qty", "imbalance",
                                             "auction_qty")},
                        "knowable_at": seen})
        # the first capture of the morning is the pre-open fact; later re-runs never overwrite it
        return upsert(conn, "alpha.preopen_snapshot", out, key=("source", "instrument_id", "trade_date"), update=())


def usable_before_open(knowable_at: dt.datetime, trade_date: dt.date) -> bool:
    return knowable_at.astimezone(IST) < dt.datetime.combine(trade_date, MARKET_OPEN, tzinfo=IST)
