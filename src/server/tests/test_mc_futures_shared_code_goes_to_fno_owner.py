"""A shared mcsymbol must not be fetched once per sharing symbol: MC answers with one company's
futures and the others get a verbatim copy (AGROPHOS/LAXMICOT/TOUCHWOOD held ASIANPAINT/LUPIN/TMPV
contracts on 2026-11-11). Fake query_all: no database needed."""
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import mc_stock_futures_oi_fetcher as f


def _map(monkeypatch, rows):
    monkeypatch.setattr(f, "query_all", lambda sql, *a, **k: rows)
    return f.load_mc_symbol_map()


def _r(sym, code, fno):
    return {"symbol": sym, "mcsymbol": code, "fno_eligible": fno}


def test_shared_code_goes_only_to_the_single_fno_owner(monkeypatch):
    m = _map(monkeypatch, [_r("ASIANPAINT", "API", 1), _r("AGROPHOS", "API", 0),
                           _r("TMPV", "TEL", 1), _r("TOUCHWOOD", "TEL", 0), _r("TCS", "TCS", 1)])
    assert m == {"ASIANPAINT": "API", "TMPV": "TEL", "TCS": "TCS"}


def test_shared_code_with_no_or_several_fno_owners_is_skipped_not_guessed(monkeypatch):
    m = _map(monkeypatch, [_r("A", "X1", 0), _r("B", "X1", 0), _r("C", "X2", 1), _r("D", "X2", 1)])
    assert m == {}


def test_unshared_code_is_kept_even_when_not_fno(monkeypatch):
    assert _map(monkeypatch, [_r("SMALLCO", "SC01", 0)]) == {"SMALLCO": "SC01"}
