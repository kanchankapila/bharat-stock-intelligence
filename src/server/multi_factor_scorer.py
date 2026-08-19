#!/usr/bin/env python3
"""
Multi-Factor Alpha Scorer
==========================
Computes a 5-factor composite alpha score (0-100) for every NSE stock
and writes component + composite scores to quant_scores.

Factors:
  1. Quality     (25%): Piotroski F-score, ROE, inverse D/E
  2. Momentum    (30%): 12M-minus-1M return (Jegadeesh-Titman, skips last month
                        to avoid short-term reversal bias)
  3. Value       (20%): Earnings yield, inverse P/B, inverse D/E
  4. Risk-Adj    (15%): Sharpe rank + Sortino rank − Beta penalty (penalizes high-beta)
  5. Macro       (10%): FII 5d net direction + PMI expansion/contraction + repo direction

All factor scores are cross-sectional percentile ranks (0-100) within the
current universe so scores are scale-invariant and rebalance to the live market.

This is a COMPONENT INPUT to unified_ranker.py — not a standalone final score.
Consistent with CLAUDE.md governance: "do not add a fourth score producer."

Usage:
  python multi_factor_scorer.py             # run all symbols
  python multi_factor_scorer.py --test      # validate on 10 symbols
  python multi_factor_scorer.py --force     # recompute even if run today
"""

import argparse
import datetime
from typing import Optional

import numpy as np
import pandas as pd

from db_compat import connect, read_df, query_one, query_all
import sys


# ── Weight scheme ──────────────────────────────────────────────────────────────
FACTOR_WEIGHTS = {
    "quality":   0.25,
    "momentum":  0.30,
    "value":     0.20,
    "risk_adj":  0.15,
    "macro":     0.10,
}

MIN_UNIVERSE   = 20   # skip run if fewer stocks have enough data


# ── Percentile rank helper ─────────────────────────────────────────────────────

def _pct_rank(series: pd.Series, higher_is_better: bool = True) -> pd.Series:
    """Cross-sectional percentile rank 0-100. Ties → average rank.

    Found live 2026-08-17: `series.map(ranked)` looks up each of `series`'s VALUES as a key
    into `ranked`'s INDEX -- but `ranked` is indexed by symbol (same index as `series`, minus
    the dropped-NaN rows), not by the raw factor value. A stock's ROE (e.g. 15.3) is never
    equal to a stock symbol string, so the lookup missed on virtually every row and the
    `.fillna(50.0)` silently masked it -- every factor for every one of 2,424 symbols came back
    exactly the neutral default, composite pinned at 49.0 with zero variance across the whole
    universe, indistinguishable from a healthy run (rows populated, `last_computed` fresh) at a
    glance. `ranked` is already indexed by symbol, so a plain reindex is all this needs.
    """
    valid = series.dropna()
    if valid.empty:
        return pd.Series(np.nan, index=series.index)
    ranked = valid.rank(pct=True, ascending=higher_is_better) * 100
    return ranked.reindex(series.index).fillna(50.0)   # missing → median (neutral)


# ── Factor builders ────────────────────────────────────────────────────────────

def _build_quality(df: pd.DataFrame) -> pd.Series:
    """
    Quality factor: Piotroski F-score (0-9) + ROE + inverse D/E.
    Each sub-score is ranked and averaged with equal weight.
    """
    piot  = _pct_rank(df.get("piotroski_f_score", pd.Series(dtype=float, name="x")), True)
    roe   = _pct_rank(df.get("return_on_equity",  pd.Series(dtype=float, name="x")), True)
    # D/E: lower is better; avoid div-by-zero with clip
    de    = _pct_rank(df.get("debt_to_equity",    pd.Series(dtype=float, name="x")), False)

    for s in (piot, roe, de):
        s.index = df.index

    return (piot + roe + de) / 3.0


def _build_momentum(df: pd.DataFrame) -> pd.Series:
    """
    Momentum: 12M-minus-1M return (Jegadeesh-Titman skip-1-month momentum).
    Avoids short-term reversal by excluding the most recent month's return.
    """
    r12m = df.get("return_12m", pd.Series(dtype=float, name="x"))
    r1m  = df.get("return_1m",  pd.Series(dtype=float, name="x"))
    r12m.index = df.index
    r1m.index  = df.index
    jt = r12m.fillna(0) - r1m.fillna(0)
    return _pct_rank(jt, higher_is_better=True)


