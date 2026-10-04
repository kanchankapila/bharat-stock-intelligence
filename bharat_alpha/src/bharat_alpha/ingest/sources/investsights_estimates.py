"""InvestSights analyst estimates (`/api/v2/fundamentals/{symbol}/analyst-estimates?period=annual`):
FMP consensus EPS / revenue per FISCAL YEAR, a second estimate source beside mc_estimates.

Why it is worth a second source: each row is pinned to a fiscal-year end, so a revision is the
SAME year's estimate compared over time. MoneyControl's "next period" silently rolls forward
when a year reports, so its revision feature has to guess which jumps are rollovers.

Stored in alpha.fundamental as `est_is_<metric>_fy<YYYY>` (the table's key has no period_end;
period_end is also set). Forward-only: the vendor returns its current view, so knowable_at is
the fetch time and only a changed value is stored.

Payload shape from the 2026-07-31 payload probe (bharat_alpha/tests/fixtures/payload_probe.json):
`{"success": true, "data": [{"symbol": "WEBELSOLAR.NS", "date": "2028-03-31", "epsAvg": 11.4,
"revenueAvg": ..., "numAnalystsEps": 1, ...}, ...]}`. The price-target route answers
`available: false` for NSE names (FMP coverage gap) and is not used. A row whose symbol is not
the one requested is dropped, never booked against the requested name.
"""
from __future__ import annotations

import datetime as dt

import psycopg

from bharat_alpha.db import read_df
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import FetchError, HttpClient
from bharat_alpha.ingest.sources.mc_estimates import write_estimates
from bharat_alpha.reference import current_symbols
from bharat_alpha.timeutil import ist_now

URL = "https://investsights.in/api/v2/fundamentals/{symbol}/analyst-estimates"
SOURCE = "investsights_estimates"
METRICS = {"epsAvg": "eps", "revenueAvg": "revenue", "numAnalystsEps": "n_eps"}


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float("inf") else None


def fy_field(metric: str, fy_end: dt.date) -> str:
    return f"est_is_{metric}_fy{fy_end.year}"


def parse_is_estimates(symbol: str, payload) -> list[dict]:
    if not isinstance(payload, dict) or not payload.get("success") or not isinstance(payload.get("data"), list):
        return []
    out = []
    for row in payload["data"]:
        vendor_sym = str(row.get("symbol") or "").upper().removesuffix(".NS").removesuffix(".BO")
        if vendor_sym != symbol.upper():
            continue
        try:
            fy_end = dt.date.fromisoformat(str(row.get("date") or "")[:10])
        except ValueError:
            continue
        for key, metric in METRICS.items():
            v = _num(row.get(key))
            if v is None or (metric == "n_eps" and v <= 0):
                continue
            out.append({"symbol": symbol.upper(), "field": fy_field(metric, fy_end), "period_end": fy_end, "value": v})
    return out


class InvestsightsEstimates(Connector):
    name = SOURCE
    description = "InvestSights (FMP) annual consensus EPS / revenue per fiscal year, for same-year revisions"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.fundamental", date_column="knowable_at", scope_sql=f"source = '{SOURCE}'",
                    warn_after_sessions=6, fail_after_sessions=12, fill_rates={"value": 0.99})

    def __init__(self, symbols: list[str] | None = None):
        self.symbols = symbols

    def prepare(self, conn: psycopg.Connection, on: dt.date) -> None:
        if self.symbols is None:
            # instruments that traded in the last 5 sessions; bare NSE symbols are InvestSights' key
            df = read_df(conn, """SELECT DISTINCT s.symbol FROM alpha.daily_bar b
                                  JOIN alpha.symbol_history s ON s.instrument_id=b.instrument_id AND s.valid_to IS NULL
                                  WHERE b.trade_date >= (SELECT min(trade_date) FROM (SELECT trade_date FROM alpha.trading_day
                                        WHERE trade_date <= %s ORDER BY 1 DESC LIMIT 5) x)""", (on,))
            self.symbols = sorted(df.symbol)

    def fetch(self, client: HttpClient, on: dt.date) -> dict[str, dict]:
        out = {}
        for sym in self.symbols or []:
            try:
                r = client.get(URL.format(symbol=sym), params={"period": "annual"})
            except FetchError:
                continue
            if r.ok:
                try:
                    out[sym] = r.json()
                except ValueError:
                    continue
        return out

    def parse(self, raw: dict[str, dict], on: dt.date) -> list[dict]:
        return [row for sym, payload in raw.items() for row in parse_is_estimates(sym, payload)]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        sym_to_iid = {s: i for i, s in current_symbols(conn).items()}
        now = ist_now()
        return write_estimates(conn, SOURCE, [
            {"instrument_id": sym_to_iid[r["symbol"]], "field": r["field"], "period_end": r["period_end"],
             "value": r["value"], "knowable_at": now}
            for r in rows if r["symbol"] in sym_to_iid])
