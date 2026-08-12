#!/usr/bin/env python3
"""
MarketsMojo Factor Decomposition Engine
Decomposes raw MarketsMojo scores (Quality, Valuation, Financial Trend, Technical)
into orthogonal alpha factors to prevent collinear noise in the unified ranker.
"""

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
