"""AF-20261001-47: scoring_engine blended 15% of a frozen per-signal-type Beta posterior into
win_probability. Measured 2026-10-05 (technical outcomes since 2026-08-15, signal types with >=100
outcomes): Spearman(prior, realized mean return) = +0.24 at h5 (p=0.51) and -0.20 at h15 (p=0.61);
the highest-prior type (PCR_EXTREME, 0.67) has among the worst realized returns. The posteriors
(counts in the hundreds of thousands, so no shrinkage) are each type's win rate under the
path-barrier label, which measurement.md shows rewards volatility. The blend therefore adds noise."""
import inspect
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import scoring_engine as se


def test_prior_blend_weight_is_zero():
    assert se.SIGNAL_TYPE_PRIOR_WEIGHT == 0.0


def test_the_blend_is_gated_on_the_weight_not_hard_coded():
    src = inspect.getsource(se.AlphaQuantScoringEngine)
    assert "SIGNAL_TYPE_PRIOR_WEIGHT > 0" in src
    assert "prior_weight = 0.15" not in src
