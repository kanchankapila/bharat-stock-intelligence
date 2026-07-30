"""
Fundamentals Snapshotter
=========================
stock_fundamentals holds only the *current* values. Joining it onto historical signal rows
(as ml_ensemble did) leaks future fundamentals into training. This script appends today's
fundamentals into fundamentals_history(symbol, as_of_date), building the point-in-time trail
ml_ensemble.load_training_data joins as-of each signal_date.

Idempotent per day: re-running overwrites today's snapshot. Run daily, after the
fundamentals sync. The leakage fix improves with every day this accumulates; until enough
history exists, the ensemble falls back to the current snapshot (no regression).

pledge_pct (from trendlyne_stock_profile) is also snapshotted daily. After writing, the
script computes pledge_chg_90d = current pledge_pct minus pledge_pct 90 days ago, and writes
it to technical_signals so ML engines and the UI can consume the trend:
  - pledge_chg_90d > +2 : promoter pledging more → financial distress → bearish
  - pledge_chg_90d < -2 : promoter reducing pledges → deleveraging → bullish

Run:  python fundamentals_snapshot.py
      python fundamentals_snapshot.py --as-of 2026-06-21
"""

import argparse
import datetime

from db_compat import execute, query_all, query_scalar, use_postgres, connect

# ── Schema migrations (idempotent ADD COLUMN) ────────────────────────────────

_SCHEMA_MIGRATIONS = [
    "ALTER TABLE fundamentals_history ADD COLUMN pledge_pct REAL",
    "ALTER TABLE technical_signals ADD COLUMN pledge_chg_90d REAL",
]

# ── Snapshot SQL ─────────────────────────────────────────────────────────────

# SQLite cannot parse `INSERT ... SELECT ... ON CONFLICT` (parser ambiguity with the SELECT's
# ON). Delete-then-insert-select is idempotent per day and portable to Postgres.
_DELETE_SQL = "DELETE FROM fundamentals_history WHERE as_of_date = ?"
_INSERT_SQL = """
INSERT INTO fundamentals_history
    (symbol, as_of_date, fifty_two_week_high, piotroski_f_score, debt_to_equity,
     operating_margins, return_on_equity, revenue_growth, earnings_growth,
     earnings_yield, price_to_book, market_cap, pledge_pct)
SELECT
    sf.symbol,
    ?,
    sf.fifty_two_week_high,
    sf.piotroski_f_score,
    sf.debt_to_equity,
    sf.operating_margins,
    sf.return_on_equity,
    sf.revenue_growth,
    sf.earnings_growth,
    sf.earnings_yield,
    sf.price_to_book,
    sf.market_cap,
    tsp.pledge_pct
FROM stock_fundamentals sf
LEFT JOIN (
    SELECT symbol, pledge_pct
    FROM trendlyne_stock_profile
    WHERE (symbol, date) IN (
        SELECT symbol, MAX(date)
        FROM trendlyne_stock_profile
        GROUP BY symbol
    )
) tsp ON tsp.symbol = sf.symbol
"""

# ── pledge_chg_90d computation ────────────────────────────────────────────────

# SQLite uses date(x, '-90 days'); Postgres uses x::date - INTERVAL '90 days'.
# We build the query string at runtime after knowing which DB is in use.

def _pledge_chg_sql(pg: bool) -> str:
    if pg:
        hist_cutoff = "cur.as_of_date::date - INTERVAL '90 days'"
        cur_filter  = "cur.as_of_date::date = (SELECT MAX(as_of_date::date) FROM fundamentals_history WHERE symbol = cur.symbol)"
        # Postgres: as_of_date is stored as text — cast both sides to ::date for all comparisons
        hist_join_date = "h2.as_of_date::date"
        hist_col_date  = "hist.as_of_date::date"
    else:
        hist_cutoff    = "date(cur.as_of_date, '-90 days')"
        cur_filter     = "cur.as_of_date = (SELECT MAX(as_of_date) FROM fundamentals_history WHERE symbol = cur.symbol)"
        hist_join_date = "h2.as_of_date"
        hist_col_date  = "hist.as_of_date"
    return f"""
SELECT
    cur.symbol,
    cur.pledge_pct - hist.pledge_pct AS pledge_chg_90d
FROM fundamentals_history cur
JOIN fundamentals_history hist
    ON hist.symbol = cur.symbol
    AND {hist_col_date} = (
        SELECT MAX({hist_join_date})
        FROM fundamentals_history h2
        WHERE h2.symbol = cur.symbol
          AND {hist_join_date} <= {hist_cutoff}
    )
WHERE {cur_filter}
  AND cur.pledge_pct  IS NOT NULL
  AND hist.pledge_pct IS NOT NULL
"""

