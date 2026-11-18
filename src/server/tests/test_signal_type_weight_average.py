"""AF-20261118-02: scoring_engine averaged signal_type_weights per type with a plain AVG, so a
5-row (regime, sector) key pinned at the 2.0 clamp counted as much as a 2,000-row key; 72 keys
under 30 samples lifted type averages by 0.1-0.37 (MACD_CROSSOVER 0.725 vs 0.359 weighted)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402


def test_type_weight_is_sample_weighted():
    from scoring_engine import load_signal_type_weights
    conn = pg_memory_conn()
    conn.execute("""CREATE TABLE signal_type_weights (signal_type TEXT, regime TEXT, sector TEXT,
        weight DOUBLE PRECISION, sample_count INTEGER)""")
    conn.execute("INSERT INTO signal_type_weights VALUES ('X','BULL','Energy',0.3,2000), ('X','BEAR','Utilities',2.0,5), "
                 "('Y','BULL','Energy',0.8,0), ('Z','BULL','Energy',0.5,NULL)")
    conn.commit()
    w = load_signal_type_weights(conn)
    assert w['X'] == pytest.approx((0.3 * 2000 + 2.0 * 5) / 2005)
    assert 'Y' not in w and 'Z' not in w   # no samples behind it: no learned weight
