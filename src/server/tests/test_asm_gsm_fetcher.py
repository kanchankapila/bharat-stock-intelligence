import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import asm_gsm_fetcher as agf


class TestParseStage:
    def test_roman_numeral_stages(self):
        assert agf._parse_stage("Graded Surveillance Measure - Stage IV") == 4
        assert agf._parse_stage("GSM stage II and price band tightened") == 2
        assert agf._parse_stage("Stage VI") == 6

    def test_digit_stage(self):
        assert agf._parse_stage("Stage 3") == 3

    def test_no_stage_present_returns_zero(self):
        assert agf._parse_stage("Shortlisted under Graded Surveillance Measure") == 0

    def test_none_or_empty_returns_zero(self):
        assert agf._parse_stage(None) == 0
        assert agf._parse_stage("") == 0

    def test_unrecognized_roman_token_returns_zero(self):
        assert agf._parse_stage("Stage IIII") == 0


class _FakeCursor:
    def __init__(self, floor_row=None):
        self.executed = []
        self.rowcount = 1
        self._floor_row = floor_row if floor_row is not None else {"d": "2026-07-29"}

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        return self._floor_row


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True

    def rollback(self):
        pass

    def close(self):
        pass


class TestUpsertFlagsFailureIsolation:
    """Regression test for the 2026-07-04 fix: upsert_flags() used to unconditionally
    reset is_asm/gsm_stage to 0 for every stock before reapplying, making a fetch
    *failure* (empty result) indistinguishable from a fetch *success with zero flagged
    stocks* -- an NSE outage would silently wipe real surveillance flags platform-wide.
    Now fetch_asm_symbols/fetch_gsm_symbols return None on failure (vs set()/{} on a
    real empty result), and upsert_flags refuses to touch existing flags when either
    is None. Proven here by asserting connect() is never even called on that path."""

    def test_asm_none_skips_without_touching_db(self, monkeypatch):
        def _boom():
            raise AssertionError("connect() must not be called when asm_symbols is None")
        monkeypatch.setattr(agf, "connect", _boom)
        assert agf.upsert_flags(None, {"TCS": 2}) == 0

    def test_gsm_none_skips_without_touching_db(self, monkeypatch):
        def _boom():
            raise AssertionError("connect() must not be called when gsm_map is None")
        monkeypatch.setattr(agf, "connect", _boom)
        assert agf.upsert_flags({"TCS"}, None) == 0

    def test_both_none_skips_without_touching_db(self, monkeypatch):
        def _boom():
            raise AssertionError("connect() must not be called when both are None")
        monkeypatch.setattr(agf, "connect", _boom)
        assert agf.upsert_flags(None, None) == 0

    def test_empty_but_not_none_collections_still_proceed_to_write(self, monkeypatch):
        # The crux of the bug: a real "zero stocks flagged today" result (empty set/dict,
        # NOT None) must still reach the reset+write path -- only None means "fetch failed".
        fake_conn = _FakeConn()
        monkeypatch.setattr(agf, "connect", lambda: fake_conn)
        agf.upsert_flags(set(), {})
        assert any("SET is_asm = 0, gsm_stage = 0" in sql for sql, _ in fake_conn.cur.executed)
        assert fake_conn.committed is True


