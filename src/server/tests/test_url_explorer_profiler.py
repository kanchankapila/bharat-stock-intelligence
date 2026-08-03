import json, os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec
from url_explorer.fetcher import FetchResult
from url_explorer.profiler import flatten, profile_endpoint

UNIVERSE = {"INFY", "TCS", "HDFCBANK"}
EP = EndpointTemplate("t", "h", "/p/", [], "GET", [], [])

def _res(payload):
    return FetchResult(EP, "u", 200, 1, True, json.dumps(payload), "application/json", None)

def test_flatten_nested_and_lists():
    pairs = dict_paths = flatten({"a": {"b": 1}, "c": [{"sym": "INFY"}, {"sym": "TCS"}]})
    paths = [p for p, _ in pairs]
    assert "a.b" in paths
    assert paths.count("c.sym") == 2

def test_numeric_stats_and_fill_rate():
    results = [_res({"pe": 10.0}), _res({"pe": 20.0}), _res({"x": 1})]
    profs = {p.field_path: p for p in profile_endpoint(results, UNIVERSE, set())}
    pe = profs["pe"]
    assert pe.dtype == "numeric"
    assert pe.num_min == 10.0 and pe.num_max == 20.0 and pe.num_mean == 15.0
    assert round(pe.fill_rate, 2) == 0.67  # present in 2 of 3 responses

def test_universe_overlap_detects_ticker_field():
    results = [_res({"rows": [{"sym": "INFY"}, {"sym": "TCS"}, {"sym": "ZZZ"}]})]
    profs = {p.field_path: p for p in profile_endpoint(results, UNIVERSE, set())}
    assert round(profs["rows.sym"].universe_overlap_pct, 2) == 0.67

def test_changed_vs_last_flag():
    results = [_res({"newcol": 1})]
    profs = {p.field_path: p for p in profile_endpoint(results, UNIVERSE, prev_paths={"oldcol"})}
    assert profs["newcol"].changed_vs_last is True
