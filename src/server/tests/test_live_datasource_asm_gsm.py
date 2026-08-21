"""Live-datasource test for asm_gsm_fetcher.py (see CLAUDE.md's "Adding a New Data Source"
mandatory rule).

This is the fetcher with the single worst live-confirmed bug found in a 2026-07-30 audit pass
(its `backfill_technical_signals()` UPDATE had no WHERE clause at all and silently nulled
`asm_flag`/`gsm_stage` for every symbol's entire history on any day `date.today()` didn't
exactly match an existing row) -- yet it had never had a `live_datasource` test, the exact
control this repo's incident history says would have caught a defect like that immediately
rather than after weeks of silent data loss.

NSE's `reportASM`/`reportGSM` endpoints need a warmed session (a plain GET to nseindia.com
first to pick up cookies) but no stored auth token -- confirmed by reading `_nse_session()`
before writing this.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import asm_gsm_fetcher as agf
from live_datasource_helpers import assert_non_empty_response


@pytest.mark.live_datasource
class TestAsmGsmLiveDataSource:
    def test_real_fetch_returns_ml_usable_symbol_sets(self):
        """Step 1-3: hit the real NSE ASM/GSM endpoints, parse with the fetcher's own
        fetch_asm_symbols()/fetch_gsm_symbols(), assert the shapes are ML-usable."""
        sess = agf._nse_session()
        asm = agf.fetch_asm_symbols(sess)
        gsm = agf.fetch_gsm_symbols(sess)

        # A failed fetch returns None (never confused with a legitimate empty set) -- assert
        # the live endpoint actually succeeded, not just that the function didn't crash.
        assert asm is not None, "fetch_asm_symbols returned None -- live NSE ASM fetch failed"
        assert gsm is not None, "fetch_gsm_symbols returned None -- live NSE GSM fetch failed"
        assert_non_empty_response(list(asm), "fetch_asm_symbols")
        assert_non_empty_response(list(gsm), "fetch_gsm_symbols")

        # Every symbol must look like a real NSE ticker, not a URL/scrape artifact -- the
        # exact failure shape (a profile URL landing in a "symbol" column) that corrupted
        # 2.1M rows in this codebase's worst-ever incident (2026-07-23).
        for sym in list(asm)[:20]:
            assert sym.isupper() and "://" not in sym and " " not in sym, \
                f"ASM symbol does not look like a real ticker: {sym!r}"
        for sym, stage in list(gsm.items())[:20]:
            assert sym.isupper() and "://" not in sym and " " not in sym, \
                f"GSM symbol does not look like a real ticker: {sym!r}"
            assert isinstance(stage, int) and 0 <= stage <= 6, \
                f"GSM stage out of the documented 0-6 range: {stage!r} for {sym}"

    def test_real_fetch_writes_ml_usable_flags(self):
        """Step 4-5: write through the fetcher's own upsert_flags() into a throwaway
        Postgres schema (upsert_flags() has no `con` injection point -- it calls
        connect() directly -- so connect() itself is monkeypatched, matching the existing
        unit-test precedent in test_asm_gsm_fetcher.py's TestUpsertFlagsFailureIsolation),
        then read the row back and assert it's ML-usable: real flag values, not None/NaN."""
        sess = agf._nse_session()
        asm = agf.fetch_asm_symbols(sess)
        gsm = agf.fetch_gsm_symbols(sess)
        assert asm is not None and gsm is not None, "live fetch failed -- cannot exercise the write path"
        assert asm, "no ASM symbols currently flagged -- pick a different day to run this test"

        probe_symbol = sorted(asm)[0]

        # upsert_flags() calls con.close() itself at the end, so a single shared connection
        # can't be read back afterward -- open a second connection into the SAME throwaway
        # schema for the readback, mirroring the old temp-file-sqlite fixture's "close then
        # reconnect" pattern. Managed directly (not via pg_memory_conn) so the schema name is
        # known up front rather than parsed back out of the connection.
        import uuid
        import psycopg2
        from pg_test_support import _pg_dsn, _sa_url, pg_available, drop_throwaway_schema
        from sqlalchemy import create_engine
        from db_compat import ConnWrapper

        if not pg_available():
            pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")

        schema = f"t_{uuid.uuid4().hex[:12]}"
        admin = psycopg2.connect(**_pg_dsn())
        admin.autocommit = True
        admin.cursor().execute(f'CREATE SCHEMA "{schema}"')
        try:
            seed_engine = create_engine(_sa_url(schema), future=True)
            seed_sa_conn = seed_engine.connect()
            seed_conn = ConnWrapper(seed_sa_conn)
            seed_conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, is_asm INTEGER, gsm_stage INTEGER, surveillance_updated_at TEXT)")
            seed_conn.execute("INSERT INTO nse_stocks (symbol) VALUES (?)", (probe_symbol,))
            seed_conn.commit()

            orig_connect = agf.connect
            agf.connect = lambda: seed_conn
            try:
                updated = agf.upsert_flags(asm, gsm)
            finally:
                agf.connect = orig_connect

            assert updated >= 1, "upsert_flags() reported zero rows updated against a seeded symbol"

            check_engine = create_engine(_sa_url(schema), future=True)
            check_conn = ConnWrapper(check_engine.connect())
            row = check_conn.execute(
                "SELECT is_asm, gsm_stage, surveillance_updated_at FROM nse_stocks WHERE symbol = ?",
                (probe_symbol,),
            ).fetchone()
            check_conn.close()
            check_engine.dispose()
        finally:
            try:
                drop_throwaway_schema(admin, schema)
            finally:
                admin.close()

        is_asm, gsm_stage, updated_at = row
        assert is_asm == 1, f"seeded ASM symbol {probe_symbol} did not get is_asm=1"
        assert isinstance(gsm_stage, int) and 0 <= gsm_stage <= 6, \
            f"gsm_stage not a usable int in range: {gsm_stage!r}"
        assert updated_at, "surveillance_updated_at was not stamped"
