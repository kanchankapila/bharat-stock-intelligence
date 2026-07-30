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
            ext_mojo_financial_pts REAL,
            ext_is_overall_score REAL, ext_is_percentile_rank REAL,
            ext_tt_score REAL
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


class TestSentinelScoreFiltering:
    """Trading80/MarketsMojo's dot_summary uses -99997 (and similar large-magnitude values) as a
    "no score computed" sentinel -- live-verified 2026-07-30 across a 15-stock sample (LPDC,
    MAHAPEXLTD, ZIMLAB, VIDHIING all returned q_rank=-99997 while genuinely-scored stocks ranged
    2-66). Must be filtered to None, not fed to ml_ensemble.py as a real (extremely bearish) score."""

    T80_SENTINEL_RESPONSE = (
        '{"data": {"dot_summary": {"tech_score": -1.28, "q_rank": -99997, '
        '"v_rank": -2, "f_pts": -99997}}}'
    )
    T80_REAL_RESPONSE = (
        '{"data": {"dot_summary": {"tech_score": -1.28, "q_rank": 46, "v_rank": -2, "f_pts": -22}}}'
    )

    def test_sentinel_value_is_filtered_to_none(self):
        feat = efp.extract_features("LPDC", [("trading80_header_info", self.T80_SENTINEL_RESPONSE)])
        assert feat["ext_t80_quality_rank"] is None
        assert feat["ext_t80_financial_pts"] is None
        # v_rank=-2 is a real (non-sentinel) negative value and must pass through
        assert feat["ext_t80_valuation_rank"] == -2.0
        assert feat["ext_t80_tech_score"] == -1.28

    def test_real_negative_and_large_values_pass_through(self):
        feat = efp.extract_features("RELIANCE", [("trading80_header_info", self.T80_REAL_RESPONSE)])
        assert feat["ext_t80_quality_rank"] == 46.0
        assert feat["ext_t80_financial_pts"] == -22.0
        assert feat["ext_t80_valuation_rank"] == -2.0

    def test_empty_string_score_does_not_crash(self):
        response = '{"data": {"dot_summary": {"tech_score": "", "q_rank": "", "v_rank": "", "f_pts": ""}}}'
        feat = efp.extract_features("XYZ", [("trading80_header_info", response)])
        assert feat["ext_t80_tech_score"] is None
        assert feat["ext_t80_quality_rank"] is None


class TestNonDictNestedShapeDoesNotCrash:
    """Live-confirmed 2026-07-30: trading80_header_info's "data" key is sometimes an empty
    LIST (`[]`) instead of a dict for stocks with no computed score (ELGIRUBCO/MUTHOOTFIN/
    ADANIGREEN observed live) -- crashed the whole full-universe parse run with
    AttributeError: 'list' object has no attribute 'get' on the very first such stock
    encountered, silently failing the parser for every symbol after it in the same run."""

    def test_trading80_list_shaped_data_is_skipped_not_crashed(self):
        response = '{"code": "200", "data": []}'
        feat = efp.extract_features("ELGIRUBCO", [("trading80_header_info", response)])
        assert feat["ext_t80_tech_score"] is None
        assert feat["ext_t80_quality_rank"] is None

    def test_marketsmojo_list_shaped_dot_summary_is_skipped_not_crashed(self):
        response = '{"code": "200", "data": {"dot_summary": []}}'
        feat = efp.extract_features("XYZ", [("marketsmojo_header_info", response)])
        assert feat["ext_mojo_quality_rank"] is None

    def test_top_level_list_response_is_skipped_not_crashed(self):
        """Defensive: if any endpoint ever returns a top-level JSON array instead of an
        object, extract_features must not crash trying to call .get() on it."""
        feat = efp.extract_features("XYZ", [("marketservices_shareholding", "[1, 2, 3]")])
        assert feat["ext_fii_holding_pct"] is None


class TestInvestSightsAndTapetideScores:
    """Promoted 2026-07-30 from updated_urls.json -- two independently-computed composite
    scores (distinct methodology/pillars from each other and from the Trading80/MarketsMojo
    pair), live-verified against real RELIANCE responses before being wired in."""

    def test_investsights_score_extracts_headline_fields(self):
        response = '{"overall_score": 66.19, "percentile_rank": 73.72, "factors": {"value": {"score": 87.52}}}'
        feat = efp.extract_features("RELIANCE", [("investsights_score", response)])
        assert feat["ext_is_overall_score"] == 66.19
        assert feat["ext_is_percentile_rank"] == 73.72

    def test_tapetide_score_extracts_nested_score(self):
        response = '{"data": {"score": 44, "pillars": {"quality": 53.39}}, "meta": {"symbol": "RELIANCE"}}'
        feat = efp.extract_features("RELIANCE", [("tapetide_score", response)])
        assert feat["ext_tt_score"] == 44.0

    def test_missing_score_fields_do_not_crash(self):
        feat = efp.extract_features("XYZ", [("investsights_score", "{}"), ("tapetide_score", '{"data": {}}')])
        assert feat["ext_is_overall_score"] is None
        assert feat["ext_is_percentile_rank"] is None
        assert feat["ext_tt_score"] is None
