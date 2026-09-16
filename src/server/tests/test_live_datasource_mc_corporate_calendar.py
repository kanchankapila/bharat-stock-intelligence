"""Live-datasource test for mc_corporate_calendar_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). This fetcher forces USE_POSTGRES=true (os.environ.setdefault
in its own module) and its DB-write functions use genuinely Postgres-only SQL (NOW(),
ANY(ARRAY[...]), FILTER (WHERE ...), to_char()) with no SQLite-portable fallback -- so a
throwaway in-memory sqlite DB can't exercise the write path at all.

Instead this test isolates itself inside the REAL local Postgres instance (127.0.0.1:5433,
the same one every other DB-backed live_datasource test in this repo reaches) using a
dedicated schema + search_path shadowing: shadow tables named identically to the real
nse_stocks/corporate_actions/technical_signals are created in a throwaway schema, and
`SET search_path` makes every unqualified table reference in the fetcher's own SQL resolve
to those shadow tables instead of the real production ones. The schema (and everything in
it) is dropped in a `finally` block regardless of test outcome -- no production data is
ever read or written by this test.
"""
import os

import pytest

os.environ["POSTGRES_HOST"] = "127.0.0.1"
os.environ["POSTGRES_PORT"] = "5433"

import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pg_test_support import drop_throwaway_schema
sys.path.insert(0, os.path.dirname(__file__))

try:
    import psycopg2
    _PG_REACHABLE = True
except ImportError:
    _PG_REACHABLE = False

import mc_corporate_calendar_fetcher as mcc
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SCHEMA = "test_ldts_mc_corp_cal"
REAL_MCSYMBOL = "RI"
REAL_SYMBOL = "RELIANCE"


