import json, os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate
from url_explorer.fetcher import FetchResult
from url_explorer.profiler import FieldProfile
from url_explorer.correlator import build_cross_section, correlate, correlate_endpoint

EP = EndpointTemplate("t", "h", "/p/", [], "GET", [], [])
UNIVERSE = {f"S{i}" for i in range(50)}

def _res(rows):
    return FetchResult(EP, "u", 200, 1, True, json.dumps({"rows": rows}), "application/json", None)

def test_build_cross_section_keys_by_ticker():
    r = _res([{"sym": "S1", "score": 10.0}, {"sym": "S2", "score": 20.0}])
    cs = build_cross_section([r], "rows.sym", "rows.score", UNIVERSE)
    assert cs == {"S1": 10.0, "S2": 20.0}

def test_correlate_perfect_positive():
    cs = {f"S{i}": float(i) for i in range(30)}
    rets = {f"S{i}": float(i) for i in range(30)}
    c = correlate(cs, rets, "rows.score", "fwd_ret_5d", min_n=20)
    assert c is not None and round(c.pearson, 3) == 1.0 and round(c.spearman, 3) == 1.0

def test_correlate_below_min_n_returns_none():
    cs = {f"S{i}": float(i) for i in range(5)}
    rets = {f"S{i}": float(i) for i in range(5)}
    assert correlate(cs, rets, "f", "t", min_n=20) is None

def test_correlate_endpoint_only_ticker_keyed_numeric():
    rows = [{"sym": f"S{i}", "score": float(i)} for i in range(30)]
    profs = [
        FieldProfile("rows.sym", "string", 1.0, 30, None, None, None, 1.0, False),
        FieldProfile("rows.score", "numeric", 1.0, 30, 0.0, 29.0, 14.5, 0.0, False),
    ]
    rets = {"fwd_ret_5d": {f"S{i}": float(i) for i in range(30)}}
    cors = correlate_endpoint([_res(rows)], profs, rets, UNIVERSE)
    assert len(cors) == 1 and cors[0].field_path == "rows.score"
    assert round(cors[0].pearson, 3) == 1.0