class TestBackfillTechnicalSignalsPlaceholders:
    """Regression test for the 2026-07-23 fix: the Postgres branch of
    backfill_technical_signals() used raw psycopg2-style '%s' placeholders passed
    through db_compat's SQLAlchemy text()+sql_translate pipeline, which expects '?'
    (SQLite-style, converted per-dialect by sql_translate.translate()). The literal
    '%s' bypassed translation and psycopg2 raised
    `SyntaxError: syntax error at or near "%"` on every single run -- this job never
    succeeded against Postgres until the placeholder was fixed to match the sqlite
    branch. Caught live in production logs, not by any prior test -- no test
    previously exercised this function's SQL at all."""

    def test_postgres_branch_uses_question_mark_placeholders(self, monkeypatch):
        monkeypatch.setattr(agf, "use_postgres", lambda: True)
        fake_conn = _FakeConn()
        agf.backfill_technical_signals(fake_conn)
        update_calls = [(sql, params) for sql, params in fake_conn.cur.executed if "UPDATE technical_signals" in sql and "asm_flag" in sql]
        assert len(update_calls) == 1, "expected exactly one UPDATE technical_signals statement"
        sql, params = update_calls[0]
        assert "%s" not in sql, "raw '%s' breaks db_compat's translate()/psycopg2 pipeline -- use '?'"
        assert sql.count("?") == 1
        assert len(params) == 1


class TestBackfillTechnicalSignalsScoped:
    """Regression test for Finding #82 (2026-07-28 full-stack audit, live-confirmed
    2026-07-30 as actively corrupting production): the old UPDATE had NO WHERE clause
    restricting which technical_signals rows it touched -- the join predicate was
    symbol-only, so a CASE WHEN date >= today() ELSE NULL guard with zero matching
    rows (e.g. run on a trading holiday) nulled asm_flag/gsm_stage for every symbol's
    ENTIRE history in one run. Live DB showed 47,234 total rows vs only 2,486 non-null
    asm_flag (5.3%) -- confirmed active data loss, not a latent risk. The fix anchors
    to the last completed trading session (MAX(date) FROM stock_ohlcv, not
    date.today()) and adds an explicit `date >= floor` WHERE clause so the UPDATE can
    only ever touch the current session's row set -- it must be structurally
    impossible for a mismatched anchor to null the rest of the table."""

    def test_postgres_branch_scopes_update_to_current_session_only(self, monkeypatch):
        monkeypatch.setattr(agf, "use_postgres", lambda: True)
        fake_conn = _FakeConn()
        fake_conn.cur._floor_row = {"d": "2026-07-29"}
        agf.backfill_technical_signals(fake_conn)
        update_calls = [(sql, params) for sql, params in fake_conn.cur.executed if "UPDATE technical_signals" in sql]
        assert len(update_calls) == 1
        sql, params = update_calls[0]
        assert "WHERE" in sql and "technical_signals.date >= ?" in sql, \
            "UPDATE must be scoped by a WHERE date >= floor clause, or it can touch the whole table again"
        assert "ELSE NULL" not in sql, "the old CASE...ELSE NULL construct is exactly what nulled unrelated rows"
        assert params == ("2026-07-29",), "must anchor to MAX(date) FROM stock_ohlcv, not date.today()"

    def test_sqlite_branch_scopes_update_to_current_session_only(self, monkeypatch):
        monkeypatch.setattr(agf, "use_postgres", lambda: False)
        fake_conn = _FakeConn()
        fake_conn.cur._floor_row = {"d": "2026-07-29"}
        agf.backfill_technical_signals(fake_conn)
        update_calls = [(sql, params) for sql, params in fake_conn.cur.executed if "UPDATE technical_signals" in sql]
        assert len(update_calls) == 1
        sql, params = update_calls[0]
        assert "WHERE date >= ?" in sql
        assert "ELSE NULL" not in sql
        assert params == ("2026-07-29",)

    def test_falls_back_to_today_when_stock_ohlcv_has_no_rows(self, monkeypatch):
        """An empty stock_ohlcv (fresh DB / test fixture) must not crash the backfill --
        fall back to date.today() rather than propagating a None floor into the UPDATE."""
        monkeypatch.setattr(agf, "use_postgres", lambda: True)
        fake_conn = _FakeConn()
        fake_conn.cur._floor_row = None
        agf.backfill_technical_signals(fake_conn)
        update_calls = [(sql, params) for sql, params in fake_conn.cur.executed if "UPDATE technical_signals" in sql]
        sql, params = update_calls[0]
        assert params[0] == agf.date.today().isoformat()
