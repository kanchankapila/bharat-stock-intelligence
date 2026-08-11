"""Live-datasource tests for the two untested per-stock fundamentals fetchers.

`tickertape_scorecard_fetcher.py` (Tickertape scorecard -> proprietary_scores_history) and
`working_capital_fetcher.py` (ET_Stats Balance+Quarterly -> working_capital_history + four
technical_signals columns) were both flagged by scripts/check_recurring_bugs.py on its
first-ever run (2026-08-11).

Both resolve their provider id through the fetcher's own map (load_tickertape_sid_map /
load_companyid_map) rather than a hardcoded id, per CLAUDE.md's rule — a hardcoded id can go
stale silently and the test would keep passing against a dead mapping. Those maps read the
live DB, so these skip (not fail) when no DB is reachable.

working_capital_fetcher is also the fetcher whose as_of_floor() call was fixed in the
2026-07-30 fifth-pass audit to stop degrading to a bare date.today() on an unparseable
year_ending — see .claude/rules/recurring-bugs.md, "date.today() as a write-guard anchor".

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


@pytest.fixture
def mem_db():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    yield con
    con.close()


def _resolve(loader, label):
    """Resolve REAL_SYMBOL through the fetcher's own map; skip if the DB isn't reachable."""
    try:
        mapping = loader()
    except Exception as e:
        pytest.skip(f"{label} unavailable (no DB reachable from this host): {e}")
    if REAL_SYMBOL not in mapping:
        pytest.skip(f"{REAL_SYMBOL} not present in {label}")
    return mapping[REAL_SYMBOL]


@pytest.mark.live_datasource
class TestTickertapeScorecardLiveDataSource:
    def test_real_scorecard_parses_into_ordinal_scores(self):
        import tickertape_scorecard_fetcher as tsf
        from tickertape_client import HEADERS, fetch_scorecard, load_tickertape_sid_map

        sid = _resolve(load_tickertape_sid_map, "tickertape sid map")

        session = requests.Session()
        session.headers.update(HEADERS)
        data = fetch_scorecard(sid, session)
        if not data:
            pytest.skip(f"Tickertape scorecard returned nothing for {REAL_SYMBOL} ({sid})")
        assert_non_empty_response(data, f"fetch_scorecard({sid})")

        scores = tsf.compute_ordinal_scores(data)
        assert scores, (
            "compute_ordinal_scores() extracted nothing from a non-empty response — the API's "
            f"category shape has probably changed. First raw category: {data[0]!r}"
        )
        for name, v in scores.items():
            assert v["score_label"], f"{name} has an empty score_label"
            # score_value is None for a label outside ORDINAL_MAP — legitimate, but every
            # value that IS mapped must be a real ordinal, not a string that slipped through.
            if v["score_value"] is not None:
                assert isinstance(v["score_value"], int), \
                    f"{name} score_value {v['score_value']!r} is not an int ordinal"

    def test_real_scorecard_stores_and_reads_back_ml_usable(self, mem_db):
        import tickertape_scorecard_fetcher as tsf
        from tickertape_client import HEADERS, fetch_scorecard, load_tickertape_sid_map

        sid = _resolve(load_tickertape_sid_map, "tickertape sid map")

        session = requests.Session()
        session.headers.update(HEADERS)
        data = fetch_scorecard(sid, session)
        if not data:
            pytest.skip(f"Tickertape scorecard returned nothing for {REAL_SYMBOL} ({sid})")
        scores = tsf.compute_ordinal_scores(data)
        if not scores:
            pytest.skip("no score-type categories in the current scorecard response")

        # proprietary_scores_history is Python-owned (not mirrored into db.ts), so the test
        # declares its shape — matching the precedent set by the ohlcv_adjustment_factors and
        # superstar_investor_activity tests.
        mem_db.execute("""
            CREATE TABLE proprietary_scores_history (
                symbol TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
                score_type TEXT NOT NULL, score_value INTEGER, score_label TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (symbol, date, source, score_type)
            )
        """)
        written = tsf.upsert_scores(REAL_SYMBOL, "2026-08-11", scores, mem_db)
        assert written == len(scores), f"upsert_scores() wrote {written} of {len(scores)} scores"

        rows = mem_db.execute(
            "SELECT * FROM proprietary_scores_history WHERE symbol = ? AND source = 'tickertape'",
            (REAL_SYMBOL,),
        ).fetchall()
        assert rows, "nothing readable back from proprietary_scores_history"
        for r in rows:
            assert dict(r)["symbol"] == REAL_SYMBOL
            assert dict(r)["score_label"], "stored an empty score_label"

    def test_upsert_is_idempotent(self, mem_db):
        """The daily job re-runs over the same (symbol, date); a second run must update in
        place, not duplicate. The ON CONFLICT target is the only thing preventing that."""
        import tickertape_scorecard_fetcher as tsf

        mem_db.execute("""
            CREATE TABLE proprietary_scores_history (
                symbol TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL,
                score_type TEXT NOT NULL, score_value INTEGER, score_label TEXT,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (symbol, date, source, score_type)
            )
        """)
        scores = {"performance": {"score_value": 3, "score_label": "Good"}}
        tsf.upsert_scores(REAL_SYMBOL, "2026-08-11", scores, mem_db)
        tsf.upsert_scores(REAL_SYMBOL, "2026-08-11", scores, mem_db)
        n = mem_db.execute("SELECT COUNT(*) FROM proprietary_scores_history").fetchone()[0]
        assert n == 1, f"re-running the same day duplicated rows ({n} rows, expected 1)"


@pytest.mark.live_datasource
class TestWorkingCapitalLiveDataSource:
    def _fetch(self):
        from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map

        company_id = _resolve(load_companyid_map, "ET companyid map")
        session = requests.Session()
        session.headers.update(HEADERS)
        # Signature is (company_id, events, session, last) — not session-first like most
        # helpers in this codebase. Getting this wrong raises KeyError on _RESULT_KEY[events]
        # rather than a TypeError, so it fails in a place that looks unrelated to the caller.
        balance = fetch_et_stats(company_id, "Balance", session, last=4)
        quarterly = fetch_et_stats(company_id, "Quarterly", session, last=8)
        return balance, quarterly

    def test_real_et_stats_computes_ml_usable_ccc(self):
        import working_capital_fetcher as wcf

        balance, quarterly = self._fetch()
        if not balance or not quarterly:
            pytest.skip(f"ET_Stats returned no Balance/Quarterly data for {REAL_SYMBOL}")
        assert_non_empty_response(balance, "fetch_et_stats(Balance)")
        assert_non_empty_response(quarterly, "fetch_et_stats(Quarterly)")

        rows = wcf.compute_ccc(balance, quarterly)
        if not rows:
            pytest.skip("no fiscal year had both a balance sheet and 4 matching quarters")

        for r in rows:
            assert r["fiscal_year"], "a computed row carries an empty fiscal_year"
            for col in ("receivables_days", "inventory_days", "payables_days", "ccc"):
                if r.get(col) is not None:
                    assert_numeric_and_finite(r[col], col)
            # CCC is a day count. A units bug (seconds, or a raw currency amount landing in
            # the field) produces a finite float that this bound catches and a null check won't.
            if r.get("ccc") is not None:
                assert -2000 < r["ccc"] < 2000, \
                    f"{REAL_SYMBOL} {r['fiscal_year']} ccc={r['ccc']} is not a plausible day count"

    def test_real_working_capital_stores_and_reads_back_ml_usable(self, mem_db):
        import working_capital_fetcher as wcf

        balance, quarterly = self._fetch()
        if not balance or not quarterly:
            pytest.skip(f"ET_Stats returned no Balance/Quarterly data for {REAL_SYMBOL}")
        rows = wcf.compute_ccc(balance, quarterly)
        if not rows:
            pytest.skip("no fiscal year had both a balance sheet and 4 matching quarters")

        wcf.ensure_schema(mem_db)
        wcf.upsert_wc_history(REAL_SYMBOL, rows, mem_db)

        stored = mem_db.execute(
            "SELECT * FROM working_capital_history WHERE symbol = ?", (REAL_SYMBOL,)
        ).fetchall()
        assert stored, "upsert_wc_history() wrote nothing readable back"
        assert len(stored) == len(rows), \
            f"wrote {len(rows)} fiscal years but read back {len(stored)}"
        for r in stored:
            d = dict(r)
            assert d["symbol"] == REAL_SYMBOL
            if d.get("ccc") is not None:
                assert_numeric_and_finite(d["ccc"], "stored ccc")
