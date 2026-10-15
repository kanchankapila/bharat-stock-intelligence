"""Reported quarterly results (EPS, total income, net profit) from NSE filings.

NSE froze ``/api/results-comparision`` at the December-2024 quarter when results moved to
Integrated Filing in April 2025. Sweeping that endpoint still returns HTTP 200 and five valid
rows per stock, so it silently looked healthy while spending roughly four hours re-reading stale
history. The primary platform already crawls NSE's live integrated-filing listing, downloads the
filing XBRLs and stores first-reported numbers plus the exchange broadcast timestamp in
``nse_filing_financials``. This connector mirrors that canonical, audited table into BQA rather
than maintaining a second 2,000-stock crawler.

Point in time is the filing's real ``broadcast_ts``. Values are selected one per stock/quarter,
preferring an original consolidated filing, then an original standalone filing, with a revision
used only when no usable original exists. Monetary XBRL values are stored upstream in Rs crore
and converted here to the existing BQA Rs-lakh contract; EPS remains rupees per share. The first
import of a (stock, field, quarter) wins, so a later refresh never rewrites history.

``parse_results`` remains as a strict parser for the retired response shape so historical fixture
tests and any forensic replay stay possible; production fetches use ``parse_filing_rows``.
"""
from __future__ import annotations

import datetime as dt
import math
import os

import pandas as pd
import psycopg

from bharat_alpha.db import read_df, upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.timeutil import IST, eod_knowable_at, ist_now

SOURCE = "nse_results"
EPS_KEYS = ("re_basic_eps", "re_basic_eps_for_cont_dic_opr", "re_dil_eps", "re_dil_eps_for_cont_dic_opr",
            "reBasicEPS", "reDilEPS")
DATE_FORMATS = ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%d %b %Y", "%d/%m/%Y")
RESULTS_RELEASE = dt.time(23, 0)
PRIMARY_DATABASE_ENV = "POSTGRES_URL"


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


def parse_filing_rows(rows: list[dict], symbol_to_iid: dict[str, int]) -> list[dict]:
    """Canonical primary rows -> BQA's existing result-row contract.

    This is intentionally strict about dates/timestamps and numeric shape. An unmapped symbol is
    skipped (the primary universe includes delisted/SME names BQA may not trade); a malformed row
    for a mapped symbol fails the run instead of becoming a plausible-looking zero.
    """
    if not isinstance(rows, list):
        raise ValueError(f"filing bridge payload must be a list, got {type(rows).__name__}")
    out = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError(f"filing bridge row must be a dict, got {type(row).__name__}")
        missing = [k for k in ("symbol", "period_end", "broadcast_ts") if not row.get(k)]
        if missing:
            raise ValueError(f"filing bridge row lacks {missing}")
        iid = symbol_to_iid.get(str(row["symbol"]).strip().upper())
        if iid is None:
            continue
        period_end = row["period_end"]
        if not isinstance(period_end, dt.date):
            period_end = _date(period_end)
        known = pd.Timestamp(row["broadcast_ts"])
        if period_end is None or pd.isna(known) or known.tzinfo is None:
            raise ValueError(f"invalid filing date/timestamp for {row['symbol']}")
        eps = _num(row.get("eps_basic"))
        revenue_crore = _num(row.get("total_income_crore"))
        pat_crore = _num(row.get("pat_crore"))
        if eps is None and revenue_crore is None and pat_crore is None:
            raise ValueError(f"filing row has no usable values for {row['symbol']} {period_end}")
        out.append({
            "instrument_id": iid,
            "period_end": period_end,
            "res_eps": eps,
            "res_revenue_lakh": None if revenue_crore is None else revenue_crore * 100.0,
            "res_net_profit_lakh": None if pat_crore is None else pat_crore * 100.0,
            "knowable_at": known.to_pydatetime(),
        })
    return out


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
        self.symbol_to_iid: dict[str, int] = {}

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
        self.symbol_to_iid = {str(symbol).upper(): iid for iid, symbol in self.universe}

    def fetch(self, client: HttpClient, on: dt.date) -> list[dict]:
        del client, on
        dsn = os.environ.get(PRIMARY_DATABASE_ENV)
        if not dsn:
            raise RuntimeError(
                f"{PRIMARY_DATABASE_ENV} is required to mirror canonical NSE integrated filings"
            )
        with psycopg.connect(dsn) as primary:
            rows = read_df(primary, """
                WITH ranked AS (
                    SELECT symbol, period_end, eps_basic,
                           COALESCE(total_income, revenue) AS total_income_crore,
                           pat AS pat_crore, broadcast_ts,
                           ROW_NUMBER() OVER (
                               PARTITION BY symbol, period_end
                               ORDER BY is_original DESC, consolidated DESC, broadcast_ts ASC
                           ) AS rn
                      FROM nse_filing_financials
                     WHERE parse_error IS NULL
                       AND (eps_basic IS NOT NULL OR total_income IS NOT NULL
                            OR revenue IS NOT NULL OR pat IS NOT NULL)
                )
                SELECT symbol, period_end, eps_basic, total_income_crore, pat_crore, broadcast_ts
                  FROM ranked WHERE rn = 1
                 ORDER BY symbol, period_end
            """)
        return rows.to_dict("records")

    def parse(self, raw: list[dict], on: dt.date) -> list[dict]:
        del on
        return parse_filing_rows(raw, self.symbol_to_iid)

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
        k = r.get("knowable_at") or knowable_for(r["period_end"], by_iid.get(r["instrument_id"], []), fetched)
        for f in ("res_eps", "res_revenue_lakh", "res_net_profit_lakh"):
            key = (r["instrument_id"], f, r["period_end"])
            if r[f] is None or key in seen:
                continue
            seen.add(key)
            out.append({"source": SOURCE, "instrument_id": r["instrument_id"], "field": f,
                        "period_end": r["period_end"], "value": r[f], "knowable_at": k})
    return upsert(conn, "alpha.fundamental", out, key=("source", "instrument_id", "field", "knowable_at"), update=())
