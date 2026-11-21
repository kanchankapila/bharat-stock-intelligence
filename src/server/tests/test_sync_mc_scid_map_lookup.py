"""AF-20261120-07: sync_mc_scid_map._lookup put the query into the URL unencoded, so 'M&M'
became query=M plus a stray 'M' parameter and M&M, M&MFIN, J&KBANK never resolved."""
import importlib.util
import os

_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "sync_mc_scid_map.py")
_spec = importlib.util.spec_from_file_location("sync_mc_scid_map", _PATH)
smm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smm)


def test_lookup_encodes_ampersand(monkeypatch):
    seen = {}

    class _Resp:
        text = "[]"

    def fake_get(url, headers=None, timeout=None):
        seen["url"] = url
        return _Resp()

    monkeypatch.setattr(smm.requests, "get", fake_get)
    smm._lookup("M&M")
    assert "query=M%26M&" in seen["url"]
