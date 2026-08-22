"""
Mandatory live_datasource test for mc_stock_futures_oi_fetcher.py (data-sources.md).

Full fetch -> parse -> DB write -> read-back round trip, because this fetcher DOES write to
the DB and the rule requires the round trip in that case. Everything goes through the
fetcher's OWN functions (parse_expiries / parse_futures / write_rows / load_mc_symbol_map) --
never a hand-rolled reimplementation, or the test can pass while the real code is broken.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1 (conftest.py). Never runs in CI:
a MoneyControl outage must not redden the build.

⚠ This test writes through the fetcher's real write path. It runs against a THROWAWAY schema,
because on a developer box the default target is production (see recurring-bugs.md: a
live_datasource test once wrote 252 real RELIANCE bars into stock_ohlcv while reading back
through its own schema and seeing nothing).
"""

import datetime
import importlib
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)
from pg_test_support import _pg_dsn, _sa_url, drop_throwaway_schema, pg_available  # noqa: E402

# A large, unambiguously F&O-listed name. Its MC scId is resolved through the fetcher's own
# map rather than hardcoded, so a stale mapping fails loudly instead of silently 404ing.
REAL_SYMBOL = "RELIANCE"


@pytest.fixture()
def throwaway_db():
    """Point db_compat at a throwaway schema so the real write path cannot touch production."""
    import psycopg2
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")
    saved = {k: os.environ.get(k) for k in ("POSTGRES_URL", "USE_POSTGRES", "DATABASE_URL")}
    schema = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(**_pg_dsn())
    admin.autocommit = True
    admin.cursor().execute(f'CREATE SCHEMA "{schema}"')
    os.environ["USE_POSTGRES"] = "true"
    os.environ["POSTGRES_URL"] = _sa_url(schema)
    os.environ.pop("DATABASE_URL", None)
    import db_compat
    importlib.reload(db_compat)
    try:
        yield db_compat
    finally:
        db_compat.dispose_engines()
        try:
            drop_throwaway_schema(admin, schema)
        finally:
            admin.close()
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        importlib.reload(db_compat)


