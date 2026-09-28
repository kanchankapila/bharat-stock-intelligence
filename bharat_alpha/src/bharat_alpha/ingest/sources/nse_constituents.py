"""NSE index constituent lists -> instrument industry (sector) labels, ISINs, and MEMBERSHIP.

Used for sector caps in portfolio construction. The file has no history, so the label is the
CURRENT one applied to every date — a mild look-ahead for backtests (industry classifications
change rarely). It is used only as a risk-bucket constraint, never as an alpha feature.

Membership is different, and IS point-in-time: each run diffs the fetched set against the open
intervals in alpha.index_membership, so a join or an exit is dated to the session we first saw
it — never to when NSE decided it. Index funds must trade an inclusion, which is the
predictable-demand event `index_join` / `index_exit` record.

A short or truncated file would otherwise read as a mass exit, so the diff is SKIPPED (sector and
ISIN still update) unless the fetched set is at least MIN_ROSTER_FRACTION of the current roster.

The URL pattern and the `Symbol` column were live-verified by the legacy
index_membership_fetcher.py. `Industry` / `ISIN Code` are matched by name, tolerating spelling
variants; a file without them is an error, not an empty success.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import logging

import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.db import read_df, upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.reference import SymbolResolver
from bharat_alpha.timeutil import eod_knowable_at

log = logging.getLogger(__name__)

URL = "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv"
INDEX_NAME = "NIFTY 500"
MIN_ROSTER_FRACTION = 0.8        # below this the file is short, not the index


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
        members: set[int] = set()
        with conn.cursor() as cur:
            for r in rows:
                iid = res.lookup(r["symbol"], on)
                if iid is None:
                    continue
                members.add(iid)
                # an ISIN another instrument already holds is left alone (nse_equity_master reconciles those)
                isin = r["isin"]
                if isin:
                    cur.execute("SELECT 1 FROM alpha.instrument WHERE isin = %s AND instrument_id <> %s", (isin, iid))
                    if cur.fetchone():
                        isin = None
                cur.execute("""UPDATE alpha.instrument SET sector = COALESCE(%s, sector),
                                   isin = COALESCE(isin, %s::text)
                               WHERE instrument_id = %s
                                 AND (sector IS DISTINCT FROM COALESCE(%s, sector) OR (isin IS NULL AND %s::text IS NOT NULL))""",
                            (r["industry"], isin, iid, r["industry"], isin))
                n += cur.rowcount
        return n + self._update_membership(conn, members, on)

    def _update_membership(self, conn: psycopg.Connection, members: set[int], on: dt.date) -> int:
        """Diff today's roster against the open intervals; record joins and exits as events."""
        open_now = read_df(conn, "SELECT instrument_id FROM alpha.index_membership "
                                 "WHERE index_name = %s AND to_date IS NULL", (INDEX_NAME,))
        current = {int(i) for i in open_now.instrument_id}
        if current and len(members) < MIN_ROSTER_FRACTION * len(current):
            log.warning("%s: roster of %d is under %.0f%% of the %d open members — not diffing",
                        INDEX_NAME, len(members), MIN_ROSTER_FRACTION * 100, len(current))
            return 0
        joined, left = members - current, current - members
        knowable = eod_knowable_at(on)
        events = [{"source": self.name, "instrument_id": iid, "event_type": kind, "event_date": on,
                   "knowable_at": knowable, "detail": Jsonb({"index": INDEX_NAME})}
                  for kind, ids in (("index_join", joined), ("index_exit", left)) for iid in ids]
        with conn.cursor() as cur:
            for iid in joined:
                cur.execute("""INSERT INTO alpha.index_membership(index_name, instrument_id, from_date, source)
                               VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                            (INDEX_NAME, iid, on, self.name))
            for iid in left:
                cur.execute("""UPDATE alpha.index_membership SET to_date = %s
                               WHERE index_name = %s AND instrument_id = %s AND to_date IS NULL""",
                            (on, INDEX_NAME, iid))
        n = len(joined) + len(left)
        if events:
            upsert(conn, "alpha.corporate_event", events,
                   key=("source", "instrument_id", "event_type", "event_date"), update=("detail",))
        return n
