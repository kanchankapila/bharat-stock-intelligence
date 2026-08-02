"""
Regression test for analyst_revision.py's write-target date (2026-08-01).

write_revisions()'s `UPDATE ... WHERE symbol = ? AND date = ?` already had a `date = ? guard
(2026-07-19) instead of MAX(date)` comment, but anchored it to a raw datetime.date.today() --
which silently writes into a calendar day with no technical_signals grid row whenever
ml-daily-ops's step chain crosses midnight IST (confirmed happening live via job_heartbeat).
Must use as_of.logical_trading_date() instead (same fix as insider_features.py/
bse_event_classifier.py).
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import analyst_revision as ar


def _revisions_df():
    return pd.DataFrame([{
        "symbol": "INFY",
        "eps_revision_3m_pct": 5.0,
        "target_revision_3m_pct": 2.0,
        "analyst_count_chg": 1,
    }])


class TestWriteRevisionsUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date_not_raw_today(self, monkeypatch):
        monkeypatch.setattr(ar, "logical_trading_date", lambda: "2026-07-31")
        captured = {}

        def _fake_executemany(sql, params):
            captured["sql"] = sql
            captured["params"] = params
            return len(params)

        monkeypatch.setattr(ar, "executemany", _fake_executemany)

        n, skipped = ar.write_revisions(_revisions_df())

        assert n == 1
        assert skipped == 0
        assert captured["params"], "expected at least one row written"
        row = captured["params"][0]
        assert row[3] == "INFY"
        assert row[4] == "2026-07-31", (
            "write_revisions() must write against logical_trading_date()'s value, "
            "not date.today()"
        )

    def test_wrong_calendar_date_would_match_nothing_silently(self, monkeypatch):
        """Negative control: documents the original failure mode without the fix."""
        monkeypatch.setattr(ar, "logical_trading_date", lambda: "2026-08-01")
        captured = {}
        monkeypatch.setattr(ar, "executemany",
                             lambda sql, params: captured.setdefault("params", params) and len(params))

        ar.write_revisions(_revisions_df())

        assert captured["params"][0][4] == "2026-08-01"  # would NOT match a 2026-07-31 grid row

    def test_empty_input_short_circuits_before_computing_date(self, monkeypatch):
        """No rows -> no need to call logical_trading_date() at all."""
        called = []
        monkeypatch.setattr(ar, "logical_trading_date", lambda: called.append(1) or "2026-07-31")
        n, skipped = ar.write_revisions(pd.DataFrame())
        assert (n, skipped) == (0, 0)
        assert called == []
