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

def optimize_combinations():
    print(f"[LiveScreenerOptimizer] Starting optimization run at {datetime.datetime.now()}")
    
    # Load historical outcomes from live_screener_outcomes
    q = """
        SELECT appearance_id, symbol, filter_key, appeared_at, entry_price, return_1d, return_3d, return_5d
        FROM live_screener_outcomes
        WHERE return_1d IS NOT NULL OR return_3d IS NOT NULL OR return_5d IS NOT NULL
    """
    df = read_df(q)
    
    if df.empty or len(df) < 20:
        print(f"[LiveScreenerOptimizer] Insufficient data ({len(df)} records found). Needs at least 20 records to optimize.")
        return
        
    print(f"[LiveScreenerOptimizer] Loaded {len(df)} historical appearances.")
    
    # Group target returns by date and symbol (in case a stock appeared in multiple filters on the same day)
    target_df = df.groupby(['appeared_at', 'symbol'])[['return_1d', 'return_3d', 'return_5d']].mean().reset_index()
    
    # Pivot the filter occurrences (binary matrix: 1 if symbol matched filter_key on appeared_at, 0 otherwise)
    pivot_df = df.pivot_table(
        index=['appeared_at', 'symbol'],
        columns='filter_key',
        aggfunc='size',
        fill_value=0
    )
    # Clip to binary 1 or 0 (if a stock appeared multiple times in 15m intervals for same filter on same day)
    pivot_df = pivot_df.clip(upper=1).reset_index()
    
    # Merge filters and target returns
    matrix = pd.merge(pivot_df, target_df, on=['appeared_at', 'symbol'])
    
    # Determine the best target horizon to optimize for (defaulting to 3d, fallback to 1d)
    target_col = 'return_3d'
    if matrix[target_col].isnull().sum() > len(matrix) * 0.7:
        target_col = 'return_1d'
        
    print(f"[LiveScreenerOptimizer] Optimizing for horizon: {target_col}")
    
    # Filter out rows with null target
    train_data = matrix.dropna(subset=[target_col]).copy()
    if len(train_data) < 15:
        print("[LiveScreenerOptimizer] Insufficient resolved targets to train the tree model.")
        return
        
    filter_cols = [c for c in pivot_df.columns if c not in ['appeared_at', 'symbol']]
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
                samples = tree.n_node_samples[node]
                value = tree.value[node][0][0]
                
                # We only care about combinations requiring filters to be ACTIVE (True)
                active_filters = [f for f, state in path_rules if state is True]
                
                if active_filters and samples >= 3:
                    # Calculate win rate for this leaf
                    # Get index of rows matching path rules
                    mask = pd.Series(True, index=train_data.index)
                    for f, state in path_rules:
                        mask &= (train_data[f] == (1 if state else 0))
                    leaf_rows = train_data[mask]
                    win_rate = float((leaf_rows[target_col] > 0).mean()) if len(leaf_rows) > 0 else 0.0
                    
                    combinations.append({
                        "filters": active_filters,
                        "avg_return": round(float(value), 4),
                        "win_rate": round(win_rate, 4),
                        "sample_count": int(samples)
                    })
                    
        recurse(0, 1, [])
        
        # Sort combinations by average return DESC
        combinations = sorted(combinations, key=lambda x: x['avg_return'], reverse=True)
        
    except ImportError:
        print("[LiveScreenerOptimizer] sklearn not installed. Falling back to single-filter rankings.")
        combinations = []
        
    # Calculate single filter baseline metrics as fallback/supplement
    single_rankings = []
    for f in filter_cols:
        matches = train_data[train_data[f] == 1]
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
        "total_samples": len(train_data),
        "target_horizon": target_col,
        "optimal_combinations": combinations[:10], # Top 10 combinations
        "single_filter_rankings": single_rankings[:15] # Top 15 single filters
    }
    
    # Save results to app_settings key 'live_screener_optimal_combinations'
    save_str = json.dumps(result, indent=2)
    now_str = datetime.datetime.now().isoformat()
    
    execute("""
        INSERT INTO app_settings (key, value, "updatedAt")
        VALUES ('live_screener_optimal_combinations', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"
    """, (save_str, now_str))
    
    print("[LiveScreenerOptimizer] Optimization complete. Top results saved to app_settings.")
    if combinations:
        print(f"Top Combination: {combinations[0]['filters']} (Avg Return: {combinations[0]['avg_return']}%, Win Rate: {combinations[0]['win_rate']*100}%, Samples: {combinations[0]['sample_count']})")
    elif single_rankings:
        print(f"Top Single Filter: {single_rankings[0]['filter']} (Avg Return: {single_rankings[0]['avg_return']}%, Win Rate: {single_rankings[0]['win_rate']*100}%)")

if __name__ == '__main__':
    optimize_combinations()
