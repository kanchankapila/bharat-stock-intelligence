import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts"))

import enrich_stocklist_tickertape as enrich
import tickertape_client as tc


class TestJoinByIsin:
    def test_matches_stocklist_entries_by_isin(self):
        stocklist = [
            {"symbol": "BEL", "isin": "INE263A01024", "name": "Bharat Electronics"},
            {"symbol": "AUBANK", "isin": "INE949L01017", "name": "AU Small Finance Bank"},
        ]
        tickertape_list = [
            {"sid": "BHE", "isin": "INE263A01024", "ticker": "BEL"},
            {"sid": "AUBANK", "isin": "INE949L01017", "ticker": "AUBANK"},
            {"sid": "UNRELATED", "isin": "INE000X00000", "ticker": "XYZ"},
        ]
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert result[0]["tickertape_sid"] == "BHE"
        assert result[1]["tickertape_sid"] == "AUBANK"

    def test_leaves_tickertape_sid_absent_when_no_isin_match(self):
        stocklist = [{"symbol": "NOMATCH", "isin": "INE999Z99999", "name": "No Match Ltd"}]
        tickertape_list = [{"sid": "OTHER", "isin": "INE111A11111", "ticker": "OTHER"}]
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert "tickertape_sid" not in result[0]

    def test_handles_missing_isin_on_either_side_gracefully(self):
        stocklist = [{"symbol": "NOISIN", "name": "No ISIN Ltd"}]
        tickertape_list = [{"sid": "X", "ticker": "X"}]  # no isin key
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert "tickertape_sid" not in result[0]

    def test_does_not_mutate_other_fields(self):
        stocklist = [{"symbol": "BEL", "isin": "INE263A01024", "companyid": "11945", "tlid": "175"}]
        tickertape_list = [{"sid": "BHE", "isin": "INE263A01024"}]
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert result[0]["companyid"] == "11945"
        assert result[0]["tlid"] == "175"


class TestTickertapeClient:
    def test_load_tickertape_sid_map_reads_symbol_and_sid(self, tmp_path, monkeypatch):
        fixture = tmp_path / "stocklist.json"
        fixture.write_text(json.dumps([
            {"symbol": "bel", "tickertape_sid": "BHE"},
            {"symbol": "NOMATCH"},  # no tickertape_sid at all
            {"symbol": "EMPTY", "tickertape_sid": ""},  # empty string, must be excluded
        ]), encoding="utf-8")
        monkeypatch.setattr(tc, "_STOCKLIST_PATH", fixture)
        monkeypatch.setattr(tc, "_symbol_to_sid", None)

        mapping = tc.load_tickertape_sid_map()

        assert mapping["BEL"] == "BHE"
        assert "NOMATCH" not in mapping
        assert "EMPTY" not in mapping

    def test_fetch_scorecard_returns_data_list_on_success(self):
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.json.return_value = {"success": True, "data": [{"name": "Performance", "tag": "Low"}]}
        fake_session = MagicMock()
        fake_session.get.return_value = fake_response

        result = tc.fetch_scorecard("BHE", fake_session)

        assert result == [{"name": "Performance", "tag": "Low"}]

    def test_fetch_scorecard_returns_none_on_empty_data(self):
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.json.return_value = {"success": True, "data": []}
        fake_session = MagicMock()
        fake_session.get.return_value = fake_response

        assert tc.fetch_scorecard("BHE", fake_session) is None

    def test_fetch_scorecard_returns_none_on_non_200(self):
        fake_response = MagicMock()
        fake_response.status_code = 404
        fake_session = MagicMock()
        fake_session.get.return_value = fake_response

        assert tc.fetch_scorecard("BHE", fake_session) is None
