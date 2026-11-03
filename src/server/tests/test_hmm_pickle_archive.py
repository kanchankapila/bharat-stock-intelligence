import os
import pickle
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
import src.server.regime_detector as regime_detector  # noqa: E402


def _stamp(path: Path, when: str) -> str:
    ts = datetime.strptime(when, "%Y%m%d_%H%M%S").timestamp()
    os.utime(path, (ts, ts))
    return when


@pytest.fixture
def paths(tmp_path, monkeypatch):
    live = tmp_path / "hmm_regime.pkl"
    monkeypatch.setattr(regime_detector, "HMM_PATH", live)
    return live


def test_promotion_archives_previous_model(paths):
    paths.write_bytes(b"old-model-bytes")
    when = _stamp(paths, "20261101_093000")
    regime_detector._write_model(paths, {"m": 1})
    archive = paths.parent / f"hmm_regime_{when}.pkl"
    assert archive.read_bytes() == b"old-model-bytes"
    assert pickle.loads(paths.read_bytes()) == {"m": 1}


def test_archive_keeps_last_12(paths):
    for day in range(1, 14):
        a = paths.parent / f"hmm_regime_202610{day:02d}_000000.pkl"
        a.write_bytes(b"x")
    paths.write_bytes(b"live")
    cand = paths.parent / "hmm_regime.pkl.candidate"
    cand.write_bytes(b"cand")
    _stamp(paths, "20261101_093000")
    regime_detector._write_model(paths, {"m": 1})
    archives = sorted(p.name for p in paths.parent.glob("hmm_regime_*.pkl"))
    assert len(archives) == 12
    assert "hmm_regime_20261001_000000.pkl" not in archives
    assert "hmm_regime_20261101_093000.pkl" in archives
    assert paths.exists() and cand.exists()


def test_first_promotion_with_no_previous_model(paths):
    regime_detector._write_model(paths, {"m": 1})
    assert pickle.loads(paths.read_bytes()) == {"m": 1}
    assert list(paths.parent.glob("hmm_regime_*.pkl")) == []


def test_rejected_candidate_does_not_archive(paths):
    paths.write_bytes(b"live")
    cand = paths.parent / "hmm_regime.pkl.candidate"
    regime_detector._write_model(cand, {"m": 2})
    assert paths.read_bytes() == b"live"
    assert list(paths.parent.glob("hmm_regime_*.pkl")) == []
