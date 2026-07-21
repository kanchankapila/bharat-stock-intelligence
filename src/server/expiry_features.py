#!/usr/bin/env python3
"""
F&O Expiry Features
====================
Computes `days_to_expiry` / `is_expiry_day` onto `technical_signals`, the F&O-universe
counterpart to `days_to_next_results` (mc_earnings_fetcher.py): a stock held into its own
expiry (gamma pinning / unwind flows) carries different intraday risk than one that isn't,
same reasoning as holding into an earnings print. NULL for the ~1800+ stocks with no F&O
contract (`nt_fno_expiry` only covers the ~215-symbol F&O universe).

Source: `nt_fno_expiry` (symbol, exchange, expiry, lot_size), kept fresh by
sync_nt_fno_symbols.py's sync_fno_expiries() — this script only reads it, run immediately
after in the same daily-ops chain.

Run:  python expiry_features.py
"""
from db_compat import connect, use_postgres


def ensure_schema(con) -> None:
    cur = con.cursor()
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS days_to_expiry INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS is_expiry_day  INTEGER",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


def backfill_days_to_expiry(con) -> None:
    """Update technical_signals.days_to_expiry/is_expiry_day for today's row per symbol.
    nt_fno_expiry.symbol is already the canonical NSE ticker (no mcsymbol/scid mapping needed
    -- sync_nt_fno_symbols.py writes NiftyTrader's symbol_name directly).

    date = today guard added 2026-07-19 on both branches -- the PG branch previously matched
    (SELECT MAX(date)...) (see bse_event_classifier.py's run_daily docstring for why that's
    wrong), and the SQLite branch had NO date guard at all -- it overwrote every historical row
    for every symbol on every run (the severe smear bug, not just the milder latest-row one).
    """
    cur = con.cursor()
    if use_postgres():
        cur.execute("""
            UPDATE technical_signals ts
            SET days_to_expiry = subq.days,
                is_expiry_day  = CASE WHEN subq.days = 0 THEN 1 ELSE 0 END
            FROM (
                SELECT symbol, (MIN(expiry::date) - CURRENT_DATE) AS days
                FROM nt_fno_expiry
                WHERE expiry >= CURRENT_DATE::text
                GROUP BY symbol
            ) subq
            WHERE ts.symbol = subq.symbol
              AND ts.date = CURRENT_DATE::text
        """)
        # Clear stale values for symbols that dropped out of the F&O universe (delisted from
        # F&O, or nt_fno_expiry's own refresh temporarily has no rows for them).
        cur.execute("""
            UPDATE technical_signals ts
            SET days_to_expiry = NULL, is_expiry_day = NULL
            WHERE ts.date = CURRENT_DATE::text
              AND ts.days_to_expiry IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM nt_fno_expiry e
                  WHERE e.symbol = ts.symbol AND e.expiry >= CURRENT_DATE::text
              )
        """)
    else:
        cur.execute("""
            UPDATE technical_signals
            SET days_to_expiry = (
                    SELECT CAST(MIN(julianday(e.expiry) - julianday('now')) AS INTEGER)
                    FROM nt_fno_expiry e
                    WHERE e.symbol = technical_signals.symbol
                      AND e.expiry >= date('now')
                )
            WHERE date = date('now')
        """)
        cur.execute("""
            UPDATE technical_signals
            SET is_expiry_day = CASE WHEN days_to_expiry = 0 THEN 1 ELSE 0 END
            WHERE days_to_expiry IS NOT NULL AND date = date('now')
        """)
    con.commit()


def main() -> None:
    con = connect()
    ensure_schema(con)
    backfill_days_to_expiry(con)
    cur = con.cursor()
    cur.execute("""
        SELECT COUNT(*) FROM technical_signals
        WHERE days_to_expiry IS NOT NULL
          AND date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = technical_signals.symbol)
    """)
    n = cur.fetchone()[0]
    print(f"[ExpiryFeatures] days_to_expiry set on {n} F&O-universe symbols (latest row each).")
    con.close()


if __name__ == "__main__":
    main()
