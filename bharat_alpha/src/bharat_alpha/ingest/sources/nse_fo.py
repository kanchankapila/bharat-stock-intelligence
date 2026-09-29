"""NSE F&O UDiFF bhavcopy — stock futures (FinInstrmTp='STF') and stock options ('STO').

Futures land in alpha.fo_daily; options are summarised per (stock, date, expiry) into
alpha.option_daily (ATM IV, skew, put/call OI and volume — see bharat_alpha.options), from the
same download.

Gives open interest, OI change, futures close/settle, the underlying price and the contract
lot (`NewBrdLotQty`), from which basis, rollover and rupee/share exposure are derived. OI is a
count of CONTRACTS: without the lot it is not comparable across stocks, and an NSE lot revision
moves it with no change in real exposure. Legacy's strongest F&O lead was 1-day basis (IC +0.139 on a
17-date LOW-DATA panel) — a lead, not a result; this connector makes it measurable back to
the UDiFF start (~mid-2024) instead of from forward collection only.
Column names match the legacy fno_rollover_fetcher.py, which parsed these files live.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
import zipfile

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.options import summarise
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import IST, eod_knowable_at

URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{yyyymmdd}_F_0000.csv.zip"
# Moved from /content/fo/ to /archives/fo/sec_ban/ -- the old path 404s on EVERY date,
# not just unpublished ones (verified 2026-09-22..29, all 404), so the connector's
# "not published yet" branch was silently absorbing a permanently dead URL.
BAN_URL = "https://nsearchives.nseindia.com/archives/fo/sec_ban/fo_secban_{ddmmyyyy}.csv"
BAN_HEADER = re.compile(r"ban\s+for\s+trade\s+date\s+(\d{1,2}-[A-Za-z]{3}-\d{4})", re.I)
BAN_KNOWABLE = dt.time(9, 0)             # the list for trade date T is certainly out by T's open


def _f(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "", "-") else None
    except ValueError:
        return None


def _records(text: str, kind: str):
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        if r.get("FinInstrmTp") != kind:
            continue
        try:
            yield r, dt.date.fromisoformat(r["TradDt"]), dt.date.fromisoformat(r["XpryDt"])
        except (KeyError, ValueError):
            continue


def parse_fo_csv(text: str) -> list[dict]:
    rows = []
    for r, td, xp in _records(text, "STF"):
        rows.append({
            "symbol": r["TckrSymb"].upper(), "trade_date": td, "expiry": xp,
            "close": _f(r.get("ClsPric")), "settle": _f(r.get("SttlmPric")),
            "underlying": _f(r.get("UndrlygPric")), "open_interest": _f(r.get("OpnIntrst")),
            "chg_oi": _f(r.get("ChngInOpnIntrst")), "volume": _f(r.get("TtlTradgVol")),
            "lot_size": _f(r.get("NewBrdLotQty")),
        })
    return rows


def parse_options_csv(text: str) -> list[dict]:
    rows = []
    for r, td, xp in _records(text, "STO"):
        if r.get("OptnTp") not in ("CE", "PE"):
            continue
        rows.append({
            "symbol": r["TckrSymb"].upper(), "trade_date": td, "expiry": xp, "strike": _f(r.get("StrkPric")),
            "call": r["OptnTp"] == "CE", "close": _f(r.get("ClsPric")), "underlying": _f(r.get("UndrlygPric")),
            "open_interest": _f(r.get("OpnIntrst")), "volume": _f(r.get("TtlTradgVol")),
        })
    return rows


class NseFoBhavcopy(Connector):
    name = "nse_fo_bhavcopy"
    description = "NSE F&O UDiFF bhavcopy: stock futures OI/settle/basis + per-stock option IV, skew, put/call OI"
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
        fut = [r for r in parse_fo_csv(raw) if r["trade_date"] == on]
        fwd = {(r["symbol"], r["expiry"]): r["settle"] or r["close"] for r in fut if (r["settle"] or r["close"])}
        opts = summarise([o for o in parse_options_csv(raw) if o["trade_date"] == on], fwd)
        return [{**r, "kind": "future"} for r in fut] + [{**r, "kind": "option"} for r in opts]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        resolver = SymbolResolver(conn)
        knowable = eod_knowable_at(on)
        out: dict[str, list[dict]] = {"future": [], "option": []}
        for r in rows:
            iid = resolver.lookup(r["symbol"], on)
            if iid is None:      # F&O names are always cash-listed; unknown => cash bar not ingested yet
                continue
            out[r["kind"]].append({**{k: v for k, v in r.items() if k not in ("symbol", "kind")},
                                   "instrument_id": iid, "source": self.name, "knowable_at": knowable})
        key = ("instrument_id", "trade_date", "expiry")
        return (upsert(conn, "alpha.fo_daily", out["future"], key=key)
                + upsert(conn, "alpha.option_daily", out["option"], key=key))


def parse_fo_ban(text: str) -> tuple[dt.date, list[str]]:
    """(trade date, banned symbols). The date comes from the file's own header line
    ('Securities in Ban For Trade Date 26-SEP-2026:'), never from the URL; a file without that
    header is rejected. Symbols are the last field of each numbered line; 'NIL' means none."""
    m = BAN_HEADER.search(text)
    if not m:
        raise ValueError(f"F&O ban file has no trade-date header: {text[:80]!r}")
    td = dt.datetime.strptime(m.group(1).title(), "%d-%b-%Y").date()
    syms = []
    for line in text[m.end():].splitlines():
        cells = [c.strip().strip('"') for c in line.split(",") if c.strip()]
        if len(cells) >= 2 and cells[0].isdigit() and re.fullmatch(r"[A-Z0-9&\-]+", cells[-1].upper()):
            syms.append(cells[-1].upper())
    return td, syms


class NseFoBan(Connector):
    name = "nse_fo_secban"
    description = "NSE F&O ban list: securities whose OI exceeded 95% of the market-wide position limit"
    health = Health(table="alpha.fo_ban_day", date_column="trade_date", warn_after_sessions=1, fail_after_sessions=3,
                    fill_rates={"n_banned": 1.0})

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(BAN_URL.format(ddmmyyyy=on.strftime("%d%m%Y")), headers={"Referer": "https://www.nseindia.com/"})
        if resp.status_code == 404:
            raise NotPublished(f"no F&O ban file for {on}")
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        td, syms = parse_fo_ban(raw)
        return [{"trade_date": td, "symbols": syms}]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        resolver = SymbolResolver(conn)
        n = 0
        for r in rows:
            td = r["trade_date"]
            iids = sorted({i for s in r["symbols"] if (i := resolver.lookup(s, td)) is not None})
            k = dt.datetime.combine(td, BAN_KNOWABLE, tzinfo=IST)
            n += upsert(conn, "alpha.fo_ban_day", [{"trade_date": td, "n_banned": len(iids), "source": self.name,
                                                    "knowable_at": k}], key=("trade_date",))
            with conn.cursor() as cur:
                cur.execute("DELETE FROM alpha.fo_ban WHERE trade_date = %s", (td,))
            n += upsert(conn, "alpha.fo_ban", [{"trade_date": td, "instrument_id": i} for i in iids],
                        key=("trade_date", "instrument_id"), update=())
        return n
