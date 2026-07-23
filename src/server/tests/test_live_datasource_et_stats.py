"""
Second worked example of the live_datasource pattern (see CLAUDE.md "Adding a new data
source"), against a different fetcher family than the Trendlyne screener one — a plain
REST client (et_stats_client.py) shared by financial_ratios_fetcher.py and others.

Lighter-scope than test_live_datasource_trendlyne_screener.py: validates fetch + response
shape + numeric-field usability (steps 1-3 of the pattern in live_datasource_helpers.py),
not a full DB round-trip — financial_ratios_fetcher.py's write path spans ~40 harvested
columns, out of scope for this example. The full fetch-through-storage round trip is
demonstrated in test_live_datasource_trendlyne_screener.py.
"""

import sys
import os
import math

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from et_stats_client import fetch_et_stats, load_companyid_map
from live_datasource_helpers import assert_non_empty_response

REAL_SYMBOL = "AUBANK"


@pytest.mark.live_datasource
class TestEtStatsLiveDataSource:
    def test_real_company_ratio_fetch_returns_ml_usable_data(self):
        companyid_map = load_companyid_map()
        company_id = companyid_map.get(REAL_SYMBOL)
        assert company_id, f"{REAL_SYMBOL} not found in the companyid map — fixture stale?"

        session = requests.Session()
        rows = fetch_et_stats(company_id, "Ratio", session, last=3)
        assert_non_empty_response(rows, f"fetch_et_stats(companyId={company_id}, events=Ratio)")

        latest = rows[0]
        assert isinstance(latest, dict), f"expected a dict per period, got {type(latest).__name__}"

        # At least some fields in a real ratios payload must be usable numeric features —
        # not every field is numeric (some are dates/labels), so we check that numeric-
        # looking values actually parse as finite numbers rather than asserting on a
        # specific field name (which would make this test brittle to ET's own schema).
        numeric_like = 0
        for key, value in latest.items():
            if value is None or isinstance(value, bool):
                continue
            try:
                f = float(value)
            except (TypeError, ValueError):
                continue
            assert not math.isnan(f) and not math.isinf(f), f"{key} parses but is NaN/inf: {value!r}"
            numeric_like += 1
        assert numeric_like > 0, (
            f"no numeric-looking fields found in the Ratio payload for {REAL_SYMBOL} — "
            f"either the response shape changed or nothing here is ML-usable as-is"
        )
