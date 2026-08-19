#!/usr/bin/env python3
"""
Live Screener Optimization Engine.
Analyzes historical live screener outcomes and trains a Decision Tree
to identify the best combinations of filters for finding high-growth stocks.
Saves the results back to app_settings.
"""

import os
import sys
import json
import datetime
import numpy as np
import pandas as pd
from db_compat import connect, read_df, execute

RETURN_COLS = ['return_1d', 'return_3d', 'return_5d', 'return_intraday']


def _build_run_matrix(df: pd.DataFrame):
    """One row per (run_id, symbol): binary filter-match columns (whichever filters matched
    IN THAT SCAN CYCLE) + the mean return across whichever filters it matched that run.

    Grouped by (run_id, symbol) -- NOT (appeared_at, symbol) as this used to be. A filter
    match persists across many consecutive ~15-min scans in one trading day (live-confirmed
    median 15 distinct runs per matching (date, symbol) pair), so the old day-level grouping
    let a "combination" (e.g. RSI_OVERSOLD + VOLUME_SURGE) count as a match whenever a stock
    matched EACH filter at ANY point that day, even hours apart. But the frontend's "Apply
    Combo" button (LiveMarketScreener.tsx's applyCombo -> getLiveMarketScreener ->
    fetchLiveMarketScreener) sends every selected filter as one simultaneous AND query to
    NiftyTrader -- it only ever returns stocks matching ALL of them AT THE SAME MOMENT, in
    the current scan. The reported win_rate/avg_return badge shown next to the "AI
    Recommendation" button was therefore measuring a materially different, easier-to-satisfy
    condition than what clicking it actually retrieves live -- the same train/serve skew
    fixed in live_screener_ml_ranker.py's _build_matrix() the same day (see
    live_screener_ml_no_live_edge_2026_08_07 memory), just surfacing here as a misleading
    user-facing number instead of a silently-bad model. Grouping by (run_id, symbol) makes a
    "combination" mean "matched within the SAME scan cycle", exactly the population
    fetchLiveMarketScreener's simultaneous-AND query draws from.

    Extracted as its own function (mirroring live_screener_ml_ranker.py's _build_matrix) so
    the grouping logic is directly unit-testable without going through the full decision-tree/
    app_settings machinery in _optimize_for_horizon.
    """
    target_df = df.groupby(['run_id', 'symbol']).agg(
        appeared_at=('appeared_at', 'first'),
        **{c: (c, 'mean') for c in RETURN_COLS},
    ).reset_index()

    # Pivot the filter occurrences (binary matrix: 1 if symbol matched filter_key IN THIS RUN, 0 otherwise)
    pivot_df = df.pivot_table(
        index=['run_id', 'symbol'],
        columns='filter_key',
        aggfunc='size',
        fill_value=0
    )
    # Clip to binary 1 or 0 (a stock can match the same filter more than once within one run
    # if the collector records it per-source; collapse to a plain matched/not-matched flag)
    pivot_df = pivot_df.clip(upper=1).reset_index()

    filter_cols = [c for c in pivot_df.columns if c not in ('run_id', 'symbol')]

    # Merge filters and target returns
    matrix = pd.merge(pivot_df, target_df, on=['run_id', 'symbol'])
    return matrix, filter_cols


