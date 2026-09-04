"""Guard tests for so_chain_source.

The two guards here are not defensive boilerplate -- each was written against a bug observed
live while building this module (2026-09-04):

  * without the staleness guard, RELIANCE resolved to a 2026-08-25 chain and would have been
    written as TODAY's PCR/IV, because the callers stamp rows with the current write floor;
  * without the expiry guard, the same chain's already-passed expiry produced a perfectly
    plausible-looking PCR off contracts that no longer exist.

Both are cheap to get wrong again in a refactor and silent when wrong, which is exactly the
combination that earns a test.
"""
import datetime

import pytest

from so_chain_source import (
    MAX_CHAIN_STALENESS_DAYS,
    as_date,
    as_niftytrader_payload,
    chain_rows,
    has_chain,
)


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return self._rows


class _FakeConn:
    """Dispatches on the SQL it is handed rather than returning one blanket answer.

    A stub that answers every query with the same payload passes against code that queries the
    wrong thing -- recurring-bugs.md's "a stub that dispatches on its input fails loudly on an
    unexpected call instead of confidently answering with someone else's data".
    """

    def __init__(self, sym_d, tbl_d, rows, close=100.0):
        self.sym_d, self.tbl_d, self.rows, self.close = sym_d, tbl_d, rows, close

    def execute(self, stmt, params=None):
        sql = str(stmt)
        if "max(date)" in sql and "sym_d" in sql:
            return _FakeResult([{"sym_d": self.sym_d, "tbl_d": self.tbl_d}])
        if "FROM so_option_chain" in sql:
            return _FakeResult(self.rows)
        if "FROM stock_ohlcv" in sql:
            return _FakeResult([{"close": self.close}])
        raise AssertionError(f"unexpected query: {sql[:120]}")


class _FakeEngine:
    def __init__(self, conn):
        self._conn = conn

    def begin(self):
        conn = self._conn

        class _Ctx:
            def __enter__(self):
                return conn

            def __exit__(self, *a):
                return False

        return _Ctx()


def _row(expiry, strike, ce_oi=100, pe_oi=50):
    return {
        "expiry": expiry, "strike": strike,
        "ce_oi": ce_oi, "pe_oi": pe_oi,
        "ce_iv": 20.0, "pe_iv": 22.0,
        "ce_volume": 10, "pe_volume": 5,
        "ce_price": 12.0, "pe_price": 8.0,
    }


def _engine(sym_d, tbl_d, rows, close=100.0):
    return _FakeEngine(_FakeConn(sym_d, tbl_d, rows, close))


class TestAsDate:
    def test_accepts_iso_string_date_and_datetime(self):
        assert as_date("2026-09-04") == datetime.date(2026, 9, 4)
        assert as_date(datetime.date(2026, 9, 4)) == datetime.date(2026, 9, 4)
        assert as_date(datetime.datetime(2026, 9, 4, 13, 30)) == datetime.date(2026, 9, 4)

    def test_iso_string_is_the_shape_that_actually_arrives(self):
        """db_compat registers a global DATE->str caster, so a native DATE column reads as a
        string here. Subtracting two of those raises TypeError, which the callers' outer
        except would swallow into a silent None -- the guard would look like it was firing
        when it was really erroring. This is that regression, pinned."""
        assert (as_date("2026-09-04") - as_date("2026-09-02")).days == 2


class TestStalenessGuard:
    def test_fresh_chain_is_returned(self):
        rows = [_row("2026-09-29", 100.0)]
        got = chain_rows(_engine("2026-09-02", "2026-09-04", rows), "INFY")
        assert got is not None
        as_of, spot, near = got
        assert as_of == "2026-09-02" and spot == 100.0 and len(near) == 1

    def test_chain_older_than_the_bar_is_rejected(self):
        rows = [_row("2026-09-29", 100.0)]
        stale = f"2026-08-{20:02d}"
        assert chain_rows(_engine(stale, "2026-09-04", rows), "RELIANCE") is None
        assert has_chain(_engine(stale, "2026-09-04", rows), "RELIANCE") is False

    def test_boundary_is_inclusive(self):
        rows = [_row("2026-09-29", 100.0)]
        sym_d = datetime.date(2026, 9, 4) - datetime.timedelta(days=MAX_CHAIN_STALENESS_DAYS)
        assert has_chain(_engine(sym_d.isoformat(), "2026-09-04", rows), "X") is True
        one_more = sym_d - datetime.timedelta(days=1)
        assert has_chain(_engine(one_more.isoformat(), "2026-09-04", rows), "X") is False


class TestExpiryGuard:
    def test_already_passed_expiry_is_rejected(self):
        """The live RELIANCE case: a chain whose only expiry had already come and gone."""
        rows = [_row("2026-08-25", 100.0)]
        assert chain_rows(_engine("2026-09-02", "2026-09-04", rows), "RELIANCE") is None

    def test_front_month_is_chosen_not_the_furthest_out(self):
        """Front-month matches what the original NSE path used (expiry_dates[0]), so
        stock_options_oi's history stays comparable. Picking max(expiry) would silently change
        what the pcr/atm_iv columns mean partway through the series."""
        rows = [_row("2026-09-29", 100.0), _row("2026-10-27", 110.0)]
        as_of, _spot, near = chain_rows(_engine("2026-09-02", "2026-09-04", rows), "INFY")
        assert {r["expiry"] for r in near} == {"2026-09-29"}

    def test_expired_front_month_falls_through_to_the_live_one(self):
        rows = [_row("2026-08-25", 90.0), _row("2026-09-29", 100.0)]
        _as_of, _spot, near = chain_rows(_engine("2026-09-02", "2026-09-04", rows), "INFY")
        assert {r["expiry"] for r in near} == {"2026-09-29"}


class TestNiftyTraderPayloadAdapter:
    def test_keys_match_what_compute_features_reads(self):
        """compute_features()/_atm_iv_from_chain() read these exact aliases via _f(). If this
        drifts, the adapter silently yields 0.0 for every field and the fetcher writes
        plausible-looking zeros instead of failing."""
        payload = as_niftytrader_payload(100.0, [_row("2026-09-29", 100.0)])
        assert payload["spotPrice"] == 100.0
        row = payload["opDatas"][0]
        for key in ("strike_price", "expiry_date", "calls_oi", "puts_oi",
                    "calls_ltp", "puts_ltp", "calls_iv", "puts_iv"):
            assert key in row, key
        assert row["expiry_date"] == "2026-09-29"
        assert row["calls_ltp"] == 12.0 and row["puts_ltp"] == 8.0

    def test_adapter_output_is_consumable_by_compute_features(self):
        """Calls the REAL function rather than re-asserting the adapter's own shape -- a test
        that reimplements its subject passes against unfixed source."""
        from stock_option_chain_fetcher import compute_features
        rows = [_row("2026-09-29", s) for s in (90.0, 100.0, 110.0)]
        out = compute_features(as_niftytrader_payload(100.0, rows), "INFY")
        assert out is not None
        assert out["symbol"] == "INFY"
        assert out["atm_strike"] == 100.0
        assert out["expiry"] == "2026-09-29"
        assert out["total_call_oi"] == 300 and out["total_put_oi"] == 150
