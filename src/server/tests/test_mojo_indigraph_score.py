"""_mojo_score: the `details` JSON blob -> float parser behind the mojo_indigraph factor.

The one thing worth pinning is that a BAD blob yields NaN and never 0.0. Zero is a legitimate
neutral indigraph reading, so a parse failure that coerced to 0.0 would silently plant a real
signal value on every unparseable row -- and unlike a NaN it would survive into the
cross-sectional rank and drag names toward the middle of the book instead of dropping out.
That is the `float(x or 0)` class in recurring-bugs.md.

Negative-controlled 2026-08-12: replacing the body with `float(json.loads(blob).get('score') or 0)`
makes test_bad_blob_is_nan_never_zero fail on 5 of its 7 cases and test_nan_token_is_not_zero fail
(`nan or 0` is `nan`, so that one survives -- which is exactly why isfinite is checked separately).
"""

import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from factor_backtest import _mojo_score  # noqa: E402


@pytest.mark.parametrize("blob,expected", [
    ('{"score": "-0.39"}', -0.39),      # the real production shape: score is a STRING
    ('{"score": -1.11}', -1.11),
    ('{"score": 0}', 0.0),              # genuine neutral must survive as 0.0, not become NaN
    ('{"score": "2.5", "other": 1}', 2.5),
])
def test_valid_scores_parse(blob, expected):
    assert _mojo_score(blob) == pytest.approx(expected)


@pytest.mark.parametrize("blob", [
    None,                 # SQL NULL
    '',                   # empty string
    'not json',
    '[]',                 # valid JSON, no .get
    '{}',                 # no score key -> float(None)
    '{"score": null}',
    '{"score": "abc"}',   # unconvertible string
])
def test_bad_blob_is_nan_never_zero(blob):
    v = _mojo_score(blob)
    assert isinstance(v, float)
    assert math.isnan(v), f"{blob!r} produced {v!r}; a parse failure must not yield a usable score"


@pytest.mark.parametrize("blob", ['{"score": NaN}', '{"score": Infinity}', '{"score": -Infinity}'])
def test_non_finite_is_nan_not_passed_through(blob):
    # json.loads accepts these bare tokens by default. Infinity would sort to the TOP of a
    # `ORDER BY score DESC` selection, so it must be rejected rather than clipped.
    assert math.isnan(_mojo_score(blob))


def test_zero_is_distinguishable_from_failure():
    """The whole point: these two inputs must NOT produce the same value."""
    assert _mojo_score('{"score": 0}') == 0.0
    assert math.isnan(_mojo_score('{"score": "abc"}'))
