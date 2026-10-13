"""Regression tests for the live Trendlyne provider-id map refresh."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import sync_tl_index_map as subject


class _Response:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "body": {
                "tableData": [
                    {
                        "stock_column": {
                            "stock_id": 1887,
                            "NSEcode": "NIFTY",
                            "stockName": "Nifty 50",
                        }
                    }
                ]
            }
        }


def test_fetch_all_uses_only_the_live_global_index_endpoint(monkeypatch):
    """The retired sector-analysis URL must not fail the required index-id refresh.

    Stock sector/industry classification is maintained independently in nse_stocks by
    MoneyControl/Yahoo. The old trendlyne_sector/trendlyne_industry ids have no reader.
    """
    requested = []

    def fake_get(url, **_kwargs):
        requested.append(url)
        return _Response()

    monkeypatch.setattr(subject.requests, "get", fake_get)

    assert subject.fetch_all() == {
        "trendlyne": [("NIFTY50", "trendlyne", "1887")]
    }
    assert requested == [subject.GLOBAL_URL]
