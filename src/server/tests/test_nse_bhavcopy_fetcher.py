"""Unit tests for nse_bhavcopy_fetcher's parser (no network -- always runs in CI).

The live round-trip lives in test_live_datasource_nse_bhavcopy.py.
"""
import datetime
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

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
            def __init__(s): s._c = pg_memory_conn()
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


# ── weekend special sessions + the archive's re-serve behaviour ─────────────────
# The backfill used to filter weekends out entirely, so NSE's live weekend sessions were never
# captured. Probing every calendar day fixes that, but exposes a second behaviour: for most
# weekend dates the archive RE-SERVES the previous session's file rather than 404ing --
# requesting Sunday 2024-10-20 returns a byte-identical copy of Friday 2024-10-18's file
# (verified by md5 across every weekend probed 2021-2026). Only THREE genuine weekend sessions
# exist in the whole history: Diwali Muhurat 2023-11-12, and the Budget sessions of
# 2025-02-01 and 2026-02-01.

class _FakeConn:
    def __init__(self):
        self.rows = []

    def execute(self, sql, params=()):
        if sql.strip().upper().startswith("INSERT"):
            self.rows.append(params)
        return self

    def fetchall(self):
        return []

    def fetchone(self):
        return None

    def commit(self):
        pass


def _csv(date_str, symbols=("RELIANCE", "INFY")):
    head = ("SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, "
            "LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, "
            "NO_OF_TRADES, DELIV_QTY, DELIV_PER")
    lines = [head]
    for s in symbols:
        lines.append(f"{s}, EQ, {date_str}, 100, 101, 102, 99, 100.5, 100.5, 100.7, "
                     f"1000, 10.5, 50, 500, 50.0")
    return "\n".join(lines)


def test_parser_keys_rows_off_the_files_own_date_not_the_request():
    """This is why a re-serve cannot corrupt the table: rows land under the file's true
    session date, so a re-served Friday file just upserts Friday's existing rows."""
    import nse_bhavcopy_fetcher as nbf
    rows = nbf.parse_bhavcopy(_csv("18-Oct-2024"))
    assert rows and {r["date"] for r in rows} == {"2024-10-18"}


def test_run_one_reports_a_reserved_file_and_counts_zero_for_that_date():
    """A re-serve must not be logged as a session on a day the market was shut."""
    import datetime
    import nse_bhavcopy_fetcher as nbf

    orig = nbf.fetch_bhavcopy
    try:
        nbf.fetch_bhavcopy = lambda d: nbf.parse_bhavcopy(_csv("18-Oct-2024"))
        n = nbf.run_one(_FakeConn(), datetime.date(2024, 10, 20))   # a Sunday
        assert n == 0, "a re-served file must not be counted as a session for the requested date"
    finally:
        nbf.fetch_bhavcopy = orig


def test_run_one_counts_a_genuine_weekend_session():
    """Budget Sunday 2026-02-01 is real -- the file's own date matches the request."""
    import datetime
    import nse_bhavcopy_fetcher as nbf

    orig = nbf.fetch_bhavcopy
    try:
        nbf.fetch_bhavcopy = lambda d: nbf.parse_bhavcopy(_csv("01-Feb-2026"))
        n = nbf.run_one(_FakeConn(), datetime.date(2026, 2, 1))
        assert n > 0, "a genuine weekend session must be stored and counted"
    finally:
        nbf.fetch_bhavcopy = orig


def test_backfill_no_longer_filters_out_weekends():
    """The weekday filter that used to live in backfill() is what made the Budget sessions
    unreachable. Guard against it being reintroduced."""
    import inspect
    import nse_bhavcopy_fetcher as nbf
    src = inspect.getsource(nbf.backfill)
    assert "weekday() < 5" not in src, (
        "backfill() is filtering weekdays again -- NSE runs live weekend sessions "
        "(Budget day, Diwali Muhurat) and they would be silently skipped"
    )


class TestMainNoDataExitCode:
    """A BullMQ catchup replay after a restart calls main() with no --date, which defaults
    to today -- if 'today' has rolled over to a weekend by the time the catchup fires, the
    bhavcopy legitimately doesn't exist. That must not sys.exit(1) and fail the whole
    ml-daily-ops step (2026-08-09 incident: a Sunday catchup run marked the job 'failed' and
    the daily digest reported it 40+ hours late)."""

    def _run_main_for_date(self, monkeypatch, date_str, run_one_returns=0):
        import nse_bhavcopy_fetcher as nbf
        monkeypatch.setattr(sys, "argv", ["nse_bhavcopy_fetcher.py", "--date", date_str])
        fake_conn = _FakeConn()
        fake_conn.close = lambda: None
        monkeypatch.setattr(nbf, "connect", lambda: fake_conn)
        monkeypatch.setattr(nbf, "ensure_schema", lambda conn: None)
        monkeypatch.setattr(nbf, "run_one", lambda conn, d: run_one_returns)
        nbf.main()

    def test_weekend_no_data_exits_zero(self, monkeypatch):
        # 2026-08-09 is a Sunday.
        self._run_main_for_date(monkeypatch, "2026-08-09")  # must not raise SystemExit

    def test_weekday_no_data_still_exits_one(self, monkeypatch):
        # 2026-08-07 is a Friday -- a real trading day with no data is still a genuine failure.
        with pytest.raises(SystemExit) as exc:
            self._run_main_for_date(monkeypatch, "2026-08-07")
        assert exc.value.code == 1