def _build_value(df: pd.DataFrame) -> pd.Series:
    """
    Value: earnings yield (1/PE) + inverse P/B + ROE as earnings quality proxy.
    Low P/E + low P/B + high ROE = classic deep value. Non-positive PE/PB (loss-making
    company or negative book value) is treated as missing, not clamped to a small
    positive floor -- clamping-then-inverting made a loss-making company's earnings
    yield look like the BEST in the universe (1/0.1 = 10) instead of undefined.
    """
    pe  = df.get("trailing_pe", pd.Series(dtype=float, name="x"))
    pb  = df.get("price_to_book", pd.Series(dtype=float, name="x"))

    pe.index = df.index
    pb.index = df.index
    pe = pe.where(pe > 0)
    pb = pb.where(pb > 0)

    ey  = _pct_rank(1.0 / pe, higher_is_better=True)   # earnings yield
    pbr = _pct_rank(pb, higher_is_better=False)          # low P/B = cheap

    return (ey + pbr) / 2.0


def _build_risk_adj(df: pd.DataFrame) -> pd.Series:
    """
    Risk-adjusted: Sharpe + Sortino, penalised for high Beta.
    High Sharpe/Sortino + low Beta = ideal risk-adjusted holding.
    """
    sharpe  = _pct_rank(df.get("sharpe_ratio",   pd.Series(dtype=float, name="x")), True)
    sortino = _pct_rank(df.get("sortino_ratio",  pd.Series(dtype=float, name="x")), True)
    beta    = _pct_rank(df.get("beta_1y",         pd.Series(dtype=float, name="x")), False)  # low beta = better

    for s in (sharpe, sortino, beta):
        s.index = df.index

    return (sharpe * 0.4 + sortino * 0.4 + beta * 0.2)


def _build_macro(df: pd.DataFrame, macro_state: dict) -> pd.Series:
    """
    Macro factor: all stocks get the same macro tilt depending on regime.
    FII net flow direction (+/-), PMI expansion/contraction, repo rate direction.
    Returns a scalar that is uniform across the universe (acts as a regime overlay),
    mapped to percentile-equivalent space (50 = neutral, 0-100 range).
    """
    score = 50.0   # start neutral

    # FII 5d net
    fii_net = macro_state.get("fii_5d_net", 0.0)
    if fii_net > 2000:         score += 15   # strong FII buying
    elif fii_net > 500:        score += 8
    elif fii_net < -2000:      score -= 15
    elif fii_net < -500:       score -= 8

    # PMI
    pmi = macro_state.get("pmi", None)
    if pmi is not None:
        if pmi > 55:           score += 10
        elif pmi > 50:         score += 5
        elif pmi < 50:         score -= 10

    # Repo rate direction (Rising rates → headwind for growth, slight drag)
    repo_chg = macro_state.get("repo_chg", 0.0)
    if repo_chg > 0:           score -= 8
    elif repo_chg < 0:         score += 8

    score = max(0.0, min(100.0, score))
    # Broadcast to all stocks — macro is universe-level, not stock-level
    return pd.Series(score, index=df.index)


# ── Macro state loader ─────────────────────────────────────────────────────────

def _load_macro_state() -> dict:
    """
    Load current macro state for the macro factor.
    Returns {fii_5d_net, pmi, repo_chg}.
    """
    state: dict = {"fii_5d_net": 0.0, "pmi": None, "repo_chg": 0.0}

    try:
        # FII 5-day net (Cr)
        rows = query_all(
            "SELECT fii_net FROM fii_dii_flow ORDER BY date DESC LIMIT 5"
        )
        if rows:
            state["fii_5d_net"] = sum(float(r[0] or 0) for r in rows)
    except Exception as e:
        print(f"[MULTI_FACTOR] fii_5d_net load failed, defaulting to 0.0 (neutral): {e}", file=sys.stderr)

    try:
        # Latest manufacturing PMI
        row = query_one(
            "SELECT close FROM macro_asset_prices WHERE symbol='INDIA_MFG_PMI' "
            "ORDER BY date DESC LIMIT 1"
        )
        if row and row[0]:
            state["pmi"] = float(row[0])
    except Exception as e:
        print(f"[MULTI_FACTOR] pmi load failed, defaulting to None: {e}", file=sys.stderr)

    try:
        # Repo rate change: compare last 2 readings
        rows = query_all(
            "SELECT close FROM macro_asset_prices WHERE symbol='RBI_REPO_RATE' "
            "ORDER BY date DESC LIMIT 2"
        )
        if len(rows) >= 2:
            state["repo_chg"] = float(rows[0][0] or 0) - float(rows[1][0] or 0)
    except Exception as e:
        print(f"[MULTI_FACTOR] repo_chg load failed, defaulting to 0.0 (neutral): {e}", file=sys.stderr)

    return state


