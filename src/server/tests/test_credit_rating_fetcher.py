import os
import sys

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
