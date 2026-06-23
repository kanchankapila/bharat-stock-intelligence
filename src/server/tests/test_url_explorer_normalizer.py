# src/server/tests/test_url_explorer_normalizer.py
import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import classify_value, normalize

UNIVERSE = {"INFY", "HDFCBANK", "TCS"}

class TestClassifyValue:
    def test_ticker(self):
        assert classify_value("INFY", UNIVERSE) == "ticker"
    def test_date(self):
        assert classify_value("2026-06-23", UNIVERSE) == "date"
    def test_epoch(self):
        assert classify_value("1781207470", UNIVERSE) == "epoch"
    def test_int_id(self):
        assert classify_value("533", UNIVERSE) == "int_id"
    def test_string(self):
        assert classify_value("all", UNIVERSE) == "string"

class TestNormalize:
    def test_kayal_collapses_to_one_endpoint(self):
        urls = [
            "https://kayal.trendlyne.com/x/get/?perPageCount=200&pageNumber=0&screenpk=19814&groupType=all",
            "https://kayal.trendlyne.com/x/get/?perPageCount=200&pageNumber=0&screenpk=3057&groupType=all",
            "https://kayal.trendlyne.com/x/get/?perPageCount=200&pageNumber=0&screenpk=6211&groupType=all",
        ]
        eps = normalize(urls, UNIVERSE)
        assert len(eps) == 1
        ep = eps[0]
        assert ep.host == "kayal.trendlyne.com"
        assert len(ep.urls) == 3
        screenpk = next(p for p in ep.params if p.name == "screenpk")
        assert screenpk.is_variable is True
        assert screenpk.inferred_type == "int_id"
        ptype = next(p for p in ep.params if p.name == "perPageCount")
        assert ptype.is_variable is False
        assert ptype.inferred_type == "const"

    def test_rest_path_ids_templated(self):
        urls = [
            "https://trendlyne.com/web-widget/qvt-widget/533/HDFCBANK/",
            "https://trendlyne.com/web-widget/qvt-widget/1594/INFY/",
        ]
        eps = normalize(urls, UNIVERSE)
        assert len(eps) == 1
        assert eps[0].path_skeleton == "/web-widget/qvt-widget/{int_id}/{ticker}/"
        locs = {(p.name, p.location, p.inferred_type) for p in eps[0].params}
        assert ("path_2", "path", "int_id") in locs
        assert ("path_3", "path", "ticker") in locs

    def test_distinct_endpoints_separate(self):
        urls = [
            "https://a.com/p/?x=1",
            "https://b.com/p/?x=1",
        ]
        assert len(normalize(urls, UNIVERSE)) == 2
