"""NSE F&O UDiFF bhavcopy — stock futures (FinInstrmTp='STF') per expiry.

Gives open interest, OI change, futures close/settle and the underlying price, from which
basis and rollover are derived. Legacy's strongest F&O lead was 1-day basis (IC +0.139 on a
17-date LOW-DATA panel) — a lead, not a result; this connector makes it measurable back to
the UDiFF start (~mid-2024) instead of from forward collection only.
Column names match the legacy fno_rollover_fetcher.py, which parsed these files live.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import zipfile

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import eod_knowable_at

URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{yyyymmdd}_F_0000.csv.zip"


def _f(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "", "-") else None
    except ValueError:
        return None


def parse_fo_csv(text: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        if r.get("FinInstrmTp") != "STF":
            continue
        try:
            td = dt.date.fromisoformat(r["TradDt"])
            xp = dt.date.fromisoformat(r["XpryDt"])
        except (KeyError, ValueError):
            continue
        rows.append({
            "symbol": r["TckrSymb"].upper(), "trade_date": td, "expiry": xp,
            "close": _f(r.get("ClsPric")), "settle": _f(r.get("SttlmPric")),
            "underlying": _f(r.get("UndrlygPric")), "open_interest": _f(r.get("OpnIntrst")),
            "chg_oi": _f(r.get("ChngInOpnIntrst")), "volume": _f(r.get("TtlTradgVol")),
        })
    return rows


class NseFoBhavcopy(Connector):
    name = "nse_fo_bhavcopy"
    description = "NSE F&O UDiFF bhavcopy: stock futures OI, settle, underlying (basis/rollover)"
    health = Health(
        table="alpha.fo_daily", date_column="trade_date", warn_after_sessions=1, fail_after_sessions=3,
        fill_rates={"open_interest": 0.99, "underlying": 0.95, "close": 0.95},
    )

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(URL.format(yyyymmdd=on.strftime("%Y%m%d")), headers={"Referer": "https://www.nseindia.com/"})
        if resp.status_code == 404:
            raise NotPublished(f"no F&O bhavcopy for {on}")
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            return z.read(z.namelist()[0]).decode("utf-8", "replace")

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return [r for r in parse_fo_csv(raw) if r["trade_date"] == on]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        resolver = SymbolResolver(conn)
        knowable = eod_knowable_at(on)
        out = []
        for r in rows:
            iid = resolver.lookup(r["symbol"], on)
            if iid is None:      # F&O names are always cash-listed; unknown => cash bar not ingested yet
                continue
            out.append({**{k: v for k, v in r.items() if k != "symbol"}, "instrument_id": iid,
                        "source": self.name, "knowable_at": knowable})
        return upsert(conn, "alpha.fo_daily", out, key=("instrument_id", "trade_date", "expiry"))
