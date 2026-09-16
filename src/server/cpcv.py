"""Combinatorial Purged Cross-Validation (CPCV).

An alternative to standard k-fold and purged time-series CV that generates
multiple train/test paths by combinatorially sampling test sets.

Reference: López de Prado, "Advances in Financial Machine Learning" (2018),
Chapter 12.
"""
from __future__ import annotations
import numpy as np
from itertools import combinations
from typing import Generator, Optional


def cpcv_split(
    n_samples: int,
    n_splits: int = 6,
    test_size: float = 0.2,
    purge: int = 1,
    embargo: int = 1,
    seed: Optional[int] = None,
) -> Generator[tuple[np.ndarray, np.ndarray], None, None]:
    """Generate Combinatorial Purged Cross-Validation splits.

    Instead of a single path (like TimeSeriesSplit), CPCV generates multiple
    paths by combinatorially sampling test sets from the data. This provides
    more robust performance estimates and reduces overfitting to a single
    train/test split.

    Args:
        n_samples: Total number of samples
        n_splits: Number of splits (must be >= 2)
        test_size: Fraction of samples to use as test set
        purge: Number of samples to purge between train and test
        embargo: Number of samples to embargo after test
        seed: Random seed for reproducibility

    Yields:
        Tuple of (train_indices, test_indices) as numpy arrays
    """
    if n_splits < 2:
        raise ValueError("n_splits must be >= 2")
    if test_size <= 0 or test_size >= 1:
        raise ValueError("test_size must be between 0 and 1")

    rng = np.random.RandomState(seed)
    indices = np.arange(n_samples)

    # Calculate test set size
    n_test = max(1, int(n_samples * test_size))
    n_train = n_samples - n_test

    # Generate all possible test set combinations
    # For large n_splits, we sample a subset
    max_combinations = _ncr(n_train + n_test, n_test)
    if max_combinations > 1000:
        # Sample random test sets
        test_sets = [_random_test_set(n_samples, n_test, rng) for _ in range(n_splits)]
    else:
        # Use all combinations
        test_sets = list(combinations(range(n_samples), n_test))
        if len(test_sets) > n_splits:
            rng.shuffle(test_sets)
            test_sets = test_sets[:n_splits]

    for test_idx in test_sets:
        test_idx = np.array(test_idx)
        train_idx = _purge_and_embargo(indices, test_idx, purge, embargo)
        if len(train_idx) > 0:
            yield train_idx, test_idx


def _random_test_set(n_samples: int, n_test: int, rng: np.random.RandomState) -> tuple:
    """Generate a random test set."""
    return tuple(sorted(rng.choice(n_samples, size=n_test, replace=False)))


def _purge_and_embargo(
    indices: np.ndarray,
    test_idx: np.ndarray,
    purge: int,
    embargo: int,
) -> np.ndarray:
    """Remove purged and embargoed indices from the training set."""
    test_min = test_idx.min()
    test_max = test_idx.max()

    # Purge: remove samples within `purge` distance of test set
    purge_mask = np.ones(len(indices), dtype=bool)
    for t in test_idx:
        purge_mask &= (np.abs(indices - t) > purge)

    # Embargo: remove samples after test set within `embargo` distance
    embargo_mask = indices <= test_max + embargo

    # Combine masks
    valid = purge_mask & embargo_mask
    return indices[valid]


def _ncr(n: int, r: int) -> int:
    """Calculate n choose r."""
    if r > n:
        return 0
    if r == 0 or r == n:
        return 1
    r = min(r, n - r)
    result = 1
    for i in range(1, r + 1):
        result = result * (n - r + i) // i
    return result
