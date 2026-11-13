"""SvelteKit __data.json decoding and the Tapetide page -> endpoint payload split.

The fixture is a real capture of https://tapetide.com/stocks/BEL/__data.json (2026-11-07). It is the
route that replaced api.tapetide.com/api/v1/companies/{symbol}/{score,analyst-ratings,forecasts},
which now 404/401 (AF-20261107-09).
"""
import json
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sveltekit_data as sk  # noqa: E402
import extra_features_parser as efp  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "tapetide_stocks_BEL__data.json")


@pytest.fixture(scope="module")
def bel():
    with open(FIXTURE, encoding="utf-8") as f:
        return sk.decode_data_json(f.read())


def test_decodes_the_real_bel_page(bel):
    assert bel["company"]["nse_symbol"] == "BEL"
    assert bel["company"]["isin"] == "INE263A01024"
    assert bel["sections"]["score"]["data"]["score"] == 53
    assert set(bel["sections"]["score"]["data"]["pillars"]) == {
        "financial_health", "growth", "momentum", "ownership", "quality", "valuation"}
    assert bel["sections"]["analystRatings"]["buy"] == 29 and bel["sections"]["analystRatings"]["total_ratings"] == 30
    assert len(bel["sections"]["forecasts"]) == 2
    assert bel["shareholding"]["quarterly"]["data"]["Promoters"]["Dec 2025"] == 51.14


def test_a_number_element_is_data_but_a_negative_reference_is_special(bel):
    # element values like -5924 are ordinary numbers; only a REFERENCE of -1..-6 is a sentinel
    # references 1 -> flat[1] (an ordinary number); -1 undefined, -3 NaN, -4 +inf, -5 -inf, -6 -0.0
    out = sk.unflatten([{"loss": 1, "gone": -1, "nan": -3, "up": -4, "down": -5, "neg0": -6}, -5924])
    assert out["loss"] == -5924
    assert out["gone"] is None
    assert math.isnan(out["nan"]) and out["up"] == math.inf and out["down"] == -math.inf
    assert out["neg0"] == 0 and math.copysign(1, out["neg0"]) < 0
    # and the real page keeps its one negative-zero percentage change instead of dropping it
    v = bel["financials"]["balance_sheet"]["pct_changes"]["Other Liabilities"]["Mar 2023"]
    assert v == 0 and math.copysign(1, v) < 0


def test_tagged_values_and_shared_references():
    flat = [
        {"when": 1, "tags": 2, "pairs": 5, "big": 8, "a": 3, "b": 3},
        ["Date", "2026-11-13T00:00:00.000Z"],
        ["Set", 3, 4],
        "x", "y",
        ["Map", 3, 6, 4, 7],
        1, 2,
        ["BigInt", "12345678901234567890"],
    ]
    out = sk.unflatten(flat)
    assert out["when"] == "2026-11-13T00:00:00.000Z"
    assert out["tags"] == ["x", "y"]
    assert out["pairs"] == {"x": 1, "y": 2}
    assert out["big"] == 12345678901234567890
    assert out["a"] is out["b"] or out["a"] == out["b"] == "x"


def test_bad_inputs_are_rejected_not_guessed():
    with pytest.raises(ValueError):
        sk.unflatten([])
    with pytest.raises(ValueError):
        sk.unflatten([{"k": 99}])
    with pytest.raises(ValueError):
        sk.unflatten([["Frobnicate", 1]])
    with pytest.raises(ValueError):
        sk.decode_data_json({"type": "data", "nodes": [{"type": "skip"}]})
    with pytest.raises(ValueError):
        sk.decode_data_json({"type": "weird"})


def test_a_redirect_is_reported_with_its_target_not_as_missing_data():
    with pytest.raises(sk.SvelteKitRedirect) as e:
        sk.decode_data_json('{"type":"redirect","location":"/stocks/BEL"}')
    assert e.value.location == "/stocks/BEL"


def test_tapetide_split_keeps_the_exact_shape_the_parser_reads(bel):
    pl = sk.tapetide_payloads(bel, "bel")
    assert set(pl) == {"tapetide_score", "tapetide_analyst_ratings", "tapetide_forecasts"}
    assert pl["tapetide_score"]["data"]["score"] == 53
    assert pl["tapetide_analyst_ratings"]["data"]["buy"] == 29
    assert len(pl["tapetide_forecasts"]["data"]) == 2
    # the UNCHANGED parser turns the new score payload into the same feature as before
    feat = efp.extract_features("BEL", [("tapetide_score", json.dumps(pl["tapetide_score"]))])
    assert feat["ext_tt_score"] == 53.0


def test_a_section_the_page_flags_unavailable_or_omits_is_not_stored_as_an_empty_payload(bel):
    page = json.loads(json.dumps(bel))
    page["sections"]["flags"]["forecasts"]["available"] = False
    del page["sections"]["analystRatings"]
    assert set(sk.tapetide_payloads(page, "BEL")) == {"tapetide_score"}


def test_a_page_for_a_different_stock_cannot_be_filed_under_the_requested_symbol(bel):
    with pytest.raises(ValueError, match="not RELIANCE"):
        sk.tapetide_payloads(bel, "RELIANCE")


def test_plain_url_shape_merges_the_layout_node_with_the_page_node():
    # plain __data.json = two data nodes (layout, page); ?x-sveltekit-invalidated=01 = skip + page
    layout = {"type": "data", "data": [{"headLinkPaths": 1}, ["Set", 2], "a/b"]}
    page = {"type": "data", "data": [{"company": 1, "sections": 2}, {"nse_symbol": 3}, {}, "BEL"]}
    both = sk.decode_data_json({"type": "data", "nodes": [layout, page]})
    assert both["headLinkPaths"] == ["a/b"] and both["company"]["nse_symbol"] == "BEL"
    page_only = sk.decode_data_json({"type": "data", "nodes": [{"type": "skip"}, page]})
    assert "headLinkPaths" not in page_only and page_only["company"] == both["company"]
    # a layout-only response (invalidated=10: page skipped) decodes but has no stock to file
    shell = sk.decode_data_json({"type": "data", "nodes": [layout, {"type": "skip"}]})
    with pytest.raises(ValueError):
        sk.tapetide_payloads(shell, "BEL")
