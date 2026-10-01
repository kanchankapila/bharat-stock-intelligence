"""AF-20261001-40: exit_labeler wrote a triple-barrier label as soon as ANY forward bar existed,
then never revisited it (`_entries` skips keys already in signal_excursions). Measured live
2026-10-01: 85.8% of h15 and 29.4% of h5 tb_labels were computed on a truncated window -- e.g.
20MICRONS 2026-08-03 h15 stored horizon_close_pct 4.16 (the 14th session) vs 8.79 at the 15th.
That label is ml_ensemble's training target, so the model learned a shorter horizon than it claims.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import exit_labeler  # noqa: E402


def _run(monkeypatch, n_forward_bars, horizon=5):
    written = []
    monkeypatch.setattr(exit_labeler, '_ensure_vol_rank_column', lambda: None)
    monkeypatch.setattr(exit_labeler, '_entries', lambda h, l, relabel=False: [
        {'symbol': 'ABC', 'signal_date': '2026-09-01', 'horizon_days': horizon, 'entry_price': 100.0}])

    def fake_read_df(sql, params):
        if 'date > ?' in sql:   # forward window
            return pd.DataFrame({'date': range(n_forward_bars), 'high': [102.0] * n_forward_bars,
                                 'low': [99.0] * n_forward_bars, 'close': [101.0] * n_forward_bars})
        return pd.DataFrame({'high': [101.0] * 40, 'low': [99.0] * 40, 'close': [100.0] * 40})

    monkeypatch.setattr(exit_labeler, 'read_df', fake_read_df)
    monkeypatch.setattr(exit_labeler, 'executemany', lambda sql, rows: written.extend(rows) or len(rows))
    exit_labeler.run()
    return written


def test_partial_window_is_not_labelled(monkeypatch):
    assert _run(monkeypatch, n_forward_bars=3, horizon=5) == []


def test_full_window_is_labelled(monkeypatch):
    rows = _run(monkeypatch, n_forward_bars=5, horizon=5)
    assert len(rows) == 1


def test_relabel_drops_the_skip_existing_clause(monkeypatch):
    seen = {}
    monkeypatch.setattr(exit_labeler, 'query_all', lambda sql, params: seen.setdefault('sql', sql) and [])
    exit_labeler._entries(None, None, relabel=True)
    assert 'NOT EXISTS' not in seen['sql']
    seen.clear()
    exit_labeler._entries(None, None)
    assert 'NOT EXISTS' in seen['sql']
