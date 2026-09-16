import sys
sys.path.insert(0, "src/server")
import numpy as np
from cpcv import cpcv_split, _ncr


def test_ncr():
    assert _ncr(5, 2) == 10
    assert _ncr(10, 3) == 120
    assert _ncr(5, 0) == 1
    assert _ncr(5, 5) == 1


def test_cpcv_basic():
    splits = list(cpcv_split(n_samples=100, n_splits=4, test_size=0.2, purge=1, embargo=1, seed=42))
    assert len(splits) > 0
    for train_idx, test_idx in splits:
        assert len(train_idx) > 0
        assert len(test_idx) > 0
        # No overlap
        assert len(np.intersect1d(train_idx, test_idx)) == 0


def test_cpcv_purge_respected():
    splits = list(cpcv_split(n_samples=50, n_splits=3, test_size=0.2, purge=2, embargo=0, seed=42))
    for train_idx, test_idx in splits:
        for t in test_idx:
            for tr in train_idx:
                assert abs(tr - t) > 2, f"Purge violated: train={tr}, test={t}"


def test_cpcv_embargo_respected():
    splits = list(cpcv_split(n_samples=50, n_splits=3, test_size=0.2, purge=0, embargo=2, seed=42))
    for train_idx, test_idx in splits:
        test_max = test_idx.max()
        for tr in train_idx:
            assert tr <= test_max + 2, f"Embargo violated: train={tr}, test_max={test_max}"


def test_cpcv_invalid_inputs():
    try:
        list(cpcv_split(n_samples=10, n_splits=1))
        assert False, "Should have raised ValueError"
    except ValueError:
        pass
    try:
        list(cpcv_split(n_samples=10, test_size=0))
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


if __name__ == "__main__":
    test_ncr()
    test_cpcv_basic()
    test_cpcv_purge_respected()
    test_cpcv_embargo_respected()
    test_cpcv_invalid_inputs()
    print("All CPCV tests passed")
