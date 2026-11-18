"""AF-20261029-94: the shared promotion helper must never promote a model whose metric could
not be computed, with or without a baseline, and the file-staleness override must not rescue one."""
import math
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from model_promotion import clears_promotion_bar


@pytest.mark.parametrize("candidate", [float("nan"), float("inf"), float("-inf"), None])
@pytest.mark.parametrize("baseline", [None, 0.55])
def test_unscored_candidate_never_clears_the_bar(candidate, baseline):
    assert clears_promotion_bar(candidate, baseline, 0.01) is False


def test_finite_candidate_keeps_the_old_contract():
    assert clears_promotion_bar(0.60, None, 0.01) is True
    assert clears_promotion_bar(0.60, 0.55, 0.01) is True
    assert clears_promotion_bar(0.555, 0.55, 0.01) is False


def test_live_screener_staleness_override_requires_a_scored_candidate():
    src = open(os.path.join(os.path.dirname(__file__), "..", "live_screener_ml_ranker.py"),
               encoding="utf-8").read()
    guard = re.search(r"if not promote and baseline is not None([^\n]*):\n\s+staleness_override, age_days", src)
    assert guard, "staleness-override block not found; source shape changed"
    assert "metric_is_usable(test_auc)" in guard.group(1)
    assert math.isnan(float("nan"))
