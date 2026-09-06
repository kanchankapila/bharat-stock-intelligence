"""walk_forward_validate must clone a model at the SOURCE model's input width.

Found 2026-09-06 while building the AF-20260906-02 leak measurement. The measurement seeds
walk_forward_validate from the active champion (lstm_v3.pt, 78 inputs -- a pre-widening
checkpoint) and it crashed before producing a number:

    RuntimeError: Error(s) in loading state_dict for BiLSTMModel:
      size mismatch for lstm1.weight_ih_l0: copying a param with shape torch.Size([1024, 78])
      from checkpoint, the shape in current model is torch.Size([1024, 85])

because the fold loop did `model_copy = BiLSTMModel()` -- the DEFAULT width, i.e. today's
N_FEATURES -- and then loaded the 78-wide source into it.

This is the SAME defect already fixed on the inference path after the 2026-08-24 feature
widening, where dl_engine's loader gained `_checkpoint_input_width` precisely because
"constructing the default-width model here used to crash every load_state_dict with a
size-mismatch RuntimeError and take down ALL deep_learning_predictions writes for as long as
the stale champion stayed active." The fix was applied there and not here.

Latent in production today: train_lstm always hands walk_forward_validate the model it just
built at N_FEATURES, so the widths match by construction. It bites any caller validating an
EXISTING champion -- which is exactly what measuring the promotion gate requires, so the gate
could not be audited without fixing this first.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch")

from dl_engine import BiLSTMModel, clone_model_like, N_FEATURES


def test_clone_preserves_a_legacy_narrower_width():
    narrow = BiLSTMModel(n_features=78)
    clone = clone_model_like(narrow)
    assert clone.lstm1.weight_ih_l0.shape[1] == 78


def test_clone_preserves_the_current_default_width():
    wide = BiLSTMModel(n_features=N_FEATURES)
    clone = clone_model_like(wide)
    assert clone.lstm1.weight_ih_l0.shape[1] == N_FEATURES


def test_clone_actually_copies_the_weights_not_just_the_shape():
    """A clone that matched shape but re-randomised weights would silently turn every
    walk-forward fold into a from-scratch fit -- which is the very thing the leak measurement
    is trying to distinguish."""
    src = BiLSTMModel(n_features=78)
    with torch.no_grad():
        src.lstm1.weight_ih_l0.fill_(0.25)
    clone = clone_model_like(src)
    assert torch.allclose(clone.lstm1.weight_ih_l0.cpu(),
                          src.lstm1.weight_ih_l0.cpu()), "weights must be carried over"


def test_clone_is_independent_of_the_source():
    """Folds mutate their copy; that must not corrupt the seed model for later folds."""
    src = BiLSTMModel(n_features=78)
    clone = clone_model_like(src)
    with torch.no_grad():
        clone.lstm1.weight_ih_l0.fill_(-1.0)
    assert not torch.allclose(clone.lstm1.weight_ih_l0.cpu(), src.lstm1.weight_ih_l0.cpu())
