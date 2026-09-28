"""NSE daily PR bundle (`archives/equities/bhavcopy/pr/PRddmmyy.zip`): the exchange's own
corporate-action file (`Bc*.csv`: book closures / record dates, ex-date and PURPOSE text).

The price factors this engine applies are DERIVED from the exchange's adjusted PREV_CLOSE
(marketdata.derive_adjustments). This file is the independent record to check them against:
every split, bonus and consolidation here implies a factor, and quality.checks compares the
two. Dividends, rights and other purposes are stored as events with no factor.

Purpose parsing is deliberately narrow — only the phrasings with an unambiguous ratio produce a
factor; anything else is kept as 'other' with its text, never guessed:
  BONUS a:b                       -> b / (a + b)
  (FACE VALUE) SPLIT / SUB-DIVISION FROM RS x TO RS y  -> y / x
  CONSOLIDATION FROM RS x TO RS y -> y / x   (> 1)
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
import zipfile

import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, NotPublished
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import eod_knowable_at

URL = "https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR{ddmmyy}.zip"
REQUIRED = ("SYMBOL", "EX_DT", "PURPOSE")
BONUS = re.compile(r"\bBONUS\b[^0-9]*(\d+)\s*:\s*(\d+)", re.I)
FACE = re.compile(r"(?:RS\.?|RE\.?|INR)\s*([\d.]+)\s*/?-?\s*(?:PER SHARE\s*)?TO\s*(?:RS\.?|RE\.?|INR)\s*([\d.]+)", re.I)
DATE_FMTS = ("%d-%b-%Y", "%d-%b-%y", "%d/%m/%Y", "%Y-%m-%d")


def _date(v: str) -> dt.date | None:
    v = (v or "").strip()
    for f in DATE_FMTS:
        try:
            return dt.datetime.strptime(v.title() if "-" in v else v, f).date()
        except ValueError:
            continue
    return None


def classify_purpose(purpose: str) -> tuple[str, float | None]:
    p = " ".join(purpose.upper().split())
    if m := BONUS.search(p):
        a, b = int(m.group(1)), int(m.group(2))
        return "bonus", (b / (a + b)) if a > 0 and b > 0 else None
    if "CONSOLIDATION" in p and (m := FACE.search(p)):
        x, y = float(m.group(1)), float(m.group(2))
        return "consolidation", (y / x) if x > 0 and y > x else None
    if ("SPLIT" in p or "SUB-DIVISION" in p or "SUBDIVISION" in p) and (m := FACE.search(p)):
        x, y = float(m.group(1)), float(m.group(2))
        return "split", (y / x) if x > y > 0 else None
    for kind in ("DIVIDEND", "RIGHTS", "INTEREST", "REDEMPTION", "AGM", "BUYBACK"):
        if kind in p:
            return kind.lower(), None
    return "other", None


def parse_bc(text: str) -> list[dict]:
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    header = [h.strip().upper() for h in next(reader, [])]
    missing = [c for c in REQUIRED if c not in header]
    if missing:
        raise ValueError(f"Bc file lacks columns {missing} (header {header[:12]})")
    col = {c: header.index(c) for c in header}
    out = []
    for row in reader:
        if len(row) < len(header):
            continue
        ex = _date(row[col["EX_DT"]])
        sym = row[col["SYMBOL"]].strip().upper()
        purpose = row[col["PURPOSE"]].strip()
        if not sym or ex is None or not purpose:
            continue
        kind, factor = classify_purpose(purpose)
        out.append({"symbol": sym, "series": row[col["SERIES"]].strip() if "SERIES" in col else None,
                    "ex_date": ex, "record_date": _date(row[col["RECORD_DT"]]) if "RECORD_DT" in col else None,
                    "purpose": purpose, "kind": kind, "expected_factor": factor})
    return out


class NsePrBundle(Connector):
    name = "nse_pr_bc"
    description = "NSE PR bundle Bc file: exchange-recorded corporate actions (ex-date, purpose, implied factor)"
    health = Health(table="alpha.corporate_event", date_column="knowable_at", sparse=True,
                    scope_sql="source = 'nse_pr_bc'", warn_after_sessions=5)

    def fetch(self, client: HttpClient, on: dt.date) -> str:
        resp = client.get(URL.format(ddmmyy=on.strftime("%d%m%y")), headers={"Referer": "https://www.nseindia.com/"})
        if resp.status_code == 404:
            raise NotPublished(f"no PR bundle for {on}")
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            name = next((n for n in z.namelist() if re.match(r"(?i)(.*/)?bc.*\.csv$", n)), None)
            if name is None:
                raise ValueError(f"PR bundle for {on} has no Bc file: {z.namelist()[:10]}")
            return z.read(name).decode("utf-8", "replace")

    def parse(self, raw: str, on: dt.date) -> list[dict]:
        return parse_bc(raw)

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        res = SymbolResolver(conn)
        k = eod_knowable_at(on)
        out = {}
        for r in rows:
            iid = res.lookup(r["symbol"], min(on, r["ex_date"]))
            if iid is None:
                continue
            out[(iid, r["kind"], r["ex_date"])] = {
                "source": self.name, "instrument_id": iid, "event_type": r["kind"], "event_date": r["ex_date"],
                "knowable_at": k, "detail": Jsonb({"purpose": r["purpose"], "expected_factor": r["expected_factor"],
                                                   "record_date": str(r["record_date"]) if r["record_date"] else None,
                                                   "series": r["series"]})}
        # the first sighting is when an action became known; later files only refresh the detail
        return upsert(conn, "alpha.corporate_event", list(out.values()),
                      key=("source", "instrument_id", "event_type", "event_date"), update=("detail",))
