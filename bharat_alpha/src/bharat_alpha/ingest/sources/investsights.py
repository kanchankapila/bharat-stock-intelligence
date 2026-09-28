"""InvestSights per-stock fundamentals (fmp-ratios + growth-metrics), forward-collected.

Point-in-time honesty: these endpoints return the vendor's CURRENT view with no revision
history, so each value's knowable_at is the moment we fetched it. History therefore starts
the day collection starts; nothing is backfilled from a vendor's "historical" series, which
can be retrospectively restated (legacy flagged this for trendlyne P/E history and never
resolved it).

Payload shape and the bare-NSE-symbol key were live-verified by the legacy fetcher
(investsights_fundamentals_fetcher.py, 2026-08-13); InvestSights ROE matched Yahoo at
Pearson 0.96 when Yahoo's ROE field decayed to 6% fill.
"""
from __future__ import annotations

import datetime as dt

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import FetchError, HttpClient
from bharat_alpha.reference import current_symbols
from bharat_alpha.timeutil import ist_now

BASE = "https://investsights.in/api/v2/fundamentals/{symbol}"
RATIO_FIELDS = (
    "pe_ratio", "price_to_book", "price_to_sales", "ev_to_ebitda", "operating_profit_margin",
    "net_profit_margin", "return_on_equity", "return_on_assets", "return_on_capital_employed",
    "debt_to_equity", "interest_coverage", "piotroski_score", "altman_z_score", "dividend_yield",
)
GROWTH_FIELDS = ("revenue_growth", "net_income_growth", "eps_growth", "free_cash_flow_growth")


def _data(payload):
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    d = payload.get("data")
    if isinstance(d, list):
        return d[0] if d else None
    return d


def _num(d: dict | None, k: str) -> float | None:
    if not d:
        return None
    v = d.get(k)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def parse_investsights(symbol: str, ratios_payload, growth_payload) -> list[dict]:
    ratios, growth = _data(ratios_payload), _data(growth_payload)
    pe = ((ratios or {}).get("period_end_date") or "")[:10] or None
    period_end = dt.date.fromisoformat(pe) if pe else None
    out = []
    for src, fields in ((ratios, RATIO_FIELDS), (growth, GROWTH_FIELDS)):
        for f in fields:
            v = _num(src, f)
            if v is not None:
                out.append({"symbol": symbol, "field": f, "value": v, "period_end": period_end})
    return out


class InvestsightsFundamentals(Connector):
    name = "investsights_fundamentals"
    description = "InvestSights ratios (ROE, D/E, margins, P/E, P/B, Piotroski, Altman) + growth"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.fundamental", date_column="knowable_at", scope_sql="source = 'investsights_fundamentals'",
                    warn_after_sessions=6, fail_after_sessions=12,
                    fill_rates={"value": 0.99})

    def __init__(self, symbols: list[str] | None = None):
        self.symbols = symbols

    def fetch(self, client: HttpClient, on: dt.date) -> dict[str, tuple]:
        out = {}
        for sym in self.symbols or []:
            try:
                r1 = client.get(BASE.format(symbol=sym) + "/fmp-ratios", params={"period": "annual", "limit": 1})
                r2 = client.get(BASE.format(symbol=sym) + "/growth-metrics", params={"period": "annual", "limit": 1})
            except FetchError:
                continue
            if r1.ok or r2.ok:
                out[sym] = (r1.json() if r1.ok else None, r2.json() if r2.ok else None)
        return out

    def parse(self, raw: dict[str, tuple], on: dt.date) -> list[dict]:
        return [row for sym, (a, b) in raw.items() for row in parse_investsights(sym, a, b)]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        sym_to_iid = {s: i for i, s in current_symbols(conn).items()}
        with conn.cursor() as cur:
            # Only a CHANGED value is a new fact; re-writing identical values daily is write
            # amplification and would make every row look freshly knowable.
            cur.execute(
                "SELECT DISTINCT ON (instrument_id, field) instrument_id, field, value FROM alpha.fundamental "
                "WHERE source = %s ORDER BY instrument_id, field, knowable_at DESC", (self.name,))
            latest = {(i, f): v for i, f, v in cur.fetchall()}
        now = ist_now()
        out = [{"source": self.name, "instrument_id": sym_to_iid[r["symbol"]], "field": r["field"],
                "period_end": r["period_end"], "value": r["value"], "knowable_at": now}
               for r in rows if r["symbol"] in sym_to_iid
               and latest.get((sym_to_iid[r["symbol"]], r["field"])) != r["value"]]
        return upsert(conn, "alpha.fundamental", out, key=("source", "instrument_id", "field", "knowable_at"), update=())
