"""Market-level NSE sources: index closes (incl. INDIA VIX, index P/E), FII/DII cash flows."""
from __future__ import annotations

import csv
import datetime as dt
import io

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.timeutil import eod_knowable_at

INDEX_URL = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{ddmmyyyy}.csv"
FII_DII_URL = "https://www.nseindia.com/api/fiidiiTradeReact"


def _f(v):
    v = (v or "").strip().replace(",", "")
    try:
        return float(v) if v not in ("", "-") else None
    except ValueError:
        return None


def parse_index_close(text: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        name = r.get("Index Name")
        try:
            d = dt.datetime.strptime(r.get("Index Date", ""), "%d-%m-%Y").date()
        except ValueError:
            continue
        if not name:
            continue
        rows.append({
            "index_name": name.upper(), "trade_date": d,
            "open": _f(r.get("Open Index Value")), "high": _f(r.get("High Index Value")),
            "low": _f(r.get("Low Index Value")), "close": _f(r.get("Closing Index Value")),
            "pe": _f(r.get("P/E")), "pb": _f(r.get("P/B")), "div_yield": _f(r.get("Div Yield")),
        })
    return rows


class NseIndexClose(Connector):
    name = "nse_index_close"
    description = "All NSE index closes incl. INDIA VIX, NIFTY 50/500 with P/E, P/B, div yield"
    health = Health(
        table="alpha.index_daily", date_column="trade_date",
        fill_rates={"close": 0.95}, scope_sql="index_name IN ('NIFTY 50','INDIA VIX','NIFTY 500')",
    )

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(INDEX_URL.format(ddmmyyyy=on.strftime("%d%m%Y")), headers={"Referer": "https://www.nseindia.com/"})
        if resp.status_code == 404:
            raise NotPublished(f"no index file for {on}")
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return [r for r in parse_index_close(raw) if r["trade_date"] == on]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        k = eod_knowable_at(on)
        return upsert(conn, "alpha.index_daily", [{**r, "source": self.name, "knowable_at": k} for r in rows],
                      key=("index_name", "trade_date"))


def parse_fii_dii(payload: list[dict]) -> list[dict]:
    rows = []
    for item in payload or []:
        cat = (item.get("category") or "").upper()
        category = "FII" if ("FII" in cat or "FPI" in cat) else "DII" if "DII" in cat else None
        if category is None:
            continue
        try:
            d = dt.datetime.strptime(item["date"].strip(), "%d-%b-%Y").date()
        except (KeyError, ValueError):
            continue
        rows.append({"trade_date": d, "category": category, "buy_cr": _f(str(item.get("buyValue", ""))),
                     "sell_cr": _f(str(item.get("sellValue", ""))), "net_cr": _f(str(item.get("netValue", "")))})
    return rows


class NseFiiDii(Connector):
    """Snapshot endpoint (latest session only) -> forward collection. Legacy's fii_dii_flow
    history can be imported through the legacy bridge."""
    name = "nse_fii_dii"
    description = "NSE provisional FII/FPI and DII cash-market buy/sell/net (Rs crore)"
    per_date = False
    health = Health(table="alpha.market_flow", date_column="trade_date", fill_rates={"net_cr": 0.99},
                    scope_sql="source = 'nse_fii_dii'")

    def fetch(self, client: HttpClient, on: dt.date) -> list[dict]:
        resp = client.get(FII_DII_URL, headers={"Referer": "https://www.nseindia.com/market-data/fii-dii-activity",
                                                "Accept": "application/json, text/plain, */*"})
        resp.raise_for_status()
        return resp.json()

    def parse(self, raw: list[dict], on: dt.date) -> list[dict]:
        return parse_fii_dii(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        # Provisional figures are published the same evening; stamping EOD of the trade date is
        # conservative for a decision taken at the next session's open.
        out = [{**r, "source": self.name, "knowable_at": eod_knowable_at(r["trade_date"])} for r in rows]
        return upsert(conn, "alpha.market_flow", out, key=("source", "trade_date", "category"),
                      update=("buy_cr", "sell_cr", "net_cr"))
