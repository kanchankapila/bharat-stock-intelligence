#!/usr/bin/env python3
"""
MarketsMojo Factor Decomposition Engine
Decomposes raw MarketsMojo scores (Quality, Valuation, Financial Trend, Technical)
into orthogonal alpha factors to prevent collinear noise in the unified ranker.

UNWIRED, UNMEASURED (2026-08-12): not imported by unified_ranker.py or called from anywhere,
despite this module's own log line claiming "Orthogonalized features ready for unified
ranker." Orthogonalizing a factor against another is not free here -- see
.claude/rules/measurement.md's "Sector-neutralising a factor DESTROYS it here": residualizing
value against sector on this same data cost ~45% of the raw factor's edge rather than
purifying it, the opposite of the published US result this kind of decomposition usually
relies on. Also note the raw `ext_mojo_*` inputs are 88% one-shot-backfilled MarketsMojo data
(measurement.md, "A one-shot vendor backfill is not an observed history") -- run this through
factor_backtest.py against the raw (non-orthogonalized) MarketsMojo scores before wiring in,
not just assume decomposition helps. verify-gate.mjs blocks a diff wiring this into
unified_ranker.py without backtest evidence in the same session.
"""

import polars as pl
import logging
import pandas as pd
import numpy as np

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("MojoFactorDecomposition")

def decompose_mojo_factors(df: pd.DataFrame) -> pd.DataFrame:
    """
    Takes a DataFrame containing raw MarketsMojo columns:
    - ext_mojo_quality_rank
    - ext_mojo_valuation_rank
    - ext_mojo_financial_pts
    - technical momentum score
    Performs orthogonalization (Z-score standardisation + cross-sectional residualisation).
    """
    logger.info("Starting MarketsMojo Factor Decomposition & Orthogonalization...")
    
    required_cols = ['ext_mojo_quality_rank', 'ext_mojo_valuation_rank', 'ext_mojo_financial_pts']
    for col in required_cols:
        if col not in df.columns:
            df[col] = np.nan
            
    # Fill NA with median
    for col in required_cols:
        df[col] = df[col].fillna(df[col].median())
        
    # Standardize factors
    for col in required_cols:
        mean_val = df[col].mean()
        std_val = df[col].std()
        if std_val > 0:
            df[f"{col}_z"] = (df[col] - mean_val) / std_val
        else:
            df[f"{col}_z"] = 0.0
            
    # Orthogonalize Valuation against Quality (residualize value from quality)
    if 'ext_mojo_quality_rank_z' in df.columns and 'ext_mojo_valuation_rank_z' in df.columns:
        cov = np.cov(df['ext_mojo_quality_rank_z'], df['ext_mojo_valuation_rank_z'])[0, 1]
        var = np.var(df['ext_mojo_quality_rank_z'])
        beta = cov / var if var > 0 else 0.0
        df['mojo_valuation_orthogonal_z'] = df['ext_mojo_valuation_rank_z'] - (beta * df['ext_mojo_quality_rank_z'])
    else:
        df['mojo_valuation_orthogonal_z'] = df.get('ext_mojo_valuation_rank_z', 0.0)
        
    logger.info("Factor decomposition completed successfully. Orthogonalized features ready for unified ranker.")
    return df

if __name__ == "__main__":
    # Test with dummy data
    sample_data = pd.DataFrame({
        'symbol': ['RELIANCE', 'TCS', 'HDFCBANK'],
        'ext_mojo_quality_rank': [85.0, 92.0, 78.0],
        'ext_mojo_valuation_rank': [45.0, 60.0, 50.0],
        'ext_mojo_financial_pts': [90.0, 88.0, 82.0]
    })
    res = decompose_mojo_factors(sample_data)
    print(res[['symbol', 'mojo_valuation_orthogonal_z']])

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
