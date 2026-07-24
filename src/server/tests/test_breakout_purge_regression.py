"""
Regression test for the exact leak class breakout_classifier.py's own comments warn about:
"the label looks forward `horizon` trading days, and each date holds ~many rows, so a
row-based gap leaves the forward-label windows of adjacent folds massively overlapping ->
leakage -> a fantasy AUC" (an earlier version of this pattern produced a 0.73 AUC that was
really 0.61 once fixed -- entirely a purging artifact).

Builds a synthetic cross-sectional dataset with a genuinely forward-looking, block-shared
label (the kind of autocorrelated-over-`horizon`-days structure real forward returns have),
then compares:
  (a) evaluate_purged_cv() -- the real, production date-purged+embargo CV.
  (b) a deliberately naive row-index-gap split (TimeSeriesSplit-style, ignoring how many
      rows each date holds) -- the exact class of bug this codebase already found and fixed.

With many symbols per date, a fixed row-index gap of EMBARGO rows spans only a small
fraction of one date -- nowhere near an EMBARGO-*day* gap -- so naive row-purging leaves
same-"shared-signal-block" rows in both train and validation, inflating AUC. Proper
date+embargo purging keeps blocks separated. Asserting a real, sustained gap between the two
numbers is the canary: if production's date-purged AUC ever drifts up toward the naive
row-purged number, investigate whether the purge logic regressed toward row-based purging.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from breakout_classifier import evaluate_purged_cv, _feature_matrix, _make_model, EMBARGO, FEATURE_COLS


def _make_block_leak_dataset(n_symbols: int = 50, n_dates: int = 200, seed: int = 0) -> pd.DataFrame:
    """A cross-sectional dataset whose label is an i.i.d. coin flip PER BLOCK (length=HORIZON
    dates), and whose one informative feature reveals which block a row belongs to (a random
    real-valued block "ID" -- NOT smoothly/monotonically related to the label). Block ID and
    block label are drawn independently, so there is no generalizable feature->label rule a
    model could learn across blocks -- the only way to score above chance on a block is to
    have seen actual training rows FROM THAT SAME BLOCK (memorization via row overlap).

    This isolates exactly the temporal-adjacency mechanism breakout_classifier.py's own
    comments describe: with many rows per date, a row-index-gap purge doesn't actually
    separate train/validation by enough DATES to keep them in different blocks, so naive
    row-purging ends up validating on (partially) the same block it trained on -- while a
    correct date+embargo purge (embargo == block length here) guarantees validation blocks
    were never seen in training.
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2020-01-01", periods=n_dates).strftime("%Y-%m-%d").tolist()
    block_len = EMBARGO  # HORIZON == EMBARGO in breakout_classifier
    n_blocks = int(np.ceil(n_dates / block_len))
    block_id = rng.normal(0, 1, size=n_blocks)          # random "identity" of each block
    block_label = rng.integers(0, 2, size=n_blocks)     # i.i.d., independent of block_id

    rows = []
    for date_idx, date in enumerate(dates):
        block = date_idx // block_len
        for sym_idx in range(n_symbols):
            row = {"date": date, "symbol": f"SYM{sym_idx:04d}"}
            for col in FEATURE_COLS:
                row[col] = float(rng.normal(0, 1))
            # the informative feature: reveals block identity (memorizable), not a
            # generalizable signal -- block_id carries no information about block_label
            row[FEATURE_COLS[0]] = float(block_id[block] + rng.normal(0, 0.05))
            row["flew"] = int(block_label[block])
            rows.append(row)
    return pd.DataFrame(rows)


def _naive_row_purged_auc(df: pd.DataFrame, embargo: int = EMBARGO, n_folds: int = 4) -> float:
    """Deliberately wrong: purges by a fixed ROW-INDEX gap, ignoring how many rows each date
    holds -- the exact pre-fix bug class (TimeSeriesSplit(gap=N) on row-sorted-by-date data)."""
    from sklearn.metrics import roc_auc_score

    df = df.sort_values("date").reset_index(drop=True)
    y = df["flew"].astype(int)
    X = _feature_matrix(df)
    spw = (1 - y.mean()) / max(y.mean(), 1e-6)
    n = len(df)
    block = max(1, (n - embargo) // (n_folds + 1))
    oof = np.full(n, np.nan)
    for i in range(1, n_folds + 1):
        train_end = block * i
        val_start = train_end + embargo  # ROW gap, not a date gap
        val_end = val_start + block
        if val_start >= n or train_end < 1:
            continue
        tr = np.zeros(n, dtype=bool)
        tr[:train_end] = True
        va = np.zeros(n, dtype=bool)
        va[val_start:min(val_end, n)] = True
        if tr.sum() < 200 or va.sum() < 50 or len(set(y[tr])) < 2:
            continue
        m = _make_model(spw)
        m.fit(X[tr], y[tr])
        oof[va] = m.predict_proba(X[va])[:, 1]
    mask = ~np.isnan(oof)
    assert mask.sum() >= 50 and len(set(y[mask])) >= 2, "synthetic dataset too small for this test"
    return float(roc_auc_score(y[mask], oof[mask]))


# More, narrower folds than production's default (4) so each fold's validation window is
# comparable in width to one label block (EMBARGO=10 dates) -- this is what makes the
# row-vs-date purge difference show up reliably on a dataset sized for a fast unit test
# (production runs against ~5 years of daily data, where this ratio holds naturally with
# n_folds=4; a small synthetic dataset needs more folds to reproduce the same ratio).
N_FOLDS = 15


def test_row_purge_inflates_auc_relative_to_date_purge_on_block_leak_data():
    df = _make_block_leak_dataset()

    date_purged = evaluate_purged_cv(df, n_folds=N_FOLDS)
    assert date_purged["trained"], "synthetic dataset failed evaluate_purged_cv's minimum-row checks"
    date_purged_auc = date_purged["auc"]

    row_purged_auc = _naive_row_purged_auc(df, n_folds=N_FOLDS)

    assert row_purged_auc - date_purged_auc > 0.05, (
        f"expected naive row-index-gap purging to score meaningfully higher than proper "
        f"date+embargo purging on this block-leak synthetic data (row={row_purged_auc:.3f}, "
        f"date={date_purged_auc:.3f}). If this gap has shrunk or vanished, investigate "
        f"whether evaluate_purged_cv's date-purge logic regressed toward row-based purging "
        f"-- this is exactly the leak class that once inflated a real 0.61 AUC into a "
        f"fantasy 0.73 in this codebase."
    )


def test_date_purged_auc_is_not_itself_inflated():
    """Sanity bound on the honest number: proper purging keeps validation blocks entirely
    unseen during training (block_id and block_label are independent by construction), so
    the honest AUC should sit close to chance -- nowhere near what row-purge achieves via
    memorization."""
    df = _make_block_leak_dataset()
    date_purged = evaluate_purged_cv(df, n_folds=N_FOLDS)
    assert date_purged["trained"]
    assert date_purged["auc"] < 0.65
