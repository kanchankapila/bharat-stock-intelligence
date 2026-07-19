import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import insider_transactions_fetcher as itf


class TestParseDate:
    """Regression test for the fix: NSE dates sometimes carry a time or sequence
    suffix ('13-Feb-2026 16:56', '13-Feb-2026 1') that previously failed to parse."""

    def test_strips_time_suffix(self):
        assert itf._parse_date("13-Feb-2026 16:56") == "2026-02-13"

    def test_strips_sequence_suffix(self):
        assert itf._parse_date("13-Feb-2026 1") == "2026-02-13"

    def test_iso_format(self):
        assert itf._parse_date("2026-02-13") == "2026-02-13"

    def test_slash_format(self):
        assert itf._parse_date("13/02/2026") == "2026-02-13"

    def test_dash_numeric_format(self):
        assert itf._parse_date("13-02-2026") == "2026-02-13"

    def test_empty_or_none_returns_none(self):
        assert itf._parse_date("") is None
        assert itf._parse_date(None) is None

    def test_unparseable_returns_none(self):
        assert itf._parse_date("not-a-date") is None


def _base_row(**overrides):
    row = {
        "personName": "", "acqName": "John Doe", "personCategory": "Promoter",
        "acqMode": "Market Purchase", "secAcq": "1000", "secVal": "500000",
        "totSharesNo": "1000000", "befAcqSharesNo": "10000", "afterAcqSharesNo": "11000",
        "date": "13-Feb-2026",
    }
    row.update(overrides)
    return row


class TestParseRecordAcqNameFallback:
    """Regression test for the fix: NSE's corporates-pit response uses 'acqName' for
    some record shapes instead of 'personName' -- without the fallback, those rows
    were stored with a blank/None person_name."""

    def test_falls_back_to_acq_name_when_person_name_blank(self):
        rec = itf._parse_record("RELIANCE", _base_row())
        assert rec["person_name"] == "John Doe"

    def test_prefers_person_name_when_present(self):
        rec = itf._parse_record("RELIANCE", _base_row(personName="Jane Roe"))
        assert rec["person_name"] == "Jane Roe"

    def test_value_converted_to_crores(self):
        rec = itf._parse_record("RELIANCE", _base_row(secVal="10000000"))
        assert rec["value_cr"] == 1.0

    def test_before_after_pct_computed_from_total_shares(self):
        rec = itf._parse_record("RELIANCE", _base_row())
        assert rec["before_pct"] == 1.0
        assert rec["after_pct"] == 1.1

    def test_row_with_unparseable_date_is_dropped(self):
        rec = itf._parse_record("RELIANCE", _base_row(date="garbage"))
        assert rec is None

    def test_malformed_numeric_fields_degrade_to_none_not_raise(self):
        rec = itf._parse_record("RELIANCE", _base_row(secVal="NA", totSharesNo="NA"))
        assert rec is not None
        assert rec["value_cr"] is None
