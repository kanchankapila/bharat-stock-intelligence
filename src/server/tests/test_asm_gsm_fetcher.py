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
    def __init__(self):
        self.executed = []
        self.rowcount = 1

    def execute(self, sql, params=None):
        self.executed.append((sql, params))


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
