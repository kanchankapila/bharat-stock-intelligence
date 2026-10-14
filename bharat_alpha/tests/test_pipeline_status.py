import datetime as dt

import psycopg

from bharat_alpha.pipeline import daily
from bharat_alpha.pipeline import scheduler


def test_run_step_persists_partial_without_hiding_it_in_detail(conn):
    on = dt.date(2026, 10, 12)
    result = daily.run_step(
        conn,
        "partial-test",
        on,
        lambda: {"_status": "partial", "optional_source": {"status": "failed", "rows": 0}},
    )

    assert result["status"] == "partial"
    assert result["optional_source"]["status"] == "failed"
    with conn.cursor() as cur:
        cur.execute("SELECT status, detail FROM alpha.job_run WHERE job='partial-test'")
        status, detail = cur.fetchone()
    assert status == "partial"
    assert "_status" not in detail
    assert detail["optional_source"]["status"] == "failed"


def test_run_step_refuses_a_duplicate_concurrent_job(conn, db_dsn):
    on = dt.date(2026, 10, 12)
    lock_name = f"bharat-alpha:locked-test:{on.isoformat()}"
    with psycopg.connect(db_dsn) as blocker:
        blocker.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (lock_name,))

        result = daily.run_step(
            conn,
            "locked-test",
            on,
            lambda: (_ for _ in ()).throw(AssertionError("duplicate body must not execute")),
        )

        assert result == {"status": "skipped", "reason": "already running"}
        blocker.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (lock_name,))


def test_ingest_optional_failure_is_partial_but_bhavcopy_failure_is_fatal(monkeypatch):
    class Source:
        def __init__(self, name):
            self.name = name

    monkeypatch.setattr(daily, "EOD_SEQUENCE", ("nse_bhavcopy", "optional"))
    monkeypatch.setattr(daily, "CONNECTORS", {
        "nse_bhavcopy": lambda: Source("nse_bhavcopy"),
        "optional": lambda: Source("optional"),
    })
    monkeypatch.setattr(
        daily,
        "run_connector",
        lambda _conn, source, _on, client=None: ("success", 10)
        if source.name == "nse_bhavcopy" else ("failed", 0),
    )

    result = daily.step_ingest(object(), dt.date(2026, 10, 12), client=object())
    assert result["_status"] == "partial"
    assert result["optional"]["status"] == "failed"

    monkeypatch.setattr(daily, "run_connector", lambda *_args, **_kwargs: ("failed", 0))
    try:
        daily.step_ingest(object(), dt.date(2026, 10, 12), client=object())
    except RuntimeError as exc:
        assert "bhavcopy not ingested" in str(exc)
    else:
        raise AssertionError("critical bhavcopy failure must stop the daily pipeline")


def test_vendor_failure_is_partial(monkeypatch):
    class Source:
        def __init__(self, name):
            self.name = name

    monkeypatch.setattr(daily, "VENDOR_SEQUENCE", ("good", "bad"))
    monkeypatch.setattr(daily, "CONNECTORS", {
        "good": lambda: Source("good"),
        "bad": lambda: Source("bad"),
    })
    monkeypatch.setattr(
        daily,
        "run_connector",
        lambda _conn, source, _on, client=None: ("success", 3)
        if source.name == "good" else ("failed", 0),
    )

    result = daily.step_vendor(object(), dt.date(2026, 10, 12), client=object())
    assert result["_status"] == "partial"
    assert result["bad"] == {"status": "failed", "rows": 0}


def test_each_vendor_source_exposes_its_own_partial_status(monkeypatch):
    class Source:
        name = "bad"

    monkeypatch.setattr(daily, "CONNECTORS", {"bad": Source})
    monkeypatch.setattr(daily, "run_connector", lambda *_args, **_kwargs: ("failed", 0))

    result = daily.step_vendor_source(object(), dt.date(2026, 10, 12), "bad", client=object())

    assert result == {"source_status": "failed", "rows": 0, "_status": "partial"}


def test_pending_session_requires_terminal_status_for_every_vendor(conn, monkeypatch):
    on = dt.date(2026, 10, 12)
    monkeypatch.setattr(scheduler, "is_probable_session", lambda _date: True)
    monkeypatch.setattr(scheduler, "VENDOR_SEQUENCE", ("one", "two"))
    with conn.cursor() as cur:
        for job in ("publish_h5", "publish_h21"):
            cur.execute(
                "INSERT INTO alpha.job_run(job,as_of_date,status,finished_at) VALUES (%s,%s,'success',now())",
                (job, on),
            )
        cur.execute(
            "INSERT INTO alpha.job_run(job,as_of_date,status,finished_at) VALUES ('vendor:one',%s,'partial',now())",
            (on,),
        )
    conn.commit()

    assert on in scheduler.pending_sessions(conn, on, (5, 21))

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO alpha.job_run(job,as_of_date,status,finished_at) VALUES ('vendor:two',%s,'success',now())",
            (on,),
        )
    conn.commit()

    assert scheduler.pending_sessions(conn, on, (5, 21)) == []
