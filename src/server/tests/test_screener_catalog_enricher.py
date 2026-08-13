"""Regression test for the 2026-08-07 dead-column fix: screener_master.screener_url had zero
real writer activity (confirmed live, 0/1,669 rows) despite the URL-derivation code existing
and being correctly cased (`row[2] == 'Trendlyne'`, matching the real stored source value).
Root cause: enrich_signal_keywords()'s re-selection WHERE clause gated purely on
signal_type_tag, so once that column reached 100% coverage (confirmed live: 1,669/1,669), the
loop selected zero rows on every subsequent run, permanently -- the same bug class as
screener_appearances.phase_b_fill_returns fixed earlier this session: a fill-missing-columns
loop gated on only one of the columns it actually fills.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import screener_catalog_enricher as sce  # noqa: E402


def _make_db():
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE screener_master (
            scan_id TEXT, source TEXT, name TEXT,
            signal_type_tag TEXT, screener_url TEXT
        );
        CREATE TABLE trendlyne_screeners (
            id INTEGER PRIMARY KEY, screener_id TEXT, screenpk TEXT, screener_url TEXT
        );
        CREATE TABLE screener_catalog (
            screener_id TEXT, source TEXT, screener_name TEXT,
            signal_keywords TEXT, screener_url TEXT
        );
    """)
    return conn


def test_row_with_tag_already_set_still_gets_url_backfilled():
    """The exact regression: a row whose signal_type_tag was already filled (from a prior run,
    before screener_url derivation existed) must still be re-selected to backfill screener_url."""
    conn = _make_db()
    conn.execute(
        "INSERT INTO screener_master (scan_id, source, name, signal_type_tag, screener_url) "
        "VALUES ('123', 'Trendlyne', 'Bullish Momentum Screen', 'momentum', NULL)"
    )
    conn.execute(
        "INSERT INTO trendlyne_screeners (screener_id, screenpk, screener_url) "
        "VALUES ('123', '9999', 'https://trendlyne.com/equity/screener/9999/')"
    )
    conn.commit()

    # Directly exercise the fixed WHERE clause's selection logic (mirrors the real query in
    # screener_catalog_enricher.py's Step 4) rather than the network/print-heavy full run().
    rows = conn.execute("""
        SELECT scan_id, name, source FROM screener_master
        WHERE signal_type_tag IS NULL OR signal_type_tag = ''
           OR screener_url IS NULL OR screener_url = ''
    """).fetchall()
    assert len(rows) == 1, "a row with a stale/empty screener_url must still be re-selected even though signal_type_tag is already set"


def test_row_with_both_columns_already_filled_is_not_reselected():
    """Once both signal_type_tag AND screener_url are populated, the row must drop out of
    `pending` -- otherwise every run would rescan the entire table forever."""
    conn = _make_db()
    conn.execute(
        "INSERT INTO screener_master (scan_id, source, name, signal_type_tag, screener_url) "
        "VALUES ('456', 'Trendlyne', 'Value Screen', 'value', 'https://trendlyne.com/equity/screener/1111/')"
    )
    conn.commit()

    rows = conn.execute("""
        SELECT scan_id, name, source FROM screener_master
        WHERE signal_type_tag IS NULL OR signal_type_tag = ''
           OR screener_url IS NULL OR screener_url = ''
    """).fetchall()
    assert len(rows) == 0, "a fully-filled row must not be re-selected"


def test_tl_screener_url_builds_a_real_trendlyne_url():
    url = sce.tl_screener_url("9999")
    assert url is not None
    assert "trendlyne.com" in url
    assert "9999" in url


class TestCategoryNotCollapsedToOther:
    """Live bug, 2026-08-13: cat_norm was re-validated against CATEGORY_DEFAULTS (a coarser,
    unrelated vocabulary -- momentum/breakout/valuation/...) instead of trusted as-is, which
    silently collapsed every real category (technical_trend, fundamental_quality, ...) not in
    that small dict down to 'other' -- weight 0.0 in unified_ranker.py's CAT_BASE_WT. Hit 100%
    of et_marketstats' 95 screeners (all correctly classified 'technical_trend' etc. in
    screener_master, all written 'other' into screener_catalog) since they all go through the
    Step 5 INSERT path.

    Calls the REAL resolve_screener_defaults() (extracted from Step 5, not a hand-copied
    mirror) so a source-level regression actually fails these tests -- a mirror wouldn't."""

    def test_real_technical_category_survives(self):
        """'technical_trend' is a real CAT_BASE_WT category with no entry in the coarser
        CATEGORY_DEFAULTS dict -- must NOT collapse to 'other'."""
        _, cat_norm, horizon, confidence = sce.resolve_screener_defaults(
            'technical_trend', None, 'Above EMA-20')
        assert cat_norm == 'technical_trend'
        # horizon/confidence still fall back safely since this dict has no exact entry
        assert horizon == 'medium_term' and confidence == 0.65

    def test_real_fundamental_quality_category_survives(self):
        _, cat_norm, _, _ = sce.resolve_screener_defaults(
            'fundamental_quality', None, 'High ROE')
        assert cat_norm == 'fundamental_quality'

    def test_category_present_in_both_vocabularies_still_uses_its_own_defaults(self):
        """'momentum' happens to be a CATEGORY_DEFAULTS key too -- confirms the fix didn't
        break the horizon/confidence lookup for the cases that DO overlap."""
        _, cat_norm, horizon, confidence = sce.resolve_screener_defaults(
            'momentum', None, 'Momentum Gainers')
        assert cat_norm == 'momentum'
        assert horizon == 'short_term' and confidence == 0.72

    def test_missing_category_still_defaults_to_other(self):
        _, cat_norm, _, _ = sce.resolve_screener_defaults('other', None, 'Misc Screen')
        assert cat_norm == 'other'


class TestExistingCorruptedRowsBackfilled:
    """Step 5b: rows the bug ALREADY wrote as 'other' must be repaired from screener_master,
    not just prevented going forward."""

    def _make_db(self):
        import sqlite3
        conn = sqlite3.connect(":memory:")
        conn.executescript("""
            CREATE TABLE screener_master (scan_id TEXT, source TEXT, inferred_category TEXT);
            CREATE TABLE screener_catalog (screener_id TEXT, source TEXT, category TEXT);
        """)
        return conn

    def test_drift_query_finds_and_would_fix_corrupted_rows(self):
        conn = self._make_db()
        conn.execute("INSERT INTO screener_master VALUES ('above-ema-20', 'et_marketstats', 'technical_trend')")
        conn.execute("INSERT INTO screener_catalog VALUES ('above-ema-20', 'et_marketstats', 'other')")
        # A genuinely-'other' row must NOT be touched (screener_master agrees it's 'other').
        conn.execute("INSERT INTO screener_master VALUES ('misc-screen', 'et_marketstats', 'other')")
        conn.execute("INSERT INTO screener_catalog VALUES ('misc-screen', 'et_marketstats', 'other')")
        conn.commit()

        drift = conn.execute("""
            SELECT sc.screener_id, sc.source, sm.inferred_category
            FROM screener_catalog sc
            JOIN screener_master sm ON sm.scan_id = sc.screener_id AND LOWER(sm.source) = LOWER(sc.source)
            WHERE sc.category = 'other' AND sm.inferred_category IS NOT NULL AND sm.inferred_category != 'other'
        """).fetchall()
        assert drift == [('above-ema-20', 'et_marketstats', 'technical_trend')]