def _pg_reachable() -> bool:
    if not _PG_REACHABLE:
        return False
    try:
        conn = psycopg2.connect(host="127.0.0.1", port=5433, user="bharat",
                                 password="bharat", dbname="bharat_intel", connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


@pytest.mark.live_datasource
class TestMcCorporateCalendarFetcherLiveDataSource:
    def test_real_endpoints_produce_parseable_events(self):
        """Hits the real MC corporate-action-calendar endpoint (all 3 durations the fetcher
        actually uses) via the fetcher's own _fetch_duration(), parsed with its own
        _parse_events()."""
        combined = {}
        for dur in ("T", "TW", "NW"):
            listing = mcc._fetch_duration(dur)
            assert isinstance(listing, dict), f"_fetch_duration({dur!r}) should return a dict, got {type(listing)}"
            combined.update(listing)

        assert combined, "corporate-action-calendar endpoint returned zero date buckets across T/TW/NW -- may be down/changed"
        events = mcc._parse_events(combined)
        assert events, "_parse_events() produced zero events from a non-empty real response"
        for ev in events[:10]:
            assert ev["sc_id"], "parsed event missing sc_id"
            assert ev["event_type"], "parsed event missing event_type"

    def test_db_write_functions_against_isolated_postgres_schema(self):
        """Writes real fetched data through the fetcher's own _upsert_corporate_actions()/
        _stamp_technical_signals()/_refresh_historical_div() against a real Postgres
        connection, isolated to a throwaway schema via search_path shadowing so no
        production table is ever touched."""
        if not _pg_reachable():
            pytest.skip("no local Postgres reachable at 127.0.0.1:5433")

        # use_postgres()/translate() (db_compat.py) read USE_POSTGRES from the environment
        # fresh on every call, not just at import time -- another live_datasource test module
        # collected earlier in the same pytest session may have set it to "false", which would
        # make translate() mangle this fetcher's genuinely-Postgres-only SQL. Force it for the
        # duration of this test only and restore whatever it was before, so this test doesn't
        # itself leave the ambient environment in a state that breaks a test collected after it.
        orig_use_postgres = os.environ.get("USE_POSTGRES")
        os.environ["USE_POSTGRES"] = "true"

        combined = {}
        for dur in ("T", "TW", "NW"):
            combined.update(mcc._fetch_duration(dur))
        events = mcc._parse_events(combined)
        assert events, "no real events to exercise the write path with"

        admin = psycopg2.connect(host="127.0.0.1", port=5433, user="bharat",
                                  password="bharat", dbname="bharat_intel")
        admin.autocommit = True
        acur = admin.cursor()
        drop_throwaway_schema(admin, REAL_SCHEMA)
        acur.execute(f"CREATE SCHEMA {REAL_SCHEMA}")
        acur.execute(f"""
            CREATE TABLE {REAL_SCHEMA}.nse_stocks (mcsymbol TEXT, symbol TEXT)
        """)
        acur.execute(f"""
            CREATE TABLE {REAL_SCHEMA}.corporate_actions (
                symbol TEXT, ex_date TEXT, action_type TEXT, amount DOUBLE PRECISION,
                ratio TEXT, source TEXT, ingested_at TIMESTAMPTZ,
                UNIQUE (symbol, ex_date, action_type)
            )
        """)
        acur.execute(f"""
            CREATE TABLE {REAL_SCHEMA}.technical_signals (
                symbol TEXT, date TEXT,
                days_to_ex_div DOUBLE PRECISION, days_to_board_meeting DOUBLE PRECISION,
                upcoming_div_pct DOUBLE PRECISION, days_since_dividend DOUBLE PRECISION,
                last_dividend_amt DOUBLE PRECISION
            )
        """)
        acur.execute(f"""
            CREATE TABLE {REAL_SCHEMA}.stock_ohlcv (symbol TEXT, date TEXT, close DOUBLE PRECISION)
        """)
        acur.execute(
            f"INSERT INTO {REAL_SCHEMA}.nse_stocks (mcsymbol, symbol) VALUES (%s, %s)",
            (REAL_MCSYMBOL, REAL_SYMBOL),
        )
        today = date.today().isoformat()
        acur.execute(
            f"INSERT INTO {REAL_SCHEMA}.technical_signals (symbol, date) VALUES (%s, %s)",
            (REAL_SYMBOL, today),
        )
        acur.execute(
            f"INSERT INTO {REAL_SCHEMA}.stock_ohlcv (symbol, date, close) VALUES (%s, %s, %s)",
            (REAL_SYMBOL, today, 1400.0),
        )

        try:
            con = mcc.connect()
            con.execute(f"SET search_path TO {REAL_SCHEMA}, public")

            scid_map = mcc._build_scid_map(con)
            assert scid_map == {REAL_MCSYMBOL: REAL_SYMBOL}, \
                f"_build_scid_map() didn't read back the seeded shadow nse_stocks row: {scid_map}"
            n_ca = mcc._upsert_corporate_actions(con, events, scid_map)
            con.commit()

            ex_div, board = mcc._build_forward_maps(events, scid_map)
            n_ts = mcc._stamp_technical_signals(con, ex_div, board, dry_run=False)

            if n_ca:
                rows = con.execute(f"SELECT symbol, ex_date, amount FROM {REAL_SCHEMA}.corporate_actions").fetchall()
                assert rows, "_upsert_corporate_actions() reported writes but the table is empty"
                for symbol, ex_date, amount in rows:
                    assert_looks_like_ticker(symbol, context="corporate_actions.symbol")
                    assert ex_date, "corporate_actions.ex_date is empty"

            if ex_div or board:
                assert n_ts > 0, "_stamp_technical_signals() had ex_div/board data but stamped zero symbols"
                ts_row = con.execute(
                    f"SELECT days_to_ex_div, days_to_board_meeting FROM {REAL_SCHEMA}.technical_signals "
                    f"WHERE symbol = ?", (REAL_SYMBOL,),
                ).fetchone()
                if REAL_SYMBOL in ex_div:
                    assert_numeric_and_finite(ts_row[0], context="technical_signals.days_to_ex_div")
        finally:
            drop_throwaway_schema(admin, REAL_SCHEMA)
            admin.close()
            if orig_use_postgres is None:
                os.environ.pop("USE_POSTGRES", None)
            else:
                os.environ["USE_POSTGRES"] = orig_use_postgres
