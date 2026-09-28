"""NSE corporate sources: symbol changes, board meetings (results calendar), insider (PIT) trades.

knowable_at is the exchange BROADCAST time where the payload carries one — never the event
date. (A results date announced two weeks ahead is usable two weeks ahead; an insider trade
executed on the 3rd and disclosed on the 9th is not usable on the 3rd.)

⚠ Field names for board meetings follow NSE's published JSON as last seen by the legacy repo
and were NOT re-probed from this build container (nseindia.com unreachable). The
live_datasource tests in tests/test_live_sources.py are the check.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import re
import xml.etree.ElementTree as ET

import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver, apply_symbol_change
from bharat_alpha.timeutil import IST

SYMBOL_CHANGE_URL = "https://nsearchives.nseindia.com/content/equities/symbolchange.csv"
BOARD_MEETINGS_URL = "https://www.nseindia.com/api/corporate-board-meetings"
PIT_URL = "https://www.nseindia.com/api/corporates-pit"
RESULTS_RSS_URL = "https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml"
# NSE names filing attachments SYMBOL_DDMMYYYYHHMMSS_<anything>.pdf (seen across the URL corpus):
# the stamp is the submission time, which is what pins when results became public.
FILING_LINK = re.compile(r"/corporate/([A-Z0-9&\-]+)_(\d{14})_", re.I)
_JSON = {"Accept": "application/json, text/plain, */*"}


def _parse_dt(s: str | None) -> dt.datetime | None:
    s = (s or "").strip()
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y"):
        try:
            return dt.datetime.strptime(s, fmt).replace(tzinfo=IST)
        except ValueError:
            continue
    return None


def parse_symbol_changes(text: str) -> list[dict]:
    out = []
    for row in csv.reader(io.StringIO(text.lstrip("﻿"))):
        cells = [c.strip() for c in row]
        if len(cells) < 4 or cells[1].upper() in ("SM_KEY_SYMBOL", "OLD SYMBOL"):
            continue
        eff = _parse_dt(cells[3])
        if eff and cells[1] and cells[2]:
            out.append({"old": cells[1].upper(), "new": cells[2].upper(), "effective": eff.date()})
    return out


class NseSymbolChange(Connector):
    name = "nse_symbol_change"
    description = "NSE symbol rename history; links an instrument's history across renames"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.symbol_history", date_column="valid_from", sparse=True,
                    warn_after_sessions=90, fail_after_sessions=10_000)

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(SYMBOL_CHANGE_URL, headers={"Referer": "https://www.nseindia.com/"})
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return parse_symbol_changes(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        n = 0
        known = SymbolResolver(conn)
        for r in sorted(rows, key=lambda x: x["effective"]):
            if r["effective"] > on:
                continue
            already = known.lookup(r["new"], r["effective"])
            old_iid = known.lookup(r["old"], r["effective"] - dt.timedelta(days=1))
            if old_iid is None or already == old_iid:
                continue
            apply_symbol_change(conn, r["old"], r["new"], r["effective"])
            known = SymbolResolver(conn)
            n += 1
        return n


def parse_board_meetings(payload: list[dict]) -> list[dict]:
    out = []
    for m in payload or []:
        sym = (m.get("bm_symbol") or "").strip().upper()
        event = _parse_dt(m.get("bm_date"))
        announced = _parse_dt(m.get("bm_timestamp")) or None
        purpose = (m.get("bm_purpose") or "").lower()
        if not sym or not event or announced is None:
            continue
        etype = "results" if ("result" in purpose or "financial" in purpose) else "board_meeting"
        out.append({"symbol": sym, "event_type": etype, "event_date": event.date(), "knowable_at": announced,
                    "detail": {"purpose": m.get("bm_purpose"), "desc": (m.get("bm_desc") or "")[:500]}})
    return out


class NseBoardMeetings(Connector):
    name = "nse_board_meetings"
    description = "NSE board-meeting intimations (results dates) with broadcast timestamps"
    health = Health(table="alpha.corporate_event", date_column="knowable_at", sparse=True,
                    scope_sql="source = 'nse_board_meetings'", warn_after_sessions=3)

    def fetch(self, client: HttpClient, on: dt.date) -> list[dict]:
        p = {"index": "equities", "from_date": (on - dt.timedelta(days=7)).strftime("%d-%m-%Y"),
             "to_date": on.strftime("%d-%m-%Y")}
        resp = client.get(BOARD_MEETINGS_URL, params=p, headers={**_JSON, "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-board-meetings"})
        resp.raise_for_status()
        body = resp.json()
        return body.get("data", body) if isinstance(body, dict) else body

    def parse(self, raw: list[dict], on: dt.date) -> list[dict]:
        return parse_board_meetings(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        res = SymbolResolver(conn)
        out = []
        for r in rows:
            iid = res.lookup(r["symbol"], r["knowable_at"].date())
            if iid is not None:
                out.append({"source": self.name, "instrument_id": iid, "event_type": r["event_type"],
                            "event_date": r["event_date"], "knowable_at": r["knowable_at"], "detail": Jsonb(r["detail"])})
        # knowable_at is NOT updated on conflict: the first sighting is when it became known.
        return upsert(conn, "alpha.corporate_event", out, key=("source", "instrument_id", "event_type", "event_date"),
                      update=("detail",))


def parse_pit(payload: dict | list) -> list[dict]:
    data = payload.get("data", []) if isinstance(payload, dict) else payload
    out = []
    for r in data or []:
        sym = (r.get("symbol") or "").strip().upper()
        side_raw = (r.get("tdpTransactionType") or "").lower()
        side = "BUY" if side_raw.startswith("buy") else "SELL" if side_raw.startswith("sell") else None
        announced = _parse_dt(r.get("date"))
        traded = _parse_dt(r.get("acqfromDt"))
        if not sym or side is None or announced is None:
            continue
        try:
            qty = float(str(r.get("secAcq") or "").replace(",", ""))
        except ValueError:
            qty = None
        try:
            val = float(str(r.get("secVal") or "").replace(",", ""))
        except ValueError:
            val = None
        price = val / qty if (val and qty) else None
        raw_key = "|".join(str(r.get(k, "")) for k in ("symbol", "acqName", "secAcq", "tdpTransactionType", "acqfromDt", "date"))
        out.append({"symbol": sym, "side": side, "quantity": qty, "price": price,
                    "party": (r.get("personCategory") or "")[:120], "trade_date": (traded or announced).date(),
                    "knowable_at": announced, "deal_id": hashlib.sha1(raw_key.encode()).hexdigest()})
    return out


class NseInsiderPit(Connector):
    name = "nse_insider_pit"
    dedupes_unchanged = True
    description = "SEBI PIT insider trading disclosures via NSE, with broadcast timestamps"
    health = Health(table="alpha.deal", date_column="knowable_at", sparse=True,
                    scope_sql="source = 'nse_insider_pit'", warn_after_sessions=3)

    def fetch(self, client: HttpClient, on: dt.date) -> dict:
        p = {"index": "equities", "from_date": (on - dt.timedelta(days=3)).strftime("%d-%m-%Y"),
             "to_date": on.strftime("%d-%m-%Y")}
        resp = client.get(PIT_URL, params=p, headers={**_JSON, "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-insider-trading"})
        resp.raise_for_status()
        return resp.json()

    def parse(self, raw: dict, on: dt.date) -> list[dict]:
        return parse_pit(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        res = SymbolResolver(conn)
        out = []
        for r in rows:
            iid = res.lookup(r["symbol"], r["knowable_at"].date())
            if iid is not None:
                out.append({"source": self.name, "deal_id": r["deal_id"], "trade_date": r["trade_date"],
                            "instrument_id": iid, "deal_type": "insider", "side": r["side"],
                            "quantity": r["quantity"], "price": r["price"], "party": r["party"],
                            "knowable_at": r["knowable_at"]})
        return upsert(conn, "alpha.deal", out, key=("source", "deal_id"), update=())


def parse_results_rss(xml_text: str) -> list[dict]:
    """One row per results filing: symbol and filing time from the attachment link. Items whose
    link does not carry the SYMBOL_DDMMYYYYHHMMSS stamp are skipped (their time is unprovable);
    a document that is not an RSS channel raises."""
    root = ET.fromstring(xml_text.lstrip("\ufeff"))
    items = root.findall("./channel/item")
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError(f"not an RSS channel (root <{root.tag}>)")
    out = []
    for it in items:
        link = (it.findtext("link") or "").strip()
        m = FILING_LINK.search(link)
        if not m:
            continue
        try:
            filed = dt.datetime.strptime(m.group(2), "%d%m%Y%H%M%S").replace(tzinfo=IST)
        except ValueError:
            continue
        out.append({"symbol": m.group(1).upper(), "filed_at": filed, "link": link,
                    "title": (it.findtext("title") or "").strip()[:200]})
    return out


class NseResultsRss(Connector):
    """Forward-only: the feed carries recent filings only, so run it every session."""
    name = "nse_results_rss"
    description = "NSE financial-results filing feed: exact filing time per results announcement"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.corporate_event", date_column="knowable_at", sparse=True,
                    scope_sql="source = 'nse_results_rss'", warn_after_sessions=5)

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(RESULTS_RSS_URL, headers={"Referer": "https://www.nseindia.com/"})
        resp.raise_for_status()
        return resp.text

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return parse_results_rss(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        res = SymbolResolver(conn)
        out = {}
        for r in rows:
            iid = res.lookup(r["symbol"], r["filed_at"].date())
            if iid is None:
                continue
            key = (iid, r["filed_at"].date())
            if key not in out or r["filed_at"] < out[key]["knowable_at"]:       # earliest filing that day
                out[key] = {"source": self.name, "instrument_id": iid, "event_type": "results_filed",
                            "event_date": r["filed_at"].date(), "knowable_at": r["filed_at"],
                            "detail": Jsonb({"link": r["link"], "title": r["title"]})}
        return upsert(conn, "alpha.corporate_event", list(out.values()),
                      key=("source", "instrument_id", "event_type", "event_date"), update=())
