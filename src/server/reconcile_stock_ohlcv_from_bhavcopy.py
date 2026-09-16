#!/usr/bin/env python3
"""
Reconcile stock_ohlcv against the exchange's own bhavcopy
===========================================================
stock_ohlcv's daily EOD row is written by liveStockData.ts's fetchAndPersistOHLCVData()
(the 'refresh-all-daily' BullMQ job, 16:00 IST) from Yahoo Finance's batch quote endpoint.
Live-verified 2026-09-03 (AF-20260903-01): when Yahoo's batch fetch misses more than
MAX_INDIVIDUAL_FALLBACKS symbols in one pass, the per-symbol fallback is skipped entirely
for ALL of them -- RELIANCE, NSE's single most liquid stock, was one of 412/2550 symbols
silently dropped from that day's persisted row, with no error.

nse_bhavcopy_fetcher.py already runs daily (inside ml-daily-ops, after stock-refresh) and
writes nse_universe_history from NSE's own official bhavcopy -- a same-day cross-check
confirmed its O/H/L/C/V values match Yahoo's to the decimal for RELIANCE, and it covers a
BROADER universe (3,300+ symbols/day vs Yahoo's ~2,550). It is the authoritative source for
what actually traded; this script reconciles stock_ohlcv against it every evening, filling
anything Yahoo missed and correcting anything it got wrong (overwrite=True is the default,
matching the same-day case where no split/dividend adjustment gap can yet exist between the
two sources -- see mc_ohlcv_backfill.py's adjustment_basis discontinuity note for why that
caveat does NOT apply here, only to older historical rows).

Dual-write validation phase (2026-09-03): this runs ALONGSIDE the existing Yahoo write, not
in place of it -- see AF-20260903-01. Once proven clean over several sessions, Yahoo's own
stock_ohlcv write in liveStockData.ts can be retired and this becomes the sole EOD writer.

Deliberately does NOT touch a day with no bhavcopy rows (holiday, upstream outage) -- see
recurring-bugs.md's "date >= floor THEN ... ELSE NULL erases history" class. A missing
source day is a clean no-op, never a wipe.

Run:
  python reconcile_stock_ohlcv_from_bhavcopy.py                    # latest bhavcopy date
  python reconcile_stock_ohlcv_from_bhavcopy.py --date 2026-09-02  # a specific day
  python reconcile_stock_ohlcv_from_bhavcopy.py --overwrite=false  # fill gaps only, never correct
"""

import argparse
import sys

from db_compat import connect, ConnWrapper


