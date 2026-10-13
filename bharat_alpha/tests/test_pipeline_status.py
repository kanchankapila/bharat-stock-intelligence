import datetime as dt

from bharat_alpha.pipeline import daily


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
