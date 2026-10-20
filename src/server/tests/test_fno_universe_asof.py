import pytest

from fno_universe_asof import fno_eligible_asof, fno_series_coverage


def _opt(conn, symbol, date, instrument="OPTSTK"):
    conn.execute(
        "INSERT INTO stock_option_features_history (symbol, trade_date, expiry, instrument, source) "
        "VALUES (?, ?, '2030-01-01', ?, 'nse_fo_bhav_old')",
        (symbol, date, instrument),
    )


def _seed(conn):
    # NEWFNO is F&O-eligible TODAY but has no dated row anywhere in the series.
    conn.execute("INSERT INTO nse_stocks (symbol, name, fno_eligible) VALUES ('NEWFNO', 'New', 1)")
    conn.execute("INSERT INTO nse_stocks (symbol, name, fno_eligible) VALUES ('OLDFNO', 'Old', 0)")
    _opt(conn, "OLDFNO", "2022-06-01")
    _opt(conn, "OLDFNO", "2022-06-02")
    _opt(conn, "DROPPED", "2022-06-01")  # left F&O before the next session
    _opt(conn, "NIFTY", "2022-06-01", "OPTIDX")  # an index option is not a stock
    _opt(conn, "OLDFNO", "2021-03-01")
    _opt(conn, "OLDFNO", "2024-07-05")
    conn.commit()


def test_never_falls_back_to_the_current_state_flag(pg_db_conn):
    _seed(pg_db_conn)
    assert "NEWFNO" not in fno_eligible_asof(pg_db_conn, "2021-06-01")
    assert "NEWFNO" not in fno_eligible_asof(pg_db_conn, "2022-06-01")


def test_returns_the_dated_membership_for_a_covered_date(pg_db_conn):
    _seed(pg_db_conn)
    assert fno_eligible_asof(pg_db_conn, "2022-06-01") == {"OLDFNO", "DROPPED"}


def test_membership_is_per_date_not_cumulative(pg_db_conn):
    _seed(pg_db_conn)
    assert fno_eligible_asof(pg_db_conn, "2022-06-02") == {"OLDFNO"}


def test_coverage_reports_the_real_span_not_the_requested_one(pg_db_conn):
    _seed(pg_db_conn)
    assert fno_series_coverage(pg_db_conn) == ("2021-03-01", "2024-07-05")


def test_an_uncovered_date_returns_empty_rather_than_guessing(pg_db_conn):
    _seed(pg_db_conn)
    assert fno_eligible_asof(pg_db_conn, "1999-01-01") == set()
    assert fno_eligible_asof(pg_db_conn, "2026-10-01") == set()


def test_empty_series_has_no_coverage(pg_db_conn):
    with pytest.raises(ValueError):
        fno_series_coverage(pg_db_conn)
