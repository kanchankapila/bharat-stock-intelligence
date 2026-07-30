"""Regression tests for Finding #52 (2026-07-28 full-stack audit): so_option_chain_fetcher.py
hardcoded 20+ field-to-index mappings into Trendlyne's positional tableData array, never
validating them against the response's own tableHeaders -- architecturally identical to the
2026-07-23 trendlyne_screener_discovery.py incident that silently corrupted ~2.1M rows for
its entire life before anyone checked a live response's actual shape. Fixed by resolving each
field's index from tableHeaders[i]['unique_name'] at parse time (_build_col_map), and raising
a clear RuntimeError -- not silently mis-parsing -- if a required field can't be found.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import so_option_chain_fetcher as sof


def _header(unique_name, htype="number"):
    return {"type": htype, "unique_name": unique_name}


# The real, live-verified header order for a Trendlyne SmartOptions response (fetched
# against RELIANCE on 2026-07-30) -- indices 0-34, matching what _COL used to hardcode.
REAL_HEADERS = [
    _header("current_price_call"), _header("day_change_call"), _header("traded_contracts_call"),
    _header("traded_contracts_change_call"), _header("ttv_call"), _header("open_interest_call"),
    _header("oi_change_call"), _header("implied_volatility_call"), _header("iv_change_call"),
    _header("delta_calc_call"), _header("gamma_calc_call"), _header("rho_calc_call"),
    _header("theta_calc_call"), _header("vega_calc_call"), _header("get_built_up_str_call"),
    _header("chart_call", "string"), _header("pk_call"), _header("strike_price"),
    _header("current_price_put"), _header("day_change_put"), _header("traded_contracts_put"),
    _header("traded_contracts_change_put"), _header("ttv_put"), _header("open_interest_put"),
    _header("oi_change_put"), _header("implied_volatility_put"), _header("iv_change_put"),
    _header("delta_calc_put"), _header("gamma_calc_put"), _header("rho_calc_put"),
    _header("theta_calc_put"), _header("vega_calc_put"), _header("get_built_up_str_put"),
    _header("chart_put", "string"), _header("pk_put"),
]


class TestBuildColMapAgainstRealHeaderOrder:
    def test_resolves_every_required_field_from_the_real_response_shape(self):
        col = sof._build_col_map(REAL_HEADERS)
        for field in sof._REQUIRED_FIELDS:
            assert field in col
        # spot-check against the exact indices the old hardcoded _COL used
        assert col["strike"] == 17
        assert col["ce_price"] == 0
        assert col["ce_delta"] == 9
        assert col["pe_delta"] == 27
        assert col["pe_buildup"] == 32

    def test_ignores_unmapped_columns_like_chart_links_and_contract_ids(self):
        col = sof._build_col_map(REAL_HEADERS)
        # chart_call/pk_call/chart_put/pk_put aren't in _UNIQUE_NAME_TO_FIELD at all --
        # confirm the map doesn't grow to include entries for them
        assert set(col.keys()).issubset(sof._UNIQUE_NAME_TO_FIELD.values())
        assert sof._REQUIRED_FIELDS.issubset(col.keys())


class TestColumnReorderIsDetected:
    def test_swapped_delta_and_gamma_still_resolves_correctly(self):
        """The whole point of reading tableHeaders: if Trendlyne swaps two columns, the
        dynamically-resolved indices must follow the swap, not silently keep reading the
        old (now-wrong) positions."""
        reordered = list(REAL_HEADERS)
        reordered[9], reordered[10] = reordered[10], reordered[9]  # swap delta_calc_call <-> gamma_calc_call
        col = sof._build_col_map(reordered)
        assert col["ce_delta"] == 10   # now at gamma's old position
        assert col["ce_gamma"] == 9    # now at delta's old position

    def test_missing_required_field_raises_not_silently_mis_maps(self):
        truncated = [h for h in REAL_HEADERS if h["unique_name"] != "delta_calc_call"]
        with pytest.raises(RuntimeError, match="ce_delta"):
            sof._build_col_map(truncated)

    def test_empty_headers_raises(self):
        with pytest.raises(RuntimeError):
            sof._build_col_map([])

    def test_none_headers_raises_not_crashes_with_typeerror(self):
        with pytest.raises(RuntimeError):
            sof._build_col_map(None)


class TestParseChainUsesRealHeaders:
    def test_parse_chain_succeeds_against_the_real_header_shape(self):
        body = {
            "tableHeaders": REAL_HEADERS,
            "tableData": [
                # 35 columns matching REAL_HEADERS order; only fields _parse_chain reads matter
                [100.0, 1.0, 500, 2.0, 50000, 1000, 5.0, 20.0, 1.0, 0.5, 0.02, 0.01, -0.05, 0.1, "Long Buildup", "link", 1,
                 2500,  # strike_price
                 90.0, -1.0, 400, -1.0, 36000, 800, -3.0, 22.0, 0.5, -0.4, 0.015, 0.005, -0.04, 0.09, "Short Buildup", "link", 2],
            ],
            "IV": {}, "expiryLevelPCRValues": {}, "futureData": {},
            "maxPain": None, "atTheMoney": None, "MWPL": None,
        }
        rows, summary = sof._parse_chain(body, "RELIANCE", "2026-07-30", "2026-08-27")
        assert len(rows) == 1
        row = rows[0]
        # (symbol, today, expiry, strike, ce_price, ...) -- strike is index 3
        assert row[3] == 2500.0
        assert row[4] == 100.0  # ce_price
