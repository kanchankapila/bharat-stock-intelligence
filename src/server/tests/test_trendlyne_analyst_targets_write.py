"""
Regression test for the 2026-08-20 fix: extract_analyst_data() used to accept a `con` argument
and attempt the trendlyne_analyst_targets INSERT internally, guarded by `if recent and con is
not None`. The one real call site always passed con=None (a worker-thread call; DB writes must
happen on the main thread with a real connection -- same pattern upsert_profile()/
backfill_technical_signals() already use), so that guard silently and permanently disabled the
INSERT from the real batch flow -- trendlyne_analyst_targets went 39 days stale in production
while trendlyne_stock_profile's own aggregate analyst_count/analyst_buy_pct/analyst_upside_pct
columns (computed by the same function, unaffected by the guard) kept populating correctly the
whole time. That asymmetry -- one output of a function silently dead, a sibling output fine --
is what made it invisible: nothing ever errored, and the aggregate columns looked healthy.

Fixed by splitting the concerns: extract_analyst_data() now returns the raw per-broker report
list under "_analyst_reports" instead of writing it, and write_analyst_targets() does the actual
INSERT, called on the main thread with a real connection -- mirroring the existing pattern.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402
from trendlyne_overview_fetcher import (  # noqa: E402
    ensure_schema, extract_analyst_data, write_analyst_targets,
)

BODY = {
    "researchReports": {
        "tableData": [
            {"recoDate": "2026-08-01", "postAuthor": "Broker A", "targetPrice": "150",
             "recoPrice": "120", "rec": "BUY"},
            {"recoDate": "2026-08-05", "postAuthor": "Broker B", "targetPrice": "140",
             "recoPrice": "120", "rec": "HOLD"},
        ]
    }
}


class TestExtractAnalystDataReturnsReports:
    def test_returns_raw_reports_for_the_caller_to_persist(self):
        result = extract_analyst_data(BODY, "TESTSYM", "2026-08-20")
        assert result["analyst_count"] == 2
        assert len(result["_analyst_reports"]) == 2
        assert result["_analyst_reports"][0]["postAuthor"] == "Broker A"

    def test_empty_reports_returns_empty_dict(self):
        assert extract_analyst_data({"researchReports": {"tableData": []}}, "TESTSYM", "2026-08-20") == {}


class TestWriteAnalystTargetsActuallyPersists:
    def test_write_analyst_targets_inserts_rows_into_the_real_table(self):
        """The negative control for this fix: before it, no code path ever called an INSERT
        with a non-None connection from the real batch flow. This test drives the exact
        composition main() now uses -- extract then write -- and confirms rows land."""
        conn = pg_memory_conn()
        ensure_schema(conn)
        result = extract_analyst_data(BODY, "TESTSYM", "2026-08-20")
        write_analyst_targets("TESTSYM", result["_analyst_reports"], "2026-08-20", conn)

        rows = conn.execute(
            "SELECT symbol, broker, target_price, rating FROM trendlyne_analyst_targets "
            "WHERE symbol = ? ORDER BY reco_date", ("TESTSYM",)
        ).fetchall()
        assert len(rows) == 2, "both broker reports must be persisted"
        assert rows[0]["broker"] == "Broker A"
        assert rows[0]["target_price"] == 150.0
        assert rows[1]["broker"] == "Broker B"
        assert rows[1]["rating"] == "HOLD"

    def test_write_analyst_targets_is_a_noop_with_no_reports(self):
        conn = pg_memory_conn()
        ensure_schema(conn)
        write_analyst_targets("TESTSYM", [], "2026-08-20", conn)
        n = conn.execute("SELECT COUNT(*) AS n FROM trendlyne_analyst_targets").fetchone()["n"]
        assert n == 0
