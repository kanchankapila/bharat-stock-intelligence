"""Unit tests for the finbert-tone ensemble fusion in finbert_scorer.py.

Covers ONLY the pure fusion arithmetic (fuse_tone) — the torch forward passes are the
model's job, not ours to test. The offline-import guard for finbert_scorer lives in
test_finbert_offline_load.py and must keep passing: this module imports finbert_scorer,
so if a heavy/torch import ever lands above the HF_HUB_OFFLINE setdefault there, that
test fails first.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from finbert_scorer import fuse_tone


def _base(score: float) -> dict:
    return {"label": "positive", "confidence": 0.9, "sentiment_score": score}


def test_fuse_none_writes_null_tone_fields():
    """tone=None (model unavailable / cache not warmed) must degrade to explicit NULLs,
    not crash or fabricate a fake second opinion."""
    out = fuse_tone(_base(0.8), None)
    assert out["tone_pos"] is None
    assert out["tone_neg"] is None
    assert out["tone_neu"] is None
    assert out["tone_label"] is None
    assert out["tone_score"] is None
    assert out["sentiment_conflict"] is None
    assert out["sentiment_score"] == 0.8  # base result untouched


def test_full_agreement_gives_zero_conflict():
    """Tone probs [0.9, 0.1, 0.0] → signed +0.8, same as base → conflict exactly 0."""
    out = fuse_tone(_base(0.8), [0.9, 0.1, 0.0])
    assert out["tone_label"] == "positive"
    assert out["tone_score"] == 0.8
    assert out["sentiment_conflict"] == 0.0


def test_maximal_disagreement_stays_in_unit_range():
    """Base +0.9 vs tone −0.8 → conflict = |0.9 − (−0.8)| / 2 = 0.85 (the worst case for
    confident opposite verdicts; 1.0 is unreachable unless both models are fully certain
    in opposite directions, which softmax almost never produces)."""
    out = fuse_tone(_base(0.9), [0.1, 0.9, 0.0])
    assert out["tone_label"] == "negative"
    assert out["tone_score"] == -0.8
    assert out["sentiment_conflict"] == pytest.approx(0.85)


def test_neutral_tone_verdict_maps_correctly():
    out = fuse_tone(_base(0.4), [0.2, 0.1, 0.7])
    assert out["tone_label"] == "neutral"
    assert out["tone_neu"] == 0.7


LEGACY_ORDER = {0: "neutral", 1: "positive", 2: "negative"}


def test_legacy_tone_repo_label_order_is_respected():
    """yiyanghkust/finbert-tone ships config id2label {0:neutral, 1:positive, 2:negative} —
    NOT ProsusAI's {positive, negative, neutral}. Caught live 2026-09-11: with the wrong
    order, a confident bearish verdict scored −1.0 but was labeled "neutral" and a
    confident bullish one +1.0 labeled "negative". With the config-derived order passed in,
    probs [0.0, 0.95, 0.05] (idx1 dominant) must read positive/+0.9."""
    out = fuse_tone(_base(0.7), [0.0, 0.95, 0.05], order=LEGACY_ORDER)
    assert out["tone_label"] == "positive"
    assert out["tone_score"] == pytest.approx(0.90)
    assert out["tone_pos"] == 0.95      # idx 1, per legacy order
    assert out["tone_neg"] == 0.05      # idx 2, per legacy order
    assert out["tone_neu"] == 0.0       # idx 0, per legacy order


def test_legacy_order_bearish_headline_is_negative_not_neutral():
    """The exact live failure: bearish text, argmax at legacy idx 2 ('negative'). A hardcoded
    ProsusAI-order label map calls it 'neutral' while the signed score reads −1.0 —
    internally contradictory output. With the real order, label and score agree."""
    out = fuse_tone(_base(-0.94), [0.0, 0.0, 1.0], order=LEGACY_ORDER)
    assert out["tone_label"] == "negative"
    assert out["tone_score"] == pytest.approx(-1.0)


def test_conflict_uses_signed_gap_not_label_disagreement():
    """A positive-vs-neutral disagreement must score LOWER than positive-vs-negative:
    0.6 vs +0.5 (both non-negative) → 0.05; 0.6 vs −0.1 (opposite directions) → 0.35."""
    mild = fuse_tone(_base(0.6), [0.6, 0.1, 0.3])   # tone signed +0.5
    hard = fuse_tone(_base(0.6), [0.5, 0.6, 0.0])   # tone signed −0.1
    assert mild["sentiment_conflict"] == abs(0.6 - 0.5) / 2
    assert hard["sentiment_conflict"] == abs(0.6 - (-0.1)) / 2
    assert hard["sentiment_conflict"] > mild["sentiment_conflict"]