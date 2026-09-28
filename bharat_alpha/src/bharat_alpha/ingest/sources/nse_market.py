"""Market-level NSE sources: index closes (incl. INDIA VIX, index P/E), FII/DII cash flows,
participant-wise F&O open interest (FII / DII / Pro / Client long-short by instrument)."""
from __future__ import annotations

import csv
import datetime as dt
import io

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.timeutil import IST, eod_knowable_at

INDEX_URL = "https://nsearchives.nseindia.com/content/indices/ind_close_all_{ddmmyyyy}.csv"
FII_DII_URL = "https://www.nseindia.com/api/fiidiiTradeReact"
PARTICIPANT_OI_URL = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{ddmmyyyy}.csv"
# Published in the evening, typically after the EOD bhavcopies. Stamped past the 19:00 same-day
# cutoff, so a session's positioning is first used at the NEXT session: late-evening publication
# can never leak into the same evening's decisions.
PARTICIPANT_OI_KNOWABLE = dt.time(20, 0)
PARTICIPANT_COLS = {                     # normalised header -> (instrument, side)
    "future index long": ("fut_idx", "long_oi"), "future index short": ("fut_idx", "short_oi"),
    "future stock long": ("fut_stk", "long_oi"), "future stock short": ("fut_stk", "short_oi"),
    "option index call long": ("opt_idx_call", "long_oi"), "option index call short": ("opt_idx_call", "short_oi"),
    "option index put long": ("opt_idx_put", "long_oi"), "option index put short": ("opt_idx_put", "short_oi"),
    "option stock call long": ("opt_stk_call", "long_oi"), "option stock call short": ("opt_stk_call", "short_oi"),
    "option stock put long": ("opt_stk_put", "long_oi"), "option stock put short": ("opt_stk_put", "short_oi"),
}
PARTICIPANTS = ("CLIENT", "DII", "FII", "PRO")


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


def parse_participant_oi(text: str, on: dt.date) -> list[dict]:
    """The file opens with a title line; the header is the row whose first cell is 'Client Type'.
    Headers carry stray tabs/spaces in the wild, so columns are matched on a normalised name,
    and a file missing any expected column is rejected rather than half-parsed."""
    lines = text.lstrip("\ufeff").splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.strip().strip('"').lower().startswith("client type")), None)
    if start is None:
        raise ValueError("participant OI file has no 'Client Type' header row")
    reader = csv.reader(io.StringIO("\n".join(lines[start:])))
    header = [" ".join((h or "").split()).lower() for h in next(reader)]
    missing = set(PARTICIPANT_COLS) - set(header)
    if missing:
        raise ValueError(f"participant OI file lacks columns {sorted(missing)}")
    out: dict[tuple, dict] = {}
    for row in reader:
        if not row:
            continue
        who = row[0].strip().upper()
        if who not in PARTICIPANTS:
            continue                                      # TOTAL and trailing notes
        for col, (inst, side) in PARTICIPANT_COLS.items():
            rec = out.setdefault((who, inst), {"trade_date": on, "participant": who, "instrument": inst})
            rec[side] = _f(row[header.index(col)])
    return list(out.values())


class NseParticipantOi(Connector):
    name = "nse_participant_oi"
    description = "NSE participant-wise F&O open interest: FII/DII/Pro/Client long & short by instrument (dated archive)"
    health = Health(table="alpha.participant_oi", date_column="trade_date", warn_after_sessions=1,
                    fail_after_sessions=3, fill_rates={"long_oi": 0.99, "short_oi": 0.99})

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(PARTICIPANT_OI_URL.format(ddmmyyyy=on.strftime("%d%m%Y")),
                          headers={"Referer": "https://www.nseindia.com/"})
        if resp.status_code == 404:
            raise NotPublished(f"no participant OI file for {on}")
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return parse_participant_oi(raw, on)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        k = dt.datetime.combine(on, PARTICIPANT_OI_KNOWABLE, tzinfo=IST)
        return upsert(conn, "alpha.participant_oi", [{**r, "source": self.name, "knowable_at": k} for r in rows],
                      key=("trade_date", "participant", "instrument"))
