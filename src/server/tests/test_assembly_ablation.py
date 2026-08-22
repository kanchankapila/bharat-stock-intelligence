"""assembly_ablation.py — guards for the two artifacts that produced WRONG answers first.

Both were bugs in the MEASUREMENT script, not in unified_ranker, and each one produced a
confident, plausible, wrong result before being caught. That is the "a bug in the measurement
tooling is worse than no measurement, because it looks like evidence" class in measurement.md.
"""
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import assembly_ablation as ab
import engine_composite as ec
import unified_ranker as ur


def _code_only(mod, start_marker, end_marker):
    """Source between two markers with comments and docstrings stripped.

    Scanning raw source is not enough: these very files DOCUMENT the traps being guarded
    against, so a naive substring scan matches the explanation and fails on correct code.
    """
    import io
    import tokenize
    src = open(mod.__file__, encoding="utf-8").read()
    seg = src[src.index(start_marker):src.index(end_marker)]
    out, prev_type = [], tokenize.INDENT
    try:
        for tok in tokenize.generate_tokens(io.StringIO(seg).readline):
            if tok.type == tokenize.COMMENT:
                continue
            # A STRING that is the first token of a logical line is a docstring.
            if tok.type == tokenize.STRING and prev_type in (
                    tokenize.INDENT, tokenize.NEWLINE, tokenize.NL, tokenize.DEDENT):
                prev_type = tok.type
                continue
            out.append(tok.string)
            if tok.type not in (tokenize.NL, tokenize.NEWLINE):
                prev_type = tok.type
    except tokenize.TokenError:
        pass
    # Tokens are joined without spaces so `ec.load_panel` matches as written.
    return "".join(out)


class TestPanelSourceIsRawNotStoredScores:
    def test_reads_raw_engine_tables_not_unified_recommendations_score_columns(self):
        """unified_recommendations.ml_score is a literal 0.0 (not NULL) for a never-scored
        engine on 36,400 of 72,223 rows; the NULL guard only landed 2026-08-18. Normalizing a
        constant-zero engine re-spreads it over a full 0-100 rank -- pure noise at a real
        weight. Version 1 of this script did that and reported a NEGATIVE blend IC.
        """
        panel = _code_only(ab, "def load_panel", "def load_liquidity")
        assert "ec.load_panel" in panel, "the engine panel must come from engine_composite's raw loader"
        # cs_score/breakout_score also name RAW columns, so only assert on the ones that are
        # unambiguously stored-only reporting columns.
        for col in ("ml_score", "dl_score", "technical_score", "screener_stock_score",
                    "confluence_score", "smart_money_score"):
            assert col not in panel, (
                f"{col} is a stored unified_recommendations column and carries the "
                "zero-vs-NULL artifact -- do not build the historical panel from it"
            )

    def test_raw_column_map_covers_only_engines_with_a_raw_source(self):
        # screener and smart_money have no raw historical table, so they must be absent from
        # BOTH arms -- otherwise equal_weight and regime_weighted are not comparable.
        assert set(ab.RAW_TO_ENGINE.values()) <= set(ur.ENGINE_TO_SCORE_COL)
        assert "screener" not in ab.RAW_TO_ENGINE.values()
        assert "smart_money" not in ab.RAW_TO_ENGINE.values()
        # Every raw column must be one engine_composite actually produces.
        assert set(ab.RAW_TO_ENGINE) == set(ec.ENGINES)


class TestZeroDispersionGuardNotAppliedToRawScale:
    def test_min_sd_threshold_would_destroy_a_raw_probability_engine(self):
        """ZERO_DISPERSION_MIN_SD=5.0 is calibrated for 0-100 scores. win_probability is 0-1
        with sd ~0.07, so applying the guard on the raw scale drops it as 'no dispersion'.
        Version 2 of this script did that and dropped ml on 33 of 43 dates, flipping the
        equal-weight arm negative. This pins WHY the ablation must not call it.
        """
        # A realistic win_probability spread: mean ~0.72, sd ~0.07 (matches the live column).
        raw_probs = {f"S{i}": 0.50 + (i % 100) * 0.0045 for i in range(200)}
        kept, dropped = ur.drop_zero_dispersion_engines({"ml": raw_probs})
        assert dropped == ["ml"], "a raw 0-1 engine is spuriously dropped -- that is the trap"
        # The identical distribution scaled to 0-100 survives, proving it is a scale artifact.
        kept2, dropped2 = ur.drop_zero_dispersion_engines(
            {"ml": {k: v * 100 for k, v in raw_probs.items()}})
        assert dropped2 == [] and "ml" in kept2

    def test_ablation_does_not_call_the_guard(self):
        build = _code_only(ab, "def build_arms", "def main(")
        assert "drop_zero_dispersion_engines" not in build


class TestLiquidityFloor:
    def test_panel_spec_floor_is_applied(self):
        # Without it the ablation reported that the ranker's universe destroyed the composite's
        # edge (h5 +0.068 full vs +0.012 restricted). With it the gap closes to +0.0575/+0.0585:
        # the effect was microcaps, not selection.
        assert ab.MIN_ADT_CR == 1.0
        src = open(ab.__file__, encoding="utf-8").read()
        assert 'd["adt_cr"] >= MIN_ADT_CR' in src


class TestArmsAreCumulativeInRankerOrder:
    def test_arm_order_matches_unified_ranker_application_order(self):
        # quality_gate -> RED_FLAG_VETO -> HIGH_VOL_VETO, the order run() applies them in.
        assert ab.ARMS == [
            "equal_weight", "regime_weighted", "rw+quality", "rw+quality+redflag",
            "rw+quality+redflag+highvol", "stored_unified_score",
        ]
        run_src = open(ur.__file__, encoding="utf-8").read()
        i_q = run_src.index("unified *= _qg")
        i_r = run_src.index("unified *= RED_FLAG_VETO_MULT")
        i_h = run_src.index("unified *= HIGH_VOL_VETO_MULT")
        assert i_q < i_r < i_h, "ranker changed its multiplier order; the arms must follow"
