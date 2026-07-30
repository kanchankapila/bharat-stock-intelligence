"""Regression tests for Finding #65 (2026-07-28 full-stack audit): extra_endpoint_responses
has PRIMARY KEY (symbol, endpoint_name) and only ever holds the LATEST live snapshot -- no
history. run()'s fallback ("no rows for target_date -> use most recent existing date
instead") and its documented --date <past date> backfill mode both used to write this
current-only snapshot onto a historical technical_signals row, leaking today's
ext_fii_holding_pct/ext_t80_tech_score/ext_mojo_quality_rank/etc into the past (all
consumed by ml_ensemble.py). Fixed to only write onto the technical_signals row for the
date the snapshot was ACTUALLY fetched (extra_endpoint_responses.updated_at), skipping
(not fabricating) when the cached snapshot doesn't match target_date.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import extra_features_parser as efp


class _NoCloseConn:
    """Wraps a real sqlite3 connection so run()'s con.close() is a no-op -- lets the test
    query the DB for post-call assertions after run() thinks it closed the connection."""
    def __init__(self, real):
        self._real = real

    def close(self):
        pass

    def __getattr__(self, name):
        return getattr(self._real, name)


def _make_db():
    real = sqlite3.connect(":memory:")
    real.row_factory = sqlite3.Row
    con = _NoCloseConn(real)
    con.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT,
            ext_fii_holding_pct REAL, ext_dii_holding_pct REAL,
            ext_fii_qoq_chg REAL, ext_dii_qoq_chg REAL,
            ext_t80_tech_score REAL, ext_t80_quality_rank REAL,
            ext_t80_valuation_rank REAL, ext_t80_financial_pts REAL,
            ext_mojo_quality_rank REAL, ext_mojo_valuation_rank REAL,
            ext_mojo_financial_pts REAL
        )
    """)
    con.execute("""
        CREATE TABLE extra_endpoint_responses (
            symbol TEXT, endpoint_name TEXT, response_json TEXT, updated_at TEXT
        )
    """)
    return con


FII_RESPONSE = '{"summary": {"fii": {"percentage": 18.5, "changeQoQ": 1.2}, "dii": {"percentage": 21.0, "changeQoQ": -0.5}}}'


class TestSnapshotDateGuard:
    def test_snapshot_fetched_today_writes_onto_todays_row(self, monkeypatch):
        con = _make_db()
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES ('TCS', '2026-07-30')")
        con.execute(
            "INSERT INTO extra_endpoint_responses VALUES ('TCS', 'marketservices_shareholding', ?, '2026-07-30 09:00:00')",
            (FII_RESPONSE,),
        )
        con.commit()
        monkeypatch.setattr(efp, "connect", lambda: con)

        updated = efp.run("2026-07-30")

        assert updated == 1
        row = con.execute("SELECT ext_fii_holding_pct FROM technical_signals WHERE symbol='TCS'").fetchone()
        assert row["ext_fii_holding_pct"] == 18.5

    def test_snapshot_fetched_today_does_not_leak_onto_a_past_backfill_date(self, monkeypatch):
        """The core bug: --date 2026-06-01 (a past date) must NOT get today's snapshot
        written onto it, even if technical_signals has a row for that date."""
        con = _make_db()
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES ('TCS', '2026-06-01')")
        con.execute(
            "INSERT INTO extra_endpoint_responses VALUES ('TCS', 'marketservices_shareholding', ?, '2026-07-30 09:00:00')",
            (FII_RESPONSE,),
        )
        con.commit()
        monkeypatch.setattr(efp, "connect", lambda: con)

        updated = efp.run("2026-06-01")

        assert updated == 0, "a snapshot fetched today must not be written onto a historical row"
        row = con.execute("SELECT ext_fii_holding_pct FROM technical_signals WHERE symbol='TCS'").fetchone()
        assert row["ext_fii_holding_pct"] is None

    def test_stale_snapshot_does_not_write_onto_a_newer_row(self, monkeypatch):
        """Mirror case: an old cached snapshot (not refetched recently) must not be written
        onto today's row either -- staleness cuts both directions."""
        con = _make_db()
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES ('TCS', '2026-07-30')")
        con.execute(
            "INSERT INTO extra_endpoint_responses VALUES ('TCS', 'marketservices_shareholding', ?, '2026-05-01 09:00:00')",
            (FII_RESPONSE,),
        )
        con.commit()
        monkeypatch.setattr(efp, "connect", lambda: con)

        updated = efp.run("2026-07-30")
        assert updated == 0

    def test_no_cached_response_is_skipped_not_crashed(self, monkeypatch):
        con = _make_db()
        con.execute("INSERT INTO technical_signals (symbol, date) VALUES ('TCS', '2026-07-30')")
        con.commit()
        monkeypatch.setattr(efp, "connect", lambda: con)

        updated = efp.run("2026-07-30")
        assert updated == 0
