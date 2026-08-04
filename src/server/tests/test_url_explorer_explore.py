import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.explore import run

UNIVERSE = {f"S{i}" for i in range(40)}

def test_run_end_to_end_without_db_or_network():
    urls = [f"https://api.test/screener/?pk={i}" for i in range(3)]
    import json
    def fetch_fn(url):
        rows = [{"sym": f"S{i}", "score": float(i)} for i in range(30)]
        return 200, json.dumps({"rows": rows}), "application/json"
    rets = {"fwd_ret_5d": {f"S{i}": float(i) for i in range(30)}}
    out = run(urls, UNIVERSE, fetch_fn=fetch_fn, returns_by_target=rets,
              max_per_endpoint=1, write=False)
    assert out["endpoints"] == 1
    assert out["fetches"] == 1
    assert "rows.score" in out["report"]
    assert "fwd_ret_5d" in out["report"]