# date >= floor ELSE NULL guard added 2026-07-19 -- the old `updated_at IS NULL OR ...` guard
# was not a date filter at all: technical_signals.updated_at is NULL for 100% of rows in
# production (nothing else in the codebase sets it), so `updated_at IS NULL` always matched
# and this plain `=` (not actually COALESCE, despite the stale comment above) overwrote every
# historical row for a symbol on every run -- same bug class as mc_pricefeed_fetcher.py etc.
_UPDATE_TS_SQL = """
UPDATE technical_signals
SET    pledge_chg_90d = CASE WHEN date >= ? THEN ? ELSE NULL END
WHERE  symbol = ?
"""


def _ensure_schema() -> None:
    """Add new columns to existing tables; silently ignore if already present."""
    for ddl in _SCHEMA_MIGRATIONS:
        try:
            execute(ddl)
        except Exception:
            pass  # column already exists


def _last_trading_session_floor(as_of: str) -> str:
    """Last completed trading session (MAX(date) FROM stock_ohlcv), falling back to `as_of`
    if the query fails or the table is empty. Used only as the `date >= ?` guard threshold
    for the technical_signals UPDATE below -- NOT for the fundamentals_history snapshot date,
    which stays `as_of` (today, or --as-of) since that's an INSERT, not a NULL-ing guard.

    date.today()-anchoring here was the same bug class fixed 2026-07-25 in 6 sibling fetchers
    (trendlyne_fundamentals_fetcher.py etc): on a weekend/holiday run, `date.today()` matches
    zero technical_signals rows, so the CASE...ELSE NULL branch fires and nulls every existing
    historical pledge_chg_90d row for that symbol, silently, on every such run.
    """
    try:
        d = query_scalar("SELECT MAX(date) AS d FROM stock_ohlcv")
        return str(d)[:10] if d else as_of
    except Exception:
        return as_of


def _compute_and_write_pledge_trend(pg: bool, ts_floor: str) -> int:
    """Compute pledge_chg_90d for all symbols with sufficient history and write to
    technical_signals. Returns the number of symbols updated."""
    rows = query_all(_pledge_chg_sql(pg))
    if not rows:
        return 0
    con = connect()
    try:
        cur = con.cursor()
        for row in rows:
            cur.execute(_UPDATE_TS_SQL, (ts_floor, row["pledge_chg_90d"], row["symbol"]))
        con.commit()
    finally:
        con.close()
    return len(rows)


def run(as_of: str | None = None) -> int:
    """Snapshot current stock_fundamentals (+ pledge_pct from trendlyne_stock_profile) into
    fundamentals_history for `as_of` (default today). Then computes pledge_chg_90d and writes
    it to technical_signals. Idempotent: re-running overwrites that day's snapshot.
    Returns rows written to fundamentals_history."""
    as_of = as_of or datetime.date.today().isoformat()
    pg    = use_postgres()

    _ensure_schema()

    execute(_DELETE_SQL, (as_of,))
    n = execute(_INSERT_SQL, (as_of,))
    print(f"[FUND-SNAP] Wrote {n} fundamentals snapshots as_of {as_of}.")

    ts_floor = _last_trading_session_floor(as_of)
    n_trend = _compute_and_write_pledge_trend(pg, ts_floor)
    print(f"[FUND-SNAP] Wrote pledge_chg_90d for {n_trend} symbols -> technical_signals (floor={ts_floor}).")

    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Point-in-time fundamentals snapshotter")
    parser.add_argument("--as-of", help="Snapshot date YYYY-MM-DD (default: today)")
    args = parser.parse_args()
    run(as_of=args.as_of)