def _optimize_for_horizon(df: pd.DataFrame, target_col: str, settings_key: str, fixed_horizon: bool = False):
    """Trains the decision tree / single-filter rankings for one target horizon and saves
    the result to the given app_settings key. `fixed_horizon=True` skips the 3d->1d
    fallback (used for the intraday horizon, which has no fallback column). See
    _build_run_matrix's docstring for why matches are grouped by (run_id, symbol)."""
    matrix, filter_cols = _build_run_matrix(df)

    # Determine the best target horizon to optimize for (defaulting to 3d, fallback to 1d)
    if not fixed_horizon and matrix[target_col].isnull().sum() > len(matrix) * 0.7:
        target_col = 'return_1d'

    print(f"[LiveScreenerOptimizer] Optimizing for horizon: {target_col} -> app_settings['{settings_key}']")

    # Filter out rows with null target
    resolved = matrix.dropna(subset=[target_col]).copy()
    if len(resolved) < 15:
        print(f"[LiveScreenerOptimizer] Insufficient resolved targets for {target_col} to train the tree model.")
        return

    # Chronological holdout: fit the tree on the earlier ~80% of appearances, then report
    # win_rate/avg_return/sample_count against the later ~20% only. Fitting AND grading on
    # the same rows (the previous behavior) reports in-sample performance as if it were
    # out-of-sample — this is exactly the defect live_screener_ml_ranker.py was built to
    # avoid; this function produces a distinct app_settings key still read downstream, so it
    # needs the same protection rather than being retired silently.
    resolved = resolved.sort_values('appeared_at')
    split_idx = int(len(resolved) * 0.8)
    train_data = resolved.iloc[:split_idx].copy()
    holdout_data = resolved.iloc[split_idx:].copy()
    if len(train_data) < 15 or len(holdout_data) < 5:
        print(f"[LiveScreenerOptimizer] Insufficient data for a chronological holdout split "
              f"(train={len(train_data)}, holdout={len(holdout_data)}) — skipping {target_col}.")
        return

    X = train_data[filter_cols]
    y = train_data[target_col]

    # Train a decision tree regressor to find combinations
    try:
        from sklearn.tree import DecisionTreeRegressor
        # Shallow tree to find robust, simple multi-filter combinations
        dt = DecisionTreeRegressor(max_depth=3, min_samples_leaf=min(5, len(train_data) // 4))
        dt.fit(X, y)
        
        # Extract rules/combinations from the decision tree structure
        tree = dt.tree_
        feature_names = filter_cols
        
        combinations = []
        
        def recurse(node, depth, path_rules):
            if tree.feature[node] != -2:  # non-leaf node
                name = feature_names[tree.feature[node]]
                # Left split (feature <= 0.5 -> filter inactive)
                recurse(tree.children_left[node], depth + 1, path_rules + [(name, False)])
                # Right split (feature > 0.5 -> filter active)
                recurse(tree.children_right[node], depth + 1, path_rules + [(name, True)])
            else:  # leaf node
                # We only care about combinations requiring filters to be ACTIVE (True)
                active_filters = [f for f, state in path_rules if state is True]
                if not active_filters:
                    return

                # Grade this rule on the held-out (post-split) rows only — the tree's own
                # n_node_samples/value are in-sample train statistics and must not be reported.
                mask = pd.Series(True, index=holdout_data.index)
                for f, state in path_rules:
                    mask &= (holdout_data[f] == (1 if state else 0))
                leaf_rows = holdout_data[mask]
                if len(leaf_rows) < 3:
                    return
                win_rate = float((leaf_rows[target_col] > 0).mean())
                avg_return = float(leaf_rows[target_col].mean())

                combinations.append({
                    "filters": active_filters,
                    "avg_return": round(avg_return, 4),
                    "win_rate": round(win_rate, 4),
                    "sample_count": int(len(leaf_rows)),
                })

        recurse(0, 1, [])

        # Sort combinations by average return DESC
        combinations = sorted(combinations, key=lambda x: x['avg_return'], reverse=True)

    except ImportError:
        print("[LiveScreenerOptimizer] sklearn not installed. Falling back to single-filter rankings.", file=sys.stderr)
        combinations = []

    # Calculate single filter baseline metrics on the held-out set (same reasoning as above)
    single_rankings = []
    for f in filter_cols:
        matches = holdout_data[holdout_data[f] == 1]
        if len(matches) >= 3:
            avg_ret = float(matches[target_col].mean())
            win_rate = float((matches[target_col] > 0).mean())
            single_rankings.append({
                "filter": f,
                "avg_return": round(avg_ret, 4),
                "win_rate": round(win_rate, 4),
                "sample_count": len(matches)
            })
    single_rankings = sorted(single_rankings, key=lambda x: x['avg_return'], reverse=True)
    
    # Build result JSON structure
    result = {
        "last_computed": datetime.datetime.now().isoformat(),
        "total_samples": len(train_data) + len(holdout_data),
        "holdout_samples": len(holdout_data),
        "target_horizon": target_col,
        "optimal_combinations": combinations[:10], # Top 10 combinations
        "single_filter_rankings": single_rankings[:15] # Top 15 single filters
    }
    
    # Save results to app_settings
    save_str = json.dumps(result, indent=2)
    now_str = datetime.datetime.now().isoformat()

    execute("""
        INSERT INTO app_settings (key, value, "updatedAt")
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"
    """, (settings_key, save_str, now_str))

    print(f"[LiveScreenerOptimizer] Optimization complete for {settings_key}.")
    if combinations:
        print(f"Top Combination: {combinations[0]['filters']} (Avg Return: {combinations[0]['avg_return']}%, Win Rate: {combinations[0]['win_rate']*100}%, Samples: {combinations[0]['sample_count']})")
    elif single_rankings:
        print(f"Top Single Filter: {single_rankings[0]['filter']} (Avg Return: {single_rankings[0]['avg_return']}%, Win Rate: {single_rankings[0]['win_rate']*100}%)")


def optimize_combinations():
    """Loads live_screener_outcomes once and trains two isolated models: the existing
    swing-horizon model (3d, falling back to 1d) and a same-day intraday model, saved
    to separate app_settings keys so the intraday UI never mixes with the swing one."""
    print(f"[LiveScreenerOptimizer] Starting optimization run at {datetime.datetime.now()}")

    q = """
        SELECT o.appearance_id, o.symbol, o.filter_key, o.appeared_at, o.entry_price,
               a.run_id,
               o.return_1d, o.return_3d, o.return_5d, o.return_intraday
        FROM live_screener_outcomes o
        JOIN live_screener_appearances a ON a.id = o.appearance_id
        WHERE o.return_1d IS NOT NULL OR o.return_3d IS NOT NULL OR o.return_5d IS NOT NULL
           OR o.return_intraday IS NOT NULL
    """
    df = read_df(q)

    if df.empty or len(df) < 20:
        print(f"[LiveScreenerOptimizer] Insufficient data ({len(df)} records found). Needs at least 20 records to optimize.")
        return

    print(f"[LiveScreenerOptimizer] Loaded {len(df)} historical appearances.")

    _optimize_for_horizon(df, 'return_3d', 'live_screener_optimal_combinations')
    _optimize_for_horizon(df, 'return_intraday', 'live_screener_optimal_combinations_intraday', fixed_horizon=True)


if __name__ == '__main__':
    optimize_combinations()
