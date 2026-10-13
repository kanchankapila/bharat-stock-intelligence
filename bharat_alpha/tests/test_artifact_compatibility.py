import json

import joblib
import pytest

from bharat_alpha.modeling.train import ModelBundle, artifact_runtime, dump_bundle, load_bundle


def _bundle():
    return ModelBundle(
        horizon=5,
        feature_cols=[],
        members=[],
        weights={},
        calib_excess=None,
        calib_prob=None,
        abs_residuals=[],
    )


def test_bundle_round_trip_requires_matching_runtime_manifest(tmp_path):
    path = tmp_path / "model.joblib"
    dump_bundle(_bundle(), path)

    loaded = load_bundle(str(path))
    assert loaded.artifact_runtime == artifact_runtime()


def test_sklearn_mismatch_is_rejected_before_unpickle(tmp_path, monkeypatch):
    path = tmp_path / "model.joblib"
    dump_bundle(_bundle(), path)
    sidecar = path.with_suffix(path.suffix + ".runtime.json")
    recorded = json.loads(sidecar.read_text(encoding="utf-8"))
    recorded["sklearn"] = "9.9.9"
    sidecar.write_text(json.dumps(recorded), encoding="utf-8")

    def must_not_unpickle(*_args, **_kwargs):
        raise AssertionError("joblib.load must not run for an incompatible artifact")

    monkeypatch.setattr(joblib, "load", must_not_unpickle)
    with pytest.raises(RuntimeError, match="requires scikit-learn 9.9.9"):
        load_bundle(str(path))


def test_legacy_artifact_without_manifest_is_rejected(tmp_path):
    path = tmp_path / "legacy.joblib"
    joblib.dump(_bundle(), path)

    with pytest.raises(RuntimeError, match="has no runtime manifest"):
        load_bundle(str(path))
