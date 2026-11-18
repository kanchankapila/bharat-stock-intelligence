"""AF-20261112-12: scripts/repair/repair_double_adjusted_history.py removes exactly one extra
application of a factor, leaves correctly adjusted bars alone, and finds nothing on a second pass."""
import importlib.util
import os
import sys
from datetime import date, timedelta

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _load():
    sys.path.insert(0, os.path.join(REPO, 'scripts', 'repair'))
    path = os.path.join(REPO, 'scripts', 'repair', 'repair_double_adjusted_history.py')
    spec = importlib.util.spec_from_file_location('repair_double_adjusted_history', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = [date(2025, 1, 1) + timedelta(days=i) for i in range(60)]
F = 2 / 3
RAW = {d: (150.0 if i < 50 else 100.0) for i, d in enumerate(D)}      # bonus ex-date D[50]
FACTORS = [(D[50], F)]


def _series(closes):
    return [(d, c, c, c, c, 1000) for d, c in zip(D, closes)]


def test_doubled_segment_is_undone_once_and_correct_bars_are_left_alone():
    m = _load()
    stored = [150 * F * F] * 30 + [150 * F] * 20 + [100.0] * 10      # 0-29 doubled, 30-49 right
    fix = m.corrections(_series(stored), RAW, FACTORS)
    assert sorted(fix) == D[:30]
    assert all(abs(v - 1 / F) < 1e-12 for v in fix.values())
    repaired = [c * fix.get(d, 1.0) for d, c in zip(D, stored)]
    assert m.corrections(_series(repaired), RAW, FACTORS) == {}


def test_too_few_matching_bars_is_not_a_doubled_segment():
    m = _load()
    stored = [150 * F * F] * 5 + [150 * F] * 45 + [100.0] * 10
    assert m.corrections(_series(stored), RAW, FACTORS) == {}


def test_bar_without_raw_close_is_never_touched():
    m = _load()
    stored = [150 * F * F] * 30 + [150 * F] * 20 + [100.0] * 10
    raw = {d: c for d, c in RAW.items() if d != D[3]}
    assert D[3] not in m.corrections(_series(stored), raw, FACTORS)
