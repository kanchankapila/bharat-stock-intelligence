"""
Factor Breakdown History Snapshot
==================================
stock_factor_breakdown is current-state-only (PRIMARY KEY symbol+timeframe, overwritten daily),
so there's no historical per-category score to backtest a regime-conditional edge against --
the real blocker on fitting unified_ranker.py's REGIME_CAT_TILT from actual outcomes instead of
hand-set multipliers (see unified_ranker.py's _load_regime_tilt_override docstring).

This snapshots today's stock_factor_breakdown into stock_factor_breakdown_history, tagged with
the day's regime from app_settings. Point-in-time by construction (each day's row is the score
as computed that day) -- no backfill is possible for history before this script started running.

Run:  python factor_breakdown_snapshot.py
"""

import polars as pl
import datetime

from db_compat import connect

TODAY = datetime.date.today().isoformat()


def run() -> int:
    conn = connect()
    try:
        regime_row = conn.execute(
            "SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1"
        ).fetchone()
        regime = regime_row["regime"] if regime_row and regime_row["regime"] else None

        existing = conn.execute(
            "SELECT COUNT(*) AS n FROM stock_factor_breakdown_history WHERE snapshot_date = ?",
            (TODAY,),
        ).fetchone()
        if existing and int(existing["n"]) > 0:
            print(f"[FactorSnapshot] {TODAY} already snapshotted ({existing['n']} rows) -- skipping.")
            return 0

        rows = conn.execute(
            "SELECT symbol, timeframe, technical, fundamental, momentum, valuation, delivery, news "
            "FROM stock_factor_breakdown"
        ).fetchall()
        if not rows:
            print("[FactorSnapshot] stock_factor_breakdown is empty -- nothing to snapshot.")
            return 0

        n = 0
        for r in rows:
            conn.execute(
                "INSERT INTO stock_factor_breakdown_history "
                "(symbol, timeframe, snapshot_date, technical, fundamental, momentum, "
                " valuation, delivery, news, regime) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (symbol, timeframe, snapshot_date) DO NOTHING",
                (r["symbol"], r["timeframe"], TODAY, r["technical"], r["fundamental"],
                 r["momentum"], r["valuation"], r["delivery"], r["news"], regime),
            )
            n += 1
        conn.commit()
        print(f"[FactorSnapshot] Snapshotted {n} rows for {TODAY} (regime={regime}).")
        return n
    finally:
        conn.close()


if __name__ == "__main__":
    run()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
