import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate
from url_explorer.profiler import FieldProfile
from url_explorer.correlator import Correlation
from url_explorer.report import render_report

def test_report_lists_endpoint_and_correlations():
    ep = EndpointTemplate("https://h/p/?x", "h", "/p/", ["x"], "GET", [], ["u1", "u2"])
    items = [{
        "endpoint": ep, "n_ok": 2, "n_total": 2,
        "profiles": [FieldProfile("rows.score", "numeric", 1.0, 2, 0.0, 1.0, 0.5, 0.0, False)],
        "correlations": [Correlation("rows.score", "fwd_ret_5d", 30, 0.42, 0.40, 0.40)],
    }]
    md = render_report(items)
    assert "https://h/p/?x" in md
    assert "rows.score" in md
    assert "0.42" in md
    assert "2/2" in md  # fetch success

def test_report_handles_empty():
    assert "No endpoints" in render_report([])
