"""A fresh daily grid must inherit only financial facts already observed at its anchor."""
import pytest

import financial_ratios_fetcher as ratios


def seed(conn, symbol, day, fetched_at, *, fcf=4.0, interest=2.5, roce=18.0):
    conn.execute(
        "INSERT INTO tl_financial_quality "
        "(symbol, as_of_date, fetched_at, fcf_yield_approx, fcf_ttm_approx, "
        "interest_coverage, roce, fcf_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (symbol, day, fetched_at, fcf, fcf, interest, roce, 'capex'),
    )


def test_daily_delivery_repairs_new_row_without_rewriting_history(pg_db_conn):
    conn = pg_db_conn
    seed(conn, 'DELIVERY', '2026-10-13', '2026-10-14T02:00:00+00:00')
    for day in ('2026-10-12', '2026-10-23'):
        conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", ('DELIVERY', day))

    assert ratios.deliver_latest_quality(conn, '2026-10-23') == 1
    rows = conn.execute(
        "SELECT date::text, fcf_yield_approx, interest_coverage, roce, fcf_positive, "
        "debt_coverage_risk, fcf_basis FROM technical_signals WHERE symbol = ? ORDER BY date",
        ('DELIVERY',),
    ).fetchall()
    assert rows[0]['fcf_yield_approx'] is None
    assert tuple(rows[1])[1:] == (4.0, 2.5, 18.0, 1, 0, 'capex')


def test_daily_delivery_excludes_future_observations_and_stale_sources(pg_db_conn):
    conn = pg_db_conn
    seed(conn, 'FUTURE', '2026-10-13', '2026-10-24T01:00:00+00:00')
    seed(conn, 'OLD', '2026-01-01', '2026-01-02T01:00:00+00:00')
    seed(conn, 'ASOF', '2026-10-24', '2026-10-23T12:00:00+00:00')
    for symbol in ('FUTURE', 'OLD', 'ASOF'):
        conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (symbol, '2026-10-23'))

    assert ratios.deliver_latest_quality(conn, '2026-10-23') == 0
    assert conn.execute("SELECT count(fcf_yield_approx) FROM technical_signals").fetchone()[0] == 0


def test_daily_delivery_uses_last_known_snapshot_and_preserves_real_values(pg_db_conn):
    conn = pg_db_conn
    seed(conn, 'KNOWN', '2026-10-13', '2026-10-14T02:00:00+00:00', interest=1.0)
    seed(conn, 'KNOWN', '2026-10-23', '2026-10-24T01:00:00+00:00', interest=99.0)
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, roce) VALUES (?, ?, ?)",
        ('KNOWN', '2026-10-23', 22.0),
    )

    ratios.deliver_latest_quality(conn, '2026-10-23')
    row = conn.execute("SELECT interest_coverage, roce, debt_coverage_risk FROM technical_signals").fetchone()
    assert tuple(row) == (1.0, 22.0, 1)


def test_daily_delivery_rejects_missing_anchor(pg_db_conn):
    with pytest.raises(ValueError, match='anchor'):
        ratios.deliver_latest_quality(pg_db_conn, None)


def test_new_quarterly_fetch_preserves_previously_observed_history(pg_db_conn):
    conn = pg_db_conn
    conn.execute("INSERT INTO technical_signals (symbol, date, fcf_yield_approx, fcf_basis) "
                 "VALUES ('KEEP', '2026-10-22', 3.5, 'capex')")
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES ('KEEP', '2026-10-23')")
    ratios.update_technical_signals('KEEP', {'year_ending': '2026-03-31',
        'fcf_yield_approx': 4.0, 'fcf_basis': 'capex'}, conn, today='2026-10-23')
    rows = conn.execute("SELECT fcf_yield_approx FROM technical_signals ORDER BY date").fetchall()
    assert [r[0] for r in rows] == [3.5, 4.0]
