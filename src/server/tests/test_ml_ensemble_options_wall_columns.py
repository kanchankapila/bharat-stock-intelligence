"""AF-20260827-16: the three options-wall columns (call_wall_dist_pct, put_wall_dist_pct,
near_expiry_gamma) reach the model through build_features(), which reads them from the SELECT that
builds each frame. ml_ensemble.py has seven parallel SELECTs (train, score, incremental and the
two later copies); a column added to some and not all trains on a real value and scores on the
default. Every SELECT that reads ts.iv_rank (the first of that options group) must read all three."""
import os
import re

SRC = os.path.join(os.path.dirname(__file__), "..", "ml_ensemble.py")
WALL = ("ts.call_wall_dist_pct", "ts.put_wall_dist_pct", "ts.near_expiry_gamma")


def _selects_reading_iv_rank(text: str):
    """Each SQL string literal (triple-quoted) that selects ts.iv_rank."""
    out = []
    for m in re.finditer(r'("""|\'\'\')(.*?)\1', text, flags=re.S):
        if "ts.iv_rank" in m.group(2):
            out.append(m.group(2))
    return out


def test_every_select_that_reads_iv_rank_also_reads_the_options_wall_columns():
    text = open(SRC, encoding="utf-8").read()
    blocks = _selects_reading_iv_rank(text)
    assert len(blocks) >= 7, f"scan found only {len(blocks)} SELECTs; the census is vacuous"
    for i, sql in enumerate(blocks):
        missing = [c for c in WALL if c not in sql]
        assert not missing, f"SELECT #{i + 1} reads ts.iv_rank but not {missing}"


def test_the_scan_flags_a_select_that_dropped_a_wall_column():
    bad = '"""SELECT ts.iv_rank, ts.iv_skew, ts.call_wall_dist_pct, ts.put_wall_dist_pct FROM t ts"""'
    blocks = _selects_reading_iv_rank(bad)
    assert len(blocks) == 1
    assert any(c not in blocks[0] for c in WALL)