def reconcile(conn: ConnWrapper, trade_date: str | None = None, overwrite: bool = True) -> dict:
    """Upsert stock_ohlcv for trade_date from nse_universe_history's EQ-series rows,
    scoped to nse_stocks (this platform's canonical ~2,366-name master).

    That scoping is load-bearing, not cosmetic: nse_universe_history's EQ series alone
    (live-checked 2026-09-03, date 2026-09-02) carries 2,646 symbols against stock_ohlcv's
    2,436 -- but 209 of that 210-row gap are ETFs (ABSLBANETF, AONEGOLD, ...) and micro-caps
    outside nse_stocks entirely, which must NOT be silently added to stock_ohlcv's universe.
    Joining against nse_stocks collapses that to exactly 1 real gap for that date (PAYTM) --
    a second, independent confirmation of the RELIANCE-style Yahoo-drop bug (AF-20260903-01),
    not evidence the universe should widen.

    trade_date defaults to MAX(date) in nse_universe_history (the logical write floor --
    never date.today(), see recurring-bugs.md) so this always reconciles whatever
    nse_bhavcopy_fetcher.py most recently wrote, including when NSE's own file was staged/
    late and got walked back to an earlier session.
    """
    if trade_date is None:
        row = conn.execute("SELECT MAX(date) AS d FROM nse_universe_history").fetchone()
        trade_date = dict(row)["d"] if row else None
    if not trade_date:
        return {"trade_date": None, "read": 0, "written": 0, "skipped": "nse_universe_history is empty"}

    src = conn.execute(
        "SELECT n.symbol, n.open, n.high, n.low, n.close, n.volume FROM nse_universe_history n "
        "JOIN nse_stocks m ON m.symbol = n.symbol "
        "WHERE n.date = ? AND n.series = 'EQ' AND n.close IS NOT NULL AND n.close > 0",
        (trade_date,),
    ).fetchall()
    if not src:
        return {"trade_date": trade_date, "read": 0, "written": 0,
                 "skipped": f"no EQ-series bhavcopy rows for {trade_date}"}

    conflict = ("DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, "
                "close=excluded.close, volume=excluded.volume, "
                "adjustment_basis=excluded.adjustment_basis" if overwrite else "DO NOTHING")
    sql_ohlcv = ("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume, adjustment_basis) "
                 "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (symbol, date) " + conflict)

    # Ensure stock_delivery_volume exists
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_delivery_volume (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            series          TEXT,
            qty_traded      BIGINT,
            deliverable_qty BIGINT,
            delivery_pct    REAL,
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sdv_date ON stock_delivery_volume(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sdv_symbol ON stock_delivery_volume(symbol, date DESC)")

    deliv_conflict = ("DO UPDATE SET qty_traded=excluded.qty_traded, "
                      "deliverable_qty=excluded.deliverable_qty, delivery_pct=excluded.delivery_pct, "
                      "fetched_at=CURRENT_TIMESTAMP" if overwrite else "DO NOTHING")
    sql_deliv = ("INSERT INTO stock_delivery_volume (symbol, date, series, qty_traded, deliverable_qty, delivery_pct, fetched_at) "
                 "VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (symbol, date) " + deliv_conflict)

    src_full = conn.execute(
        "SELECT n.symbol, n.open, n.high, n.low, n.close, n.volume, n.series, n.deliv_qty, n.deliv_pct "
        "FROM nse_universe_history n "
        "JOIN nse_stocks m ON m.symbol = n.symbol "
        "WHERE n.date = ? AND n.series = 'EQ' AND n.close IS NOT NULL AND n.close > 0",
        (trade_date,),
    ).fetchall()

    ohlcv_batch = []
    deliv_batch = []
    for r in src_full:
        r = dict(r)
        ohlcv_batch.append((r["symbol"], trade_date, r["open"], r["high"], r["low"],
                            r["close"], r["volume"], "nse_bhavcopy_raw"))
        if r.get("deliv_pct") is not None:
            deliv_batch.append((r["symbol"], trade_date, r.get("series", "EQ"),
                                r.get("volume"), r.get("deliv_qty"), r.get("deliv_pct")))

    if hasattr(conn, "executemany"):
        conn.executemany(sql_ohlcv, ohlcv_batch)
        if deliv_batch:
            conn.executemany(sql_deliv, deliv_batch)
    else:
        for item in ohlcv_batch:
            conn.execute(sql_ohlcv, item)
        for item in deliv_batch:
            conn.execute(sql_deliv, item)
    conn.commit()

    # Backfill technical_signals.delivery_pct where null for this session
    tech_filled = 0
    try:
        cur = conn.cursor()
        cur.execute("""
            UPDATE technical_signals
            SET delivery_pct = (
                SELECT delivery_pct FROM stock_delivery_volume
                WHERE symbol = technical_signals.symbol AND date = ?
                LIMIT 1
            )
            WHERE date = ? AND delivery_pct IS NULL
        """, (trade_date, trade_date))
        tech_filled = cur.rowcount
        conn.commit()
    except Exception as te:
        print(f"[RECONCILE] technical_signals delivery_pct backfill skipped: {te}")

    return {
        "trade_date": trade_date,
        "read": len(src_full),
        "written": len(ohlcv_batch),
        "deliv_written": len(deliv_batch),
        "tech_filled": max(tech_filled, 0),
    }



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date")
    ap.add_argument("--overwrite", default="true")
    args = ap.parse_args()
    overwrite = args.overwrite.strip().lower() not in ("false", "0", "no")

    conn = connect()
    try:
        result = reconcile(conn, trade_date=args.date, overwrite=overwrite)
    finally:
        conn.close()

    if result.get("skipped"):
        print(f"[RECONCILE] {result['skipped']}")
        return 0
    print(f"[RECONCILE] {result['trade_date']}: {result['written']}/{result['read']} "
          f"stock_ohlcv rows and {result.get('deliv_written', 0)} delivery rows reconciled against nse_universe_history "
          f"({'overwrite' if overwrite else 'fill-only'}), filled {result.get('tech_filled', 0)} technical_signals.delivery_pct")
    return 0


if __name__ == "__main__":
    sys.exit(main())

