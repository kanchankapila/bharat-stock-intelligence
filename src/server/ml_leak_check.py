"""
Leak-Canary Test — automated look-ahead-bias check for point-in-time feature sets
===================================================================================
movement_predictor.py's own commit history documents two same-day leaks (a screener-
membership join and a news-sentiment window that weren't lagged) that were caught only by
manual review before the model shipped. This codifies that kind of check as a reusable,
runnable test instead of relying on a human noticing next time.

Method: take the feature matrix exactly as the caller prepared it (with whatever lag it
claims to already have), then shift every feature ONE MORE trading day into the past per
symbol, and re-run the caller's own OOF evaluator on both versions.

  - A properly-lagged feature set degrades gradually under one extra day of staleness --
    yesterday's slow-moving indicators (RSI, screener membership, sentiment) are almost as
    informative as today's.
  - A same-day-leaked feature drops sharply, because forcing it back one more day removes
    the future information it was never supposed to have in the first place. That
    discontinuity — not the absolute AUC — is the tell.

This is a diagnostic, not a gate: it prints a verdict and returns a dict: the caller decides
whether to fail a build on it. Expensive (re-runs the full OOF CV a second time), so wire it
behind an opt-in flag (--leak-check) rather than into every --train run.

Usage:
    from ml_leak_check import leak_canary

    def oof_fn(frame, cols):
        auc, _, _ = _purged_oof(frame, cols)   # whatever the caller's own OOF evaluator is
        return auc

    result = leak_canary(df, FEATURE_COLS, oof_fn)
    if result["suspect_leak"]:
        print("SUSPECT LEAK — investigate before trusting this feature set")
"""

from __future__ import annotations

import polars as pl
import pandas as pd


def leak_canary(
    df: pd.DataFrame,
    feature_cols: list,
    oof_fn,
    symbol_col: str = "symbol",
    date_col: str = "date",
    drop_threshold: float = 0.04,
    min_rows: int = 200,
) -> dict:
    """Returns {baseline_auc, shifted_auc, auc_drop, suspect_leak, note}."""
    present_cols = [c for c in feature_cols if c in df.columns]
    if not present_cols:
        return {"baseline_auc": None, "shifted_auc": None, "auc_drop": None,
                "suspect_leak": False, "note": "no feature columns present — skipped"}

    shifted = df.sort_values([symbol_col, date_col]).copy()
    shifted[present_cols] = shifted.groupby(symbol_col)[present_cols].shift(1)
    shifted = shifted.dropna(subset=present_cols)

    baseline_auc = oof_fn(df, feature_cols)
    if len(shifted) < min_rows:
        return {"baseline_auc": baseline_auc, "shifted_auc": None, "auc_drop": None,
                "suspect_leak": False,
                "note": f"only {len(shifted)} rows survive the extra shift — too few to test"}

    shifted_auc = oof_fn(shifted, feature_cols)

    if baseline_auc is None or shifted_auc is None:
        return {"baseline_auc": baseline_auc, "shifted_auc": shifted_auc, "auc_drop": None,
                "suspect_leak": False, "note": "one of the two OOF runs returned no AUC"}

    drop = baseline_auc - shifted_auc
    suspect = drop > drop_threshold
    note = (f"AUC dropped {drop:.4f} under one extra day of lag (threshold {drop_threshold}) — "
            f"{'SUSPECT LEAK, investigate the feature-lag joins' if suspect else 'within tolerance for a genuinely point-in-time feature set'}")
    return {"baseline_auc": baseline_auc, "shifted_auc": shifted_auc, "auc_drop": drop,
            "suspect_leak": suspect, "note": note}

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
