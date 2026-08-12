#!/usr/bin/env python3
"""
Screener Optimization Engine: Persistence Streaks & Regime-Aware Weighting
Computes multi-screener streak scores and adjusts screener category weights
based on prevailing market volatility (VIX) and institutional flow regimes.
"""

import logging
import pandas as pd
import numpy as np

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger("ScreenerOptimizationEngine")

def compute_regime_weights(base_weights: dict, vix: float, fii_net_flow: float) -> dict:
    """
    Adjusts screener category weights dynamically based on market regime.
    - High VIX (> 25) or heavy FII outflow (< -3000 Cr): Upweight Quality/Defensive, downweight Momentum/Breakout.
    - Low VIX (< 18) and positive FII inflow: Upweight Momentum/Breakout.
    """
    adjusted = base_weights.copy()
    risk_off = vix > 25.0 or fii_net_flow < -3000.0
    
    if risk_off:
        logger.info(f"[REGIME] Risk-Off Regime detected (VIX: {vix}, FII Net: {fii_net_flow}). Upweighting Quality/Defensive.")
        adjusted['breakout'] = adjusted.get('breakout', 1.0) * 0.5
        adjusted['momentum'] = adjusted.get('momentum', 1.0) * 0.6
        adjusted['quality'] = adjusted.get('quality', 1.0) * 1.5
        adjusted['valuation'] = adjusted.get('valuation', 1.0) * 1.3
    else:
        logger.info(f"[REGIME] Risk-On Regime detected (VIX: {vix}, FII Net: {fii_net_flow}). Upweighting Momentum/Breakout.")
        adjusted['breakout'] = adjusted.get('breakout', 1.0) * 1.3
        adjusted['momentum'] = adjusted.get('momentum', 1.0) * 1.3
        adjusted['quality'] = adjusted.get('quality', 1.0) * 0.9
        
    return adjusted

def compute_persistence_streaks(appearances_df: pd.DataFrame) -> pd.DataFrame:
    """
    Computes multi-screener persistence streaks over a 5-day window.
    appearances_df columns: ['symbol', 'screener_id', 'appeared_date', 'reliability_score']
    """
    logger.info("Computing multi-screener persistence streak scores...")
    if appearances_df.empty:
        return pd.DataFrame(columns=['symbol', 'streak_score'])
        
    # Group by symbol and sum reliability across recent appearances
    streaks = appearances_df.groupby('symbol').agg(
        screener_count=('screener_id', 'nunique'),
        total_appearances=('screener_id', 'count'),
        cumulative_reliability=('reliability_score', 'sum')
    ).reset_index()
    
    streaks['streak_score'] = streaks['screener_count'] * streaks['cumulative_reliability']
    return streaks.sort_values(by='streak_score', ascending=False)

if __name__ == "__main__":
    test_weights = {'momentum': 1.0, 'breakout': 1.0, 'quality': 1.0, 'valuation': 1.0}
    print("Risk-On Weights:", compute_regime_weights(test_weights, 15.0, 2000.0))
    print("Risk-Off Weights:", compute_regime_weights(test_weights, 28.0, -4500.0))
