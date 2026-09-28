"""Reported quarterly results (EPS, total income, net profit) from NSE's own results-comparison
API: the input a standardised earnings surprise needs, without a vendor.

Shape. `GET /api/results-comparision?symbol=X` (NSE's spelling) returns `resCmpData`, one row
per recent quarter (~5), with the period end `re_to_dt`, `re_total_inc`, `re_net_profit` (Rs
lakh) and EPS. No field name here could be verified from this build container (network
blocked, AF-20260928-10) and none appears in the legacy code or URL corpus, so the parser is
strict: a payload without `resCmpData`, or a row without a period end, income, profit and one of
the known EPS keys, raises instead of writing something half-understood. The live test settles
the real names.

Point in time. The payload carries no filing time per quarter, so a quarter is knowable at:
  * this engine's own NSE board-meeting results date for that quarter (the first 'results' event
    in (quarter end, SEBI deadline]), stamped 23:00 IST because results are often released after
    hours, so they are first used the next session;
  * otherwise the SEBI LODR Reg. 33 deadline (45 days after quarter end, 60 for the March
    quarter), or the fetch time if that is earlier.
The first import of a (stock, field, quarter) wins; a re-fetch never restamps history.
"""
from __future__ import annotations

import datetime as dt
import math

import pandas as pd
import psycopg

from bharat_alpha.db import read_df, upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import FetchError, HttpClient
from bharat_alpha.timeutil import IST, eod_knowable_at, ist_now

URL = "https://www.nseindia.com/api/results-comparision"
HEADERS = {"Referer": "https://www.nseindia.com/companies-listing/corporate-filings-financial-results",
           "Accept": "application/json, text/plain, */*"}
SOURCE = "nse_results"
EPS_KEYS = ("re_basic_eps", "re_basic_eps_for_cont_dic_opr", "re_dil_eps", "re_dil_eps_for_cont_dic_opr",
            "reBasicEPS", "reDilEPS")
DATE_FORMATS = ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%d %b %Y", "%d/%m/%Y")
RESULTS_RELEASE = dt.time(23, 0)


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        x = float(str(v).replace(",", "").strip())
    except ValueError:
        return None
    return x if math.isfinite(x) else None


def _date(v) -> dt.date | None:
    s = str(v or "").strip()
    for f in DATE_FORMATS:
        try:
            return dt.datetime.strptime(s, f).date()
        except ValueError:
            continue
    return None


def parse_results(payload: dict) -> list[dict]:
    rows = payload.get("resCmpData") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"results payload has no resCmpData list (keys: {sorted(payload)[:20] if isinstance(payload, dict) else type(payload).__name__})")
    out: dict[dt.date, dict] = {}
    for r in rows:
        eps_key = next((k for k in EPS_KEYS if k in r), None)
        missing = [k for k in ("re_to_dt", "re_total_inc", "re_net_profit") if k not in r]
        if missing or eps_key is None:
            raise ValueError(f"results row lacks {missing or 'an EPS key'} (keys: {sorted(r)[:30]})")
        pe = _date(r["re_to_dt"])
        if pe is None:
            raise ValueError(f"unparseable period end {r['re_to_dt']!r}")
        out.setdefault(pe, {"period_end": pe, "res_eps": _num(r[eps_key]),
                            "res_revenue_lakh": _num(r["re_total_inc"]), "res_net_profit_lakh": _num(r["re_net_profit"])})
    return list(out.values())


def filing_deadline(period_end: dt.date) -> dt.date:
    return period_end + dt.timedelta(days=60 if period_end.month == 3 else 45)


def knowable_for(period_end: dt.date, results_dates: list[dt.date], fetched: dt.datetime) -> dt.datetime:
    deadline = filing_deadline(period_end)
    announced = min((d for d in results_dates if period_end < d <= deadline), default=None)
    if announced is not None:
        return dt.datetime.combine(announced, RESULTS_RELEASE, tzinfo=IST)
    return min(eod_knowable_at(deadline), fetched)


class NseResults(Connector):
    name = "nse_results"
    description = "NSE reported quarterly results (EPS, total income, net profit) per stock"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.fundamental", date_column="knowable_at", scope_sql="source = 'nse_results'",
                    sparse=True, warn_after_sessions=30, fill_rates={"value": 0.9})

    def __init__(self, symbols: list[str] | None = None, limit: int | None = None):
        self.symbols = symbols
        self.limit = limit
        self.universe: list[tuple[int, str]] = []

    def prepare(self, conn: psycopg.Connection, on: dt.date) -> None:
        cur = read_df(conn, """SELECT DISTINCT ON (s.instrument_id) s.instrument_id, s.symbol, i.sector
                               FROM alpha.symbol_history s JOIN alpha.instrument i USING (instrument_id)
                               WHERE i.last_seen >= %s ORDER BY s.instrument_id, s.valid_from DESC""",
                      (on - dt.timedelta(days=30),))
        if self.symbols:
            cur = cur[cur.symbol.isin([s.upper() for s in self.symbols])]
        elif cur.sector.notna().any():
            cur = cur[cur.sector.notna()]                     # NIFTY 500 (nse_constituents)
        self.universe = [(int(i), s) for i, s in zip(cur.instrument_id, cur.symbol)][: self.limit]

    def fetch(self, client: HttpClient, on: dt.date) -> dict[int, dict]:
        out = {}
        for iid, sym in self.universe:
            try:
                r = client.get(URL, headers=HEADERS, params={"symbol": sym})
                if r.ok:
                    out[iid] = r.json()
            except (FetchError, ValueError):
                continue
        return out

    def parse(self, raw: dict[int, dict], on: dt.date) -> list[dict]:
        return [{"instrument_id": iid, **q} for iid, payload in raw.items() for q in parse_results(payload)]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        return write_results(conn, rows, ist_now())


def write_results(conn: psycopg.Connection, rows: list[dict], fetched: dt.datetime) -> int:
    ev = read_df(conn, "SELECT instrument_id, event_date FROM alpha.corporate_event WHERE event_type = 'results'")
    by_iid: dict[int, list[dt.date]] = {}
    for i, d in ev.itertuples(index=False):
        by_iid.setdefault(int(i), []).append(pd.Timestamp(d).date())
    have = read_df(conn, "SELECT instrument_id, field, period_end FROM alpha.fundamental WHERE source=%s", (SOURCE,))
    seen = {(int(i), f, pe) for i, f, pe in have.itertuples(index=False)}
    out = []
    for r in rows:
        k = knowable_for(r["period_end"], by_iid.get(r["instrument_id"], []), fetched)
        for f in ("res_eps", "res_revenue_lakh", "res_net_profit_lakh"):
            key = (r["instrument_id"], f, r["period_end"])
            if r[f] is None or key in seen:
                continue
            seen.add(key)
            out.append({"source": SOURCE, "instrument_id": r["instrument_id"], "field": f,
                        "period_end": r["period_end"], "value": r[f], "knowable_at": k})
    return upsert(conn, "alpha.fundamental", out, key=("source", "instrument_id", "field", "knowable_at"), update=())
