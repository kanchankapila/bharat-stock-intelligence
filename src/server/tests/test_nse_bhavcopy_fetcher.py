"""Unit tests for nse_bhavcopy_fetcher's parser (no network -- always runs in CI).

The live round-trip lives in test_live_datasource_nse_bhavcopy.py.
"""
import datetime
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import nse_bhavcopy_fetcher as bhav


# Real NSE header + rows, including the leading spaces NSE actually emits in its CSV.
SAMPLE = (
    "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, "
    "CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\n"
    "RELIANCE, EQ, 29-Jul-2026, 1400.00, 1405.00, 1420.00, 1398.00, 1415.00, 1416.50, "
    "1410.25, 5000000, 70512.50, 120000, 2500000, 50.00\n"
    "20MICRONS, EQ, 29-Jul-2026, 40.05, 40.55, 40.60, 39.60, 39.95, 39.80, 40.01, "
    "241109, 96.47, 1314, 152747, 63.35\n"
    "1018GS2026, GS, 29-Jul-2026, 104.05, 104.35, 104.40, 103.35, 103.40, 103.40, 104.36, "
    "3223, 3.36, 9, 3223, 100.00\n"
    "SOMESME, SM, 29-Jul-2026, 10.00, 10.10, 10.50, 9.90, 10.20, 10.30, 10.15, "
    "1000, 0.10, 5, 800, 80.00\n"
)


class TestParse:
    def test_strips_nse_header_and_value_padding(self):
        rows = bhav.parse_bhavcopy(SAMPLE)
        assert rows, "parser returned nothing -- header padding likely not stripped"
        assert all(r['symbol'] == r['symbol'].strip() for r in rows)

    def test_filters_non_equity_series(self):
        """Gilts must not enter an equity cross-section."""
        syms = {r['symbol'] for r in bhav.parse_bhavcopy(SAMPLE)}
        assert '1018GS2026' not in syms
        assert 'RELIANCE' in syms

    def test_keeps_sme_series(self):
        syms = {r['symbol'] for r in bhav.parse_bhavcopy(SAMPLE)}
        assert 'SOMESME' in syms

    def test_equity_only_false_keeps_everything(self):
        rows = bhav.parse_bhavcopy(SAMPLE, equity_only=False)
        assert '1018GS2026' in {r['symbol'] for r in rows}

    def test_parses_nse_date_format_to_iso(self):
        rows = bhav.parse_bhavcopy(SAMPLE)
        assert all(r['date'] == '2026-07-29' for r in rows)

    def test_numeric_fields_are_floats_not_strings(self):
        r = next(x for x in bhav.parse_bhavcopy(SAMPLE) if x['symbol'] == 'RELIANCE')
        for k in ('open', 'high', 'low', 'close', 'volume', 'deliv_pct'):
            assert isinstance(r[k], float), f"{k} came back as {type(r[k])}"
        assert r['close'] == 1416.50
        assert r['deliv_pct'] == 50.00

    def test_drops_rows_with_unusable_close(self):
        bad = SAMPLE + "BROKEN, EQ, 29-Jul-2026, 1, 1, 1, 1, 1, -5, 1, 1, 1, 1, 1, 1\n"
        assert 'BROKEN' not in {r['symbol'] for r in bhav.parse_bhavcopy(bad)}

    def test_handles_nse_missing_value_sentinels(self):
        row = ("SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, "
               "LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, "
               "NO_OF_TRADES, DELIV_QTY, DELIV_PER\n"
               "THINLY, EQ, 29-Jul-2026, 10, 10, 10, 10, 10, 10, 10, 100, 0.01, 1, -, -\n")
        r = bhav.parse_bhavcopy(row)[0]
        assert r['deliv_qty'] is None and r['deliv_pct'] is None
        assert r['close'] == 10.0

    def test_empty_input_returns_empty_list(self):
        assert bhav.parse_bhavcopy("") == []

    def test_malformed_date_row_is_skipped_not_fatal(self):
        bad = SAMPLE + "ODDDATE, EQ, not-a-date, 1, 1, 1, 1, 1, 5, 1, 1, 1, 1, 1, 1\n"
        rows = bhav.parse_bhavcopy(bad)
        assert 'ODDDATE' not in {r['symbol'] for r in rows}
        assert 'RELIANCE' in {r['symbol'] for r in rows}


class TestUrl:
    def test_url_uses_ddmmyyyy(self):
        u = bhav.bhav_url(datetime.date(2026, 7, 29))
        assert u.endswith('sec_bhavdata_full_29072026.csv')

    def test_single_digit_day_is_zero_padded(self):
        assert bhav.bhav_url(datetime.date(2021, 1, 4)).endswith('04012021.csv')


class TestStore:
    def _conn(self):
        class C:
            def __init__(s): s._c = sqlite3.connect(':memory:')
            def execute(s, q, p=()): return s._c.execute(q, p)
            def commit(s): s._c.commit()
            def close(s): s._c.close()
        return C()

    def test_round_trip(self):
        c = self._conn()
        try:
            bhav.ensure_schema(c)
            rows = bhav.parse_bhavcopy(SAMPLE)
            assert bhav.store_bhavcopy(c, rows) == len(rows)
            got = c.execute(
                "SELECT symbol, close FROM nse_universe_history WHERE symbol='RELIANCE'"
            ).fetchone()
            assert got == ('RELIANCE', 1416.50)
        finally:
            c.close()

    def test_upsert_is_idempotent(self):
        c = self._conn()
        try:
            bhav.ensure_schema(c)
            rows = bhav.parse_bhavcopy(SAMPLE)
            bhav.store_bhavcopy(c, rows)
            bhav.store_bhavcopy(c, rows)
            n = c.execute("SELECT count(*) FROM nse_universe_history").fetchone()[0]
            assert n == len(rows)
        finally:
            c.close()

    def test_empty_store_is_a_noop(self):
        c = self._conn()
        try:
            bhav.ensure_schema(c)
            assert bhav.store_bhavcopy(c, []) == 0
        finally:
            c.close()


class TestMonthEnds:
    def test_yields_weekdays_only(self):
        ds = list(bhav.month_ends(datetime.date(2026, 1, 1), datetime.date(2026, 12, 31)))
        assert ds and all(d.weekday() < 5 for d in ds)

    def test_one_per_month(self):
        ds = list(bhav.month_ends(datetime.date(2026, 1, 1), datetime.date(2026, 6, 30)))
        assert len({(d.year, d.month) for d in ds}) == len(ds)

    def test_does_not_overrun_the_end_bound(self):
        end = datetime.date(2026, 3, 15)
        assert all(d <= end for d in bhav.month_ends(datetime.date(2026, 1, 1), end))
