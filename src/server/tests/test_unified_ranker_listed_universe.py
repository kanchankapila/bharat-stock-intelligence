"""AF-20261015-12: 13 symbols that never appear in an NSE bhavcopy (retired aliases such as INDUSIND,
LARSEN, MAHINDRA, KOTAK, and the phantom CHOLAFINSV = CHOLAFIN's Yahoo bars under a second name) were
priced from Yahoo, so they passed the master+priced filter and were ranked next to the real listing:
INDUSIND Hold 42 vs INDUSINDBK Sell 23 for one company. A symbol the exchange does not list is not a
rankable candidate."""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import unified_ranker as ur

TODAY = date(2026, 10, 14)


def _seed(conn, bhavcopy_symbols, last_bhav=TODAY):
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, status TEXT, instrument_type TEXT)")
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE)")
    conn.execute("CREATE TABLE nse_universe_history (symbol TEXT, date DATE)")
    for s in ("INDUSINDBK", "INDUSIND", "RELIANCE"):
        conn.execute("INSERT INTO nse_stocks VALUES (?, 'ACTIVE', 'equity')", (s,))
        conn.execute("INSERT INTO stock_ohlcv VALUES (?, CURRENT_DATE)", (s,))
    for s in bhavcopy_symbols:
        conn.execute("INSERT INTO nse_universe_history VALUES (?, ?)", (s, last_bhav))
    conn.commit()


def test_alias_with_yahoo_bars_but_no_exchange_row_is_not_ranked(pg_conn):
    _seed(pg_conn, ["INDUSINDBK", "RELIANCE"])
    kept = ur.UnifiedRanker(conn=pg_conn)._restrict_to_tradeable_universe(
        {"INDUSINDBK", "INDUSIND", "RELIANCE"})
    assert kept == {"INDUSINDBK", "RELIANCE"}


def test_a_recent_listing_is_kept_even_if_only_the_last_file_has_it(pg_conn):
    _seed(pg_conn, ["INDUSINDBK", "RELIANCE", "INDUSIND"], last_bhav=TODAY - timedelta(days=30))
    kept = ur.UnifiedRanker(conn=pg_conn)._restrict_to_tradeable_universe(
        {"INDUSINDBK", "INDUSIND", "RELIANCE"})
    assert kept == {"INDUSINDBK", "INDUSIND", "RELIANCE"}


def test_empty_bhavcopy_table_never_empties_the_universe(pg_conn):
    _seed(pg_conn, [])
    kept = ur.UnifiedRanker(conn=pg_conn)._restrict_to_tradeable_universe(
        {"INDUSINDBK", "INDUSIND", "RELIANCE"})
    assert kept == {"INDUSINDBK", "INDUSIND", "RELIANCE"}


def test_inactive_alias_and_etf_are_excluded_even_with_recent_prices(pg_conn):
    _seed(pg_conn, ["INDUSINDBK", "INDUSIND", "RELIANCE"])
    pg_conn.execute("UPDATE nse_stocks SET status='INACTIVE' WHERE symbol='INDUSIND'")
    pg_conn.execute("UPDATE nse_stocks SET instrument_type='etf' WHERE symbol='RELIANCE'")
    pg_conn.commit()
    kept = ur.UnifiedRanker(conn=pg_conn)._restrict_to_tradeable_universe(
        {"INDUSINDBK", "INDUSIND", "RELIANCE"})
    assert kept == {"INDUSINDBK"}