@pytest.mark.live_datasource
class TestMcStockFuturesOiLiveDataSource:
    def test_real_symbol_round_trips_into_an_ml_usable_row(self, throwaway_db):
        import mc_stock_futures_oi_fetcher as f
        importlib.reload(f)

        # 1. Resolve the provider id through the fetcher's own resolver, not a literal.
        #    nse_stocks does not exist in the throwaway schema, so seed just this one mapping
        #    -- the point under test is the ENDPOINT and the write path, not nse_stocks.
        f.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, mcsymbol TEXT)")
        f.execute("INSERT INTO nse_stocks (symbol, mcsymbol) VALUES (?, ?)", (REAL_SYMBOL, "RI"))
        mapping = f.load_mc_symbol_map([REAL_SYMBOL])
        sc_id = mapping.get(REAL_SYMBOL)
        assert sc_id, f"{REAL_SYMBOL} has no mcsymbol — resolution broken"

        # 2. Hit the real endpoints and parse with the fetcher's own parsers.
        expiries = f.parse_expiries(f._get(f._EXPIRY_URL.format(sc_id=sc_id)))
        assert_non_empty_response(expiries, f"getExpDts(id={sc_id})")
        today = datetime.date.today().isoformat()
        assert any(e >= today for e in expiries), (
            f"no non-expired contract in {expiries} — MC's expiry feed is stale or the "
            "dict-of-dicts shape parse_expiries() relies on has changed"
        )

        rows = f.fetch_symbol(sc_id)
        assert_non_empty_response(rows, f"getFuturesData(FUTSTK, id={sc_id})")
        row = rows[0]
        row["symbol"] = REAL_SYMBOL

        # 3. Shape: identifiers look like identifiers, numbers are real finite numbers.
        assert_looks_like_ticker(row["fno_symbol"], "futures fno_symbol")
        assert_numeric_and_finite(row["open_interest"], "open_interest")
        assert row["open_interest"] > 0, f"OI must be positive, got {row['open_interest']}"
        assert_numeric_and_finite(row["futures_price"], "futures_price")
        assert_numeric_and_finite(row["spot_price"], "spot_price")
        # Basis is derived, so a wrong sign convention here would silently poison a factor.
        assert row["basis"] == pytest.approx(row["futures_price"] - row["spot_price"])

        # 4. Write through the fetcher's OWN write path, then read the row back.
        as_of = "2026-08-21"
        f.ensure_schema()
        written = f.write_rows([row], as_of)
        assert written == 1, f"write_rows reported {written}"

        back = f.query_all(
            "SELECT source, symbol, date, expiry, open_interest, oi_buildup, basis, spot_price "
            "FROM stock_futures_oi_history WHERE symbol = ? AND date = ?",
            (REAL_SYMBOL, as_of),
        )
        assert len(back) == 1, f"expected exactly 1 stored row, got {len(back)}"
        stored = back[0]
        assert stored["source"] == f.SOURCE, "provider must be stamped -- it is part of the PK"
        assert_looks_like_ticker(stored["symbol"], "stored symbol")
        assert_numeric_and_finite(stored["open_interest"], "stored open_interest")
        assert_numeric_and_finite(stored["spot_price"], "stored spot_price")
        assert stored["expiry"], "expiry is part of the PK and must never be empty"

    def test_upsert_is_idempotent_on_the_composite_key(self, throwaway_db):
        """Two providers publish this family; the PK carries `source` for that reason. Writing
        the same (source, symbol, date, expiry) twice must update, not duplicate."""
        import mc_stock_futures_oi_fetcher as f
        importlib.reload(f)
        f.ensure_schema()
        row = {
            "symbol": "TESTSYM", "expiry": "2026-08-25", "open_interest": 1000.0,
            "oi_change": 10.0, "oi_pct_change": 1.0, "oi_buildup": "Long Buildup",
            "rollover_pct": 50.0, "oi_pcr": 0.6, "futures_price": 101.0, "spot_price": 100.0,
            "basis": 1.0, "contracts": 5.0, "futures_volume": 500.0, "lot_size": 100.0,
        }
        f.write_rows([row], "2026-08-21")
        row["open_interest"] = 2000.0
        f.write_rows([row], "2026-08-21")
        back = f.query_all("SELECT open_interest FROM stock_futures_oi_history WHERE symbol = ?",
                           ("TESTSYM",))
        assert len(back) == 1, f"composite-key upsert duplicated: {len(back)} rows"
        assert back[0]["open_interest"] == 2000.0, "upsert did not update the value"


class TestParsersOffline:
    """Pure-parser tests -- these DO run in CI, since they need no network."""

    def test_parse_expiries_handles_the_dict_of_dicts_shape(self):
        import mc_stock_futures_oi_fetcher as f
        payload = {"success": 1, "data": {
            "0": {"fno_exp": "2026-08-25"}, "1": {"fno_exp": "2026-09-29"}}}
        assert f.parse_expiries(payload) == ["2026-08-25", "2026-09-29"]

    def test_parse_expiries_empty_payload_is_empty_not_a_crash(self):
        import mc_stock_futures_oi_fetcher as f
        assert f.parse_expiries({}) == []
        assert f.parse_expiries({"data": {}}) == []

    def test_num_rejects_placeholders_rather_than_coercing_to_zero(self):
        import mc_stock_futures_oi_fetcher as f
        assert f._num("79,580,500") == 79580500.0
        assert f._num("-12.48") == -12.48
        for junk in (None, "", "NA", "-", "abc"):
            assert f._num(junk) is None, f"{junk!r} must be None, not 0 (fabricates a reading)"

    def test_parse_futures_returns_none_without_open_interest(self):
        import mc_stock_futures_oi_fetcher as f
        assert f.parse_futures({"data": {"fno_symbol": "X", "open_int": "NA"}}) is None
        assert f.parse_futures({}) is None

    def test_parse_futures_basis_needs_both_legs(self):
        import mc_stock_futures_oi_fetcher as f
        base = {"fno_symbol": "RELIANCE", "expiry_date": "2026-08-25", "open_int": "79,580,500"}
        assert f.parse_futures({"data": {**base, "lastprice": "1310.00"}})["basis"] is None
        r = f.parse_futures({"data": {**base, "lastprice": "1310.00", "spot_price": "1316.00"}})
        assert r["basis"] == pytest.approx(-6.0)
