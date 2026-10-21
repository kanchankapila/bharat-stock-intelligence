"""unified_ranker._MF_FACTOR_WEIGHTS deliberately duplicates multi_factor_scorer.FACTOR_WEIGHTS
(importing it would add numpy/pandas to a DB-only module and risks a circular import between two large modules).
The duplication is not the defect; undetectable drift between the copies is, so pin them together here (AF-20261021-06)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import multi_factor_scorer  # noqa: E402
import unified_ranker  # noqa: E402


def _normalised(ranker_weights):
    # the ranker keys are the stored column names ('mf_quality_score'); the scorer's are the bare factor names ('quality')
    return {k[len("mf_"):-len("_score")]: v for k, v in ranker_weights.items()}


def test_both_declarations_are_non_empty_and_well_formed():
    assert len(multi_factor_scorer.FACTOR_WEIGHTS) >= 5
    assert len(unified_ranker._MF_FACTOR_WEIGHTS) >= 5
    assert all(k.startswith("mf_") and k.endswith("_score") for k in unified_ranker._MF_FACTOR_WEIGHTS)


def test_ranker_copy_matches_the_scorer_keys_and_values():
    assert _normalised(unified_ranker._MF_FACTOR_WEIGHTS) == multi_factor_scorer.FACTOR_WEIGHTS