# ── Main runner ────────────────────────────────────────────────────────────────

def run(symbol: Optional[str] = None, force: bool = False, test: bool = False) -> dict:
    """
    Compute multi-factor scores and write to quant_scores.
    Returns summary dict.
    """
    today = datetime.date.today().isoformat()
    print(f"[MultiFactor] Starting - {today}")

    # --- Load quant_scores as universe ---
    q_cols = [
        "symbol", "return_1m", "return_3m", "return_6m", "return_12m",
        "trailing_pe", "return_on_equity", "debt_to_equity",
        "piotroski_f_score", "sharpe_ratio", "sortino_ratio", "beta_1y",
        "annualized_vol", "max_drawdown_1y", "ohlcv_days",
    ]

    col_list = ", ".join(q_cols)
    df = read_df(f"SELECT {col_list} FROM quant_scores WHERE ohlcv_days >= 63", ())

    if df.empty or len(df) < MIN_UNIVERSE:
        print(f"[MultiFactor] Insufficient universe ({len(df)} stocks). Skipping.")
        return {"processed": 0, "skipped": len(df), "errors": 0}

    # Supplementary: price_to_book from stock_fundamentals (not in quant_scores yet)
    try:
        pb_df = read_df("SELECT symbol, price_to_book FROM stock_fundamentals", ())
        df = df.merge(pb_df, on="symbol", how="left")
    except Exception:
        df["price_to_book"] = np.nan

    df = df.set_index("symbol")

    if symbol:
        if symbol not in df.index:
            print(f"[MultiFactor] Symbol {symbol} not in quant_scores. Skipping.")
            return {"processed": 0, "skipped": 1, "errors": 0}
        df = df.loc[[symbol]]

    if test:
        df = df.iloc[:10]

    print(f"[MultiFactor] Universe: {len(df)} stocks")

    # --- Load macro state once ---
    macro_state = _load_macro_state()
    print(f"[MultiFactor] Macro state: {macro_state}")

    # --- Compute all 5 factors ---
    quality  = _build_quality(df)
    momentum = _build_momentum(df)
    value    = _build_value(df)
    risk_adj = _build_risk_adj(df)
    macro    = _build_macro(df, macro_state)

    # --- Composite (weighted sum of percentile ranks) ---
    composite = (
        quality  * FACTOR_WEIGHTS["quality"]  +
        momentum * FACTOR_WEIGHTS["momentum"] +
        value    * FACTOR_WEIGHTS["value"]    +
        risk_adj * FACTOR_WEIGHTS["risk_adj"] +
        macro    * FACTOR_WEIGHTS["macro"]
    ).clip(0, 100).round(2)

    # --- Write to quant_scores ---
    rows = []
    for sym in df.index:
        rows.append((
            float(quality.get(sym, 50.0)),
            float(momentum.get(sym, 50.0)),
            float(value.get(sym, 50.0)),
            float(risk_adj.get(sym, 50.0)),
            float(macro.get(sym, 50.0)),
            float(composite.get(sym, 50.0)),
            sym,
        ))

    conn = connect()
    try:
        conn.executemany(
            """UPDATE quant_scores
               SET mf_quality_score=?, mf_momentum_score=?, mf_value_score=?,
                   mf_risk_adj_score=?, mf_macro_score=?, mf_composite_score=?,
                   last_computed=CURRENT_TIMESTAMP
               WHERE symbol=?""",
            rows,
        )
        conn.commit()
    finally:
        conn.close()

    processed = len(rows)
    print(f"[MultiFactor] Done - {processed} stocks updated")
    return {"processed": processed, "skipped": 0, "errors": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Multi-Factor Alpha Scorer")
    parser.add_argument("--symbol", help="Process a single symbol")
    parser.add_argument("--force", action="store_true", help="Recompute even if run today")
    parser.add_argument("--test", action="store_true", help="Run on first 10 symbols only")
    args = parser.parse_args()
    result = run(symbol=args.symbol, force=args.force, test=args.test)
    print(f"[MultiFactor] Result: {result}")
