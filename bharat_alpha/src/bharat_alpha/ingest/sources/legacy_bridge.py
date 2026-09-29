"""One-off bootstrap from the legacy `bharat_intel` database.

The legacy platform already holds NSE bhavcopies back to 2021 (`nse_universe_history`, the
same exchange file parsed by the same rules) and FII/DII history (`fii_dii_flow`). Importing
them through this system's own writers means day one starts with ~5 years of survivorship-free
history instead of an empty table. These are not live connectors, so they are deliberately
absent from ingest.registry (and therefore from freshness monitoring).
"""
from __future__ import annotations

import datetime as dt

import psycopg

from bharat_alpha.db import upsert
from bharat_alpha.ingest.base import Connector, Health, run_connector
from bharat_alpha.ingest.sources.nse_bhavcopy import EQUITY_SERIES, write_bars
from bharat_alpha.timeutil import eod_knowable_at

_COLS = ("symbol", "series", "prev_close", "open", "high", "low", "close", "avg_price", "volume",
         "turnover_lacs", "num_trades", "deliv_qty", "deliv_pct")


class LegacyBhavcopy(Connector):
    name = "legacy_bhavcopy"
    description = "Import of legacy nse_universe_history (same NSE file, parsed by legacy)"
    health = Health(table="alpha.daily_bar", date_column="trade_date", scope_sql="source = 'legacy_bhavcopy'")

    def __init__(self, legacy: psycopg.Connection):
        self.legacy = legacy

    def fetch(self, client, on: dt.date) -> list[tuple]:
        with self.legacy.cursor() as cur:
            cur.execute(f"SELECT {', '.join(_COLS)} FROM public.nse_universe_history WHERE date = %s",
                        (on.isoformat(),))
            return cur.fetchall()

    def parse(self, raw: list[tuple], on: dt.date) -> list[dict]:
        out = []
        for t in raw:
            r = dict(zip(_COLS, t))
            if (r["series"] or "").strip() not in EQUITY_SERIES:
                continue
            out.append({"symbol": r["symbol"].strip().upper(), "series": r["series"].strip(), "trade_date": on,
                        "prev_close": r["prev_close"], "open": r["open"], "high": r["high"], "low": r["low"],
                        "last": None, "close": r["close"], "vwap": r["avg_price"], "volume": r["volume"],
                        "turnover_lacs": r["turnover_lacs"], "trades": r["num_trades"],
                        "deliv_qty": r["deliv_qty"], "deliv_pct": r["deliv_pct"]})
        return out

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        return write_bars(conn, rows, on, source=self.name)


def import_legacy(conn: psycopg.Connection, legacy_dsn: str, start: dt.date, end: dt.date) -> dict:
    stats = {"dates": 0, "rows": 0, "flows": 0}
    with psycopg.connect(legacy_dsn) as legacy:
        with legacy.cursor() as cur:
            cur.execute("SELECT DISTINCT date FROM public.nse_universe_history WHERE date BETWEEN %s AND %s ORDER BY 1",
                        (start.isoformat(), end.isoformat()))
            dates = [dt.date.fromisoformat(str(r[0])[:10]) for r in cur.fetchall()]
        conn_ = LegacyBhavcopy(legacy)
        for d in dates:
            status, n = run_connector(conn, conn_, d, raw=conn_.fetch(None, d))
            stats["dates"] += status == "success"
            stats["rows"] += n
        with legacy.cursor() as cur:
            cur.execute("SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net FROM public.fii_dii_flow "
                        "WHERE date BETWEEN %s AND %s", (start, end))
            flows = []
            for d, fb, fs, fn, db, ds, dn in cur.fetchall():
                for cat, b, s, n in (("FII", fb, fs, fn), ("DII", db, ds, dn)):
                    flows.append({"source": "legacy_fii_dii", "trade_date": d, "category": cat, "buy_cr": b,
                                  "sell_cr": s, "net_cr": n, "knowable_at": eod_knowable_at(d)})
    stats["flows"] = upsert(conn, "alpha.market_flow", flows, key=("source", "trade_date", "category"))
    conn.commit()
    return stats
