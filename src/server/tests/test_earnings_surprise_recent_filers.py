"""AF-20261119-22: the daily results-season pass re-reads only names NSE broadcast a result for recently."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from earnings_surprise_fetcher import FILED_SQL  # noqa: E402


def test_selects_only_recent_filers_with_an_mc_id(pg_conn):
    pg_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, mcsymbol TEXT, status TEXT)")
    pg_conn.execute("CREATE TABLE nse_results_filings (symbol TEXT, broadcast_ts TIMESTAMPTZ)")
    pg_conn.executemany("INSERT INTO nse_stocks VALUES (?, ?, 'ACTIVE')",
                        [("FRESH", "FR"), ("STALE", "ST"), ("NOMC", None)])
    pg_conn.execute("INSERT INTO nse_results_filings VALUES ('FRESH', now() - interval '1 day')")
    pg_conn.execute("INSERT INTO nse_results_filings VALUES ('FRESH', now() - interval '2 hours')")
    pg_conn.execute("INSERT INTO nse_results_filings VALUES ('STALE', now() - interval '20 days')")
    pg_conn.execute("INSERT INTO nse_results_filings VALUES ('NOMC', now() - interval '1 hour')")
    pg_conn.commit()
    rows = pg_conn.execute(FILED_SQL.replace(":d", "?"), (3,)).fetchall()
    assert [tuple(r) for r in rows] == [("FRESH", "FR")]
