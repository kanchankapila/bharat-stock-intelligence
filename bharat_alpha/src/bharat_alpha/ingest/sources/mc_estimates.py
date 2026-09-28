"""MoneyControl analyst estimates: rating counts, price targets, next-period EPS/revenue.

Estimate REVISIONS are the best-documented public-equity signal family and were ungraded in
the legacy platform. Values are stored in alpha.fundamental (long format, knowable_at = the
moment observed, a row only when a value changes), so revision features are a point-in-time
difference of two snapshots.

Endpoint shapes and field names are those the legacy analyst_estimates_snapshot.py parsed live
(`{"success": 1, "data": {...}}`; analystCount / ratings[name,value]; high/mean/low;
eps[] / revenue[] with avg + actual). Keyed on MoneyControl's scId from alpha.provider_id
(ambiguous codes excluded), never constructed from the symbol.
"""
from __future__ import annotations

import datetime as dt

import psycopg

from bharat_alpha.db import read_df, upsert
from bharat_alpha.ingest.base import Connector, Health
from bharat_alpha.ingest.http import FetchError, HttpClient
from bharat_alpha.reference.provider_ids import provider_keys
from bharat_alpha.timeutil import eod_knowable_at, ist_now

BASE = "https://api.moneycontrol.com/mcapi/v1/stock/estimates"
URLS = {
    "rating": BASE + "/analyst-rating?deviceType=W&scId={sc}&ex=N",
    "price": BASE + "/price-forecast?scId={sc}&ex=N&deviceType=W",
    "earnings": BASE + "/earning-forecast?scId={sc}&ex=N&deviceType=W&frequency=12&financialType=C",
}
HEADERS = {"Referer": "https://www.moneycontrol.com/", "Accept": "application/json, text/plain, */*"}
FIELDS = ("est_n_analysts", "est_buy_pct", "est_target_mean", "est_target_high", "est_target_low",
          "est_eps_next", "est_revenue_next")


def _pos(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f != 0.0 else None            # MC sends 0 for "no estimate"


def _data(payload) -> dict | None:
    if isinstance(payload, dict) and payload.get("success") == 1:
        return payload.get("data") or None
    return None


def parse_estimates(rating, price, earnings) -> dict[str, float]:
    out: dict[str, float] = {}
    r = _data(rating)
    if r:
        n = _pos(r.get("analystCount"))
        buy = hold = sell = 0.0
        for item in r.get("ratings") or []:
            name = (item.get("name") or "").upper()
            c = _pos(item.get("value")) or 0.0
            if "BUY" in name or "OUTPERFORM" in name:
                buy += c
            elif "HOLD" in name or "NEUTRAL" in name:
                hold += c
            elif "SELL" in name or "UNDERPERFORM" in name:
                sell += c
        if n:
            out["est_n_analysts"] = n
        if buy + hold + sell > 0:
            out["est_buy_pct"] = buy / (buy + hold + sell)
    p = _data(price)
    if p:
        for k, f in (("mean", "est_target_mean"), ("high", "est_target_high"), ("low", "est_target_low")):
            v = _pos(p.get(k))
            if v is not None:
                out[f] = v
    e = _data(earnings)
    if e:
        for key, f in (("eps", "est_eps_next"), ("revenue", "est_revenue_next")):
            nxt = next((x for x in (e.get(key) or []) if not x.get("actual")), None)
            v = _pos(nxt.get("avg")) if nxt else None
            if v is not None:
                out[f] = v
    return out


def write_estimates(conn: psycopg.Connection, source: str, rows: list[dict]) -> int:
    """rows: {instrument_id, field, value, knowable_at}. Only CHANGED values are stored."""
    latest = read_df(conn, """SELECT DISTINCT ON (instrument_id, field) instrument_id, field, value
                              FROM alpha.fundamental WHERE source=%s ORDER BY instrument_id, field, knowable_at DESC""",
                     (source,))
    last = {(int(i), f): v for i, f, v in latest.itertuples(index=False)}
    new = []
    for r in sorted(rows, key=lambda x: x["knowable_at"]):
        k = (r["instrument_id"], r["field"])
        if last.get(k) != r["value"]:
            new.append({"source": source, "period_end": None, **r})
            last[k] = r["value"]
    return upsert(conn, "alpha.fundamental", new, key=("source", "instrument_id", "field", "knowable_at"), update=())


class McEstimates(Connector):
    name = "mc_estimates"
    description = "MoneyControl analyst ratings, price targets and next-period EPS/revenue estimates"
    per_date = False
    dedupes_unchanged = True
    health = Health(table="alpha.fundamental", date_column="knowable_at", scope_sql="source = 'mc_estimates'",
                    warn_after_sessions=2, fail_after_sessions=5, fill_rates={"value": 0.99})

    def __init__(self, limit: int | None = None):
        self.limit = limit
        self.ids: list[tuple[int, str]] = []

    def prepare(self, conn: psycopg.Connection, on: dt.date) -> None:
        self.ids = sorted(provider_keys(conn, "moneycontrol").items())[: self.limit]

    def fetch(self, client: HttpClient, on: dt.date) -> dict[int, tuple]:
        out = {}
        for iid, sc in self.ids:
            try:
                got = []
                for k in ("rating", "price", "earnings"):
                    r = client.get(URLS[k].format(sc=sc), headers=HEADERS)
                    got.append(r.json() if r.ok else None)
            except (FetchError, ValueError):
                continue
            out[iid] = tuple(got)
        return out

    def parse(self, raw: dict[int, tuple], on: dt.date) -> list[dict]:
        now = ist_now()
        return [{"instrument_id": int(iid), "field": f, "value": v, "knowable_at": now}
                for iid, payloads in raw.items() for f, v in parse_estimates(*payloads).items()]

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        return write_estimates(conn, self.name, rows)


def import_legacy_estimates(conn: psycopg.Connection, legacy: psycopg.Connection) -> int:
    """legacy analyst_estimates_history (one PIT snapshot per symbol per as_of_date). Each row is
    stamped knowable at EOD of its as_of_date — the legacy writer ran on that date."""
    with legacy.cursor() as cur:
        cur.execute("""SELECT symbol, as_of_date, n_analysts, buy_count, hold_count, sell_count, target_high,
                              target_mean, target_low, eps_est_next, revenue_est_next
                       FROM public.analyst_estimates_history ORDER BY as_of_date""")
        hist = cur.fetchall()
    cur_syms = read_df(conn, """SELECT DISTINCT ON (instrument_id) instrument_id, symbol FROM alpha.symbol_history
                                ORDER BY instrument_id, valid_from DESC""")
    s2i = dict(zip(cur_syms.symbol, cur_syms.instrument_id.astype(int)))
    rows = []
    for sym, d, n, b, h, s, th, tm, tl, eps, rev in hist:
        iid = s2i.get(sym)
        if iid is None:
            continue
        k = eod_knowable_at(d)
        vals = {"est_n_analysts": _pos(n), "est_target_high": _pos(th), "est_target_mean": _pos(tm),
                "est_target_low": _pos(tl), "est_eps_next": _pos(eps), "est_revenue_next": _pos(rev)}
        tot = sum(x or 0 for x in (b, h, s))
        if tot:
            vals["est_buy_pct"] = (b or 0) / tot
        rows += [{"instrument_id": iid, "field": f, "value": v, "knowable_at": k} for f, v in vals.items() if v is not None]
    n = write_estimates(conn, "mc_estimates", rows)
    conn.commit()
    return n
