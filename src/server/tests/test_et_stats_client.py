import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import et_stats_client as esc


def test_load_companyid_map_reads_symbol_and_companyid(tmp_path, monkeypatch):
    fixture = tmp_path / "stocklist.json"
    fixture.write_text(json.dumps([
        {"symbol": "infy", "companyid": "9195", "name": "Infosys"},
        {"symbol": "TCS", "companyid": "", "name": "TCS"},  # empty companyid skipped
        {"symbol": "BEL", "companyid": "11945", "name": "Bharat Electronics"},
    ]), encoding="utf-8")

    monkeypatch.setattr(esc, "_STOCKLIST_PATH", fixture)
    monkeypatch.setattr(esc, "_symbol_to_companyid", None)

    mapping = esc.load_companyid_map()

    assert mapping["INFY"] == "9195"
    assert mapping["BEL"] == "11945"
    assert "TCS" not in mapping


def test_load_companyid_map_is_cached_after_first_call(tmp_path, monkeypatch):
    fixture = tmp_path / "stocklist.json"
    fixture.write_text(json.dumps([{"symbol": "BEL", "companyid": "11945"}]), encoding="utf-8")
    monkeypatch.setattr(esc, "_STOCKLIST_PATH", fixture)
    monkeypatch.setattr(esc, "_symbol_to_companyid", None)

    first = esc.load_companyid_map()
    fixture.write_text(json.dumps([{"symbol": "OTHER", "companyid": "1"}]), encoding="utf-8")
    second = esc.load_companyid_map()

    assert first is second  # cached, second call did not re-read the (changed) file


def test_fetch_et_stats_returns_list_for_known_events():
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "resultBalanceSheet": {"list": [{"inventories": 100.0}]}
    }
    fake_session = MagicMock()
    fake_session.get.return_value = fake_response

    result = esc.fetch_et_stats("11945", "Balance", fake_session)

    assert result == [{"inventories": 100.0}]
    fake_session.get.assert_called_once()
    call_kwargs = fake_session.get.call_args
    assert call_kwargs.kwargs["params"]["companyId"] == "11945"
    assert call_kwargs.kwargs["params"]["events"] == "Balance"


def test_fetch_et_stats_returns_none_on_empty_list():
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {"resultCashFlowStatement": {"list": []}}
    fake_session = MagicMock()
    fake_session.get.return_value = fake_response

    result = esc.fetch_et_stats("11945", "CashFlow", fake_session)

    assert result is None


def test_fetch_et_stats_returns_none_on_non_200():
    fake_response = MagicMock()
    fake_response.status_code = 500
    fake_session = MagicMock()
    fake_session.get.return_value = fake_response

    result = esc.fetch_et_stats("11945", "Ratio", fake_session)

    assert result is None
