import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import credit_rating_fetcher as crf


class TestClassifyRatingAction:
    def test_known_actions_case_insensitive(self):
        assert crf.classify_rating_action("Upgrade") == "UPGRADE"
        assert crf.classify_rating_action("downgrade") == "DOWNGRADE"
        assert crf.classify_rating_action("REAFFIRM") == "REAFFIRM"

    def test_unknown_action(self):
        assert crf.classify_rating_action("Watch") == "UNKNOWN"
        assert crf.classify_rating_action(None) == "UNKNOWN"
        assert crf.classify_rating_action("") == "UNKNOWN"


def _row(symbol, isin="INE000A00000", app_id="1"):
    return {
        "AppID": app_id, "DateofCR": "15-06-2026", "RatingAction": "Upgrade",
        "NameOfCRAgency": "CRISIL", "ISIN": isin, "Symbol": symbol,
        "CompanyName": "Test Co", "CreditRating": "AA+",
    }


class TestParseAnnouncementsSentinelBroadening:
    """Regression test for the fix: NSE uses several different sentinel values for
    'no listed equity symbol' (verified live: '', 'NA', 'NOT LISTED', 'NOTLISTED',
    'NOT APPLICABLE') -- a single exact-match check missed most of them, letting
    placeholder text leak into the symbol column instead of resolving via ISIN."""

    def test_all_known_sentinels_fall_back_to_isin_map(self):
        bse_nse_map = {"INE000A00000": {"symbol": "TESTCO", "isin": "INE000A00000"}}
        for sentinel in ("NA", "NOT LISTED", "NOTLISTED", "NOT APPLICABLE", ""):
            events = crf.parse_announcements([_row(sentinel)], bse_nse_map)
            assert len(events) == 1
            assert events[0]["symbol"] == "TESTCO", f"sentinel {sentinel!r} should resolve via ISIN"

    def test_real_symbol_passes_through_unchanged(self):
        events = crf.parse_announcements([_row("RELIANCE")], {})
        assert events[0]["symbol"] == "RELIANCE"

    def test_unresolvable_sentinel_with_no_isin_match_yields_empty_symbol(self):
        events = crf.parse_announcements([_row("NA", isin="UNKNOWNISIN")], {})
        assert events[0]["symbol"] == ""

    def test_unparseable_date_row_is_dropped(self):
        row = _row("RELIANCE")
        row["DateofCR"] = "not-a-date"
        assert crf.parse_announcements([row], {}) == []

    def test_missing_app_id_row_is_dropped(self):
        row = _row("RELIANCE", app_id="")
        assert crf.parse_announcements([row], {}) == []


# ── Regression: update_technical_signals() write-target date (2026-08-01) ────────────────
#
# update_technical_signals()'s `UPDATE ... WHERE symbol = ? AND date = ?` already had a
# date = ? guard (2026-07-19) to avoid overwriting a stale historical row, but anchored it to
# a raw pd.Timestamp.today() -- which silently writes into a calendar day with no
# technical_signals grid row whenever ml-daily-ops's step chain crosses midnight IST. Must use
# as_of.logical_trading_date() instead (same fix as insider_features.py/bse_event_classifier.py).

class TestUpdateTechnicalSignalsUsesLogicalTradingDate:
    def _events_df(self):
        return pd.DataFrame([
            {"symbol": "RELIANCE", "action": "UPGRADE", "announcement_date": "2026-07-20"},
        ])

    def test_write_targets_logical_trading_date_not_raw_today(self, monkeypatch):
        monkeypatch.setattr(crf, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(crf, "read_df", lambda sql: self._events_df())
        captured = {}

        def _fake_executemany(sql, params):
            captured["sql"] = sql
            captured["params"] = params
            return len(params)

        monkeypatch.setattr(crf, "executemany", _fake_executemany)

        n = crf.update_technical_signals(conn=None, lookback_days=180)

        assert n == 1
        assert captured["params"], "expected at least one row written"
        for row in captured["params"]:
            assert row[-1] == "2026-07-31", (
                "update_technical_signals() must write against logical_trading_date()'s "
                "value, not pd.Timestamp.today()"
            )

    def test_wrong_calendar_date_would_match_nothing_silently(self, monkeypatch):
        """Negative control: documents the original failure mode without the fix."""
        monkeypatch.setattr(crf, "logical_trading_date", lambda: "2026-08-01")
        monkeypatch.setattr(crf, "read_df", lambda sql: self._events_df())
        captured = {}
        monkeypatch.setattr(crf, "executemany",
                             lambda sql, params: captured.setdefault("params", params) and len(params))

        crf.update_technical_signals(conn=None, lookback_days=180)

        assert captured["params"][0][-1] == "2026-08-01"  # would NOT match a 2026-07-31 grid row
