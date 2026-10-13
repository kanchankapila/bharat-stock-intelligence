import datetime as dt

from bharat_alpha.quality.checks import latest_unhealthy_ingests


def _run(conn, source, on, status):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO alpha.ingest_run
                   (source, target_date, started_at, finished_at, status, rows_written)
               VALUES (%s, %s, now(), now(), %s, 0)""",
            (source, on, status),
        )
    conn.commit()


def test_recovered_attempt_and_empty_sparse_source_do_not_fail_current_dq(conn):
    on = dt.date(2026, 10, 12)
    _run(conn, "nse_symbol_change", on, "failed")
    _run(conn, "nse_symbol_change", on, "success")
    _run(conn, "nse_results_rss", on, "empty")  # event-driven; zero events is valid

    assert latest_unhealthy_ingests(conn, on).empty


def test_latest_failure_and_empty_dense_source_remain_visible(conn):
    on = dt.date(2026, 10, 13)
    _run(conn, "nse_bhavcopy", on, "empty")
    _run(conn, "nse_symbol_change", on, "success")
    _run(conn, "nse_symbol_change", on, "failed")

    bad = latest_unhealthy_ingests(conn, on).set_index("source")
    assert bad.loc["nse_bhavcopy", "status"] == "empty"
    assert bad.loc["nse_symbol_change", "status"] == "failed"
