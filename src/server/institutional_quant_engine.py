"""
Institutional Quant Engine v2
==============================
Computes momentum, risk, valuation, and composite scores from LOCAL data:
  - stock_ohlcv      → momentum returns, volatility, Sharpe, drawdown
  - stock_fundamentals → PE, ROE, D/E, revenue growth, Piotroski F-score
  - screener data    → bullish/bearish screener confluence

All results written to the quant_scores table (previously never populated).
No yfinance calls per symbol — uses bulk-synced fundamentals only.

Run:  python institutional_quant_engine.py
      python institutional_quant_engine.py --limit 500
"""

import os
import math
import datetime
import argparse
import numpy as np
import pandas as pd
from sqlalchemy import text

from db_compat import get_engine

RISK_FREE    = 0.07   # 7% p.a. — Indian 10Y Gsec proxy


class InstitutionalQuantEngine:
    def __init__(self):
        self.engine = get_engine()

    # ------------------------------------------------------------------
    # Data loading
    # ------------------------------------------------------------------

    def load_ohlcv(self, min_days: int = 63) -> pd.DataFrame:
        """Load all OHLCV rows, return only symbols with ≥ min_days history."""
        with self.engine.connect() as conn:
            df = pd.read_sql(
                "SELECT symbol, date, close, volume FROM stock_ohlcv ORDER BY symbol, date ASC",
                conn,
            )
        df['date'] = pd.to_datetime(df['date'])
        counts = df.groupby('symbol')['date'].count()
        eligible = counts[counts >= min_days].index
        return df[df['symbol'].isin(eligible)]

    def load_fundamentals(self) -> pd.DataFrame:
        with self.engine.connect() as conn:
            return pd.read_sql("SELECT * FROM stock_fundamentals", conn)

    def load_screener_confluence(self) -> pd.DataFrame:
        """Return per-symbol bullish/bearish screener counts from stock_scores."""
        with self.engine.connect() as conn:
            return pd.read_sql(
                """SELECT symbol,
                          SUM(positive_count) AS bullish_count,
                          SUM(negative_count) AS bearish_count,
                          COUNT(*) AS timeframe_count
                   FROM stock_scores GROUP BY symbol""",
                conn,
            )

    # ------------------------------------------------------------------
    # Feature engineering
    # ------------------------------------------------------------------

    def compute_momentum_features(self, ohlcv: pd.DataFrame) -> pd.DataFrame:
        """Per-symbol returns over standard horizons + above-SMA200 flag."""
        records = []
        for symbol, grp in ohlcv.groupby('symbol'):
            closes = grp.sort_values('date')['close'].values
            n      = len(closes)
            last   = closes[-1]

            def ret(days):
                return (last / closes[-days - 1] - 1) * 100 if n > days else None

            # SMA200
            sma200 = float(np.mean(closes[-200:])) if n >= 200 else float(np.mean(closes))
            sma200_dist = (last / sma200 - 1) * 100

            # Daily log returns for vol/Sharpe
            rets = np.diff(np.log(closes[-253:])) if n >= 253 else np.diff(np.log(closes))
            ann_vol  = float(np.std(rets) * math.sqrt(252) * 100) if len(rets) > 1 else None
            ann_ret  = float(np.mean(rets) * 252 * 100) if len(rets) > 1 else None
            sharpe   = (ann_ret - RISK_FREE * 100) / ann_vol if (ann_vol and ann_vol > 0) else None

            # Max drawdown (1Y)
            window = closes[-253:] if n >= 253 else closes
            peaks  = np.maximum.accumulate(window)
            drawdowns = (window - peaks) / peaks * 100
            max_dd = float(np.min(drawdowns))

            records.append({
                'symbol':           symbol,
                'return_1w':        ret(5),
                'return_1m':        ret(21),
                'return_3m':        ret(63),
                'return_6m':        ret(126),
                'return_12m':       ret(252),
                'above_sma200':     int(last > sma200),
                'sma200_distance_pct': sma200_dist,
                'annualized_vol':   ann_vol,
                'sharpe_ratio':     sharpe,
                'max_drawdown_1y':  max_dd,
                'ohlcv_days':       n,
            })
        return pd.DataFrame(records)

    # ------------------------------------------------------------------
    # Piotroski F-Score (9-point) from stock_fundamentals
    # ------------------------------------------------------------------

    @staticmethod
    def piotroski_f_score(row: pd.Series) -> int:
        """
        Full 9-point Piotroski score from available fundamental columns.
        Points where data is unavailable are conservatively scored 0.
        """
        score = 0

        # Profitability (4 points)
        roe = row.get('return_on_equity')
        if pd.notna(roe) and roe > 0:      score += 1   # F1: positive ROA proxy
        op_margin = row.get('operating_margins')
        if pd.notna(op_margin) and op_margin > 0: score += 1  # F2: positive CFO proxy
        # F3: ROA improvement YoY — not available without 2Y data; skip conservatively
        # F4: Accruals (CFO > net income) — approximated by positive op margin + positive ROE
        if pd.notna(roe) and pd.notna(op_margin) and roe > 0 and op_margin > 0: score += 1

        # Leverage / Liquidity (3 points)
        de = row.get('debt_to_equity')
        if pd.notna(de) and de < 1.0:      score += 1   # F5: low leverage
        cr = row.get('current_ratio')
        if pd.notna(cr) and cr >= 1.5:     score += 1   # F6: good liquidity
        # F7: No dilution — we don't have shares-issued data; skip

        # Operating Efficiency (2 points)
        rev_growth = row.get('revenue_growth')
        if pd.notna(rev_growth) and rev_growth > 0: score += 1  # F8: revenue growing
        eps_fwd = row.get('eps_forward')
        eps_ttm = row.get('eps_ttm')
        if pd.notna(eps_fwd) and pd.notna(eps_ttm) and eps_fwd > eps_ttm: score += 1  # F9: EPS improving

        return score

    # ------------------------------------------------------------------
    # Percentile ranking
    # ------------------------------------------------------------------

    @staticmethod
    def pct_rank(series: pd.Series, higher_is_better: bool = True) -> pd.Series:
        ranked = series.rank(pct=True, na_option='keep')
        return ranked * 100 if higher_is_better else (1 - ranked) * 100

    # ------------------------------------------------------------------
    # Main computation
    # ------------------------------------------------------------------

    def run(self, limit: int = 0):
        print(f"[QuantEngine] Starting at {datetime.datetime.now()}")

        ohlcv   = self.load_ohlcv(min_days=63)
        print(f"[QuantEngine] {ohlcv['symbol'].nunique()} symbols with ≥63 days OHLCV")

        mom     = self.compute_momentum_features(ohlcv)
        fund    = self.load_fundamentals()
        screener = self.load_screener_confluence()

        # Merge
        df = mom.merge(fund, on='symbol', how='left') \
                .merge(screener, on='symbol', how='left')

        if limit > 0:
            df = df.head(limit)

        # ── Piotroski F-Score ──────────────────────────────────────────
        df['piotroski_f_score'] = df.apply(self.piotroski_f_score, axis=1)

        # ── Percentile ranks ──────────────────────────────────────────
        df['momentum_score']  = (
            self.pct_rank(df['return_1m'].fillna(0)) * 0.25 +
            self.pct_rank(df['return_3m'].fillna(0)) * 0.35 +
            self.pct_rank(df['return_6m'].fillna(0)) * 0.40
        )
        df['vol_rank']    = self.pct_rank(df['annualized_vol'],  higher_is_better=False)
        df['sharpe_rank'] = self.pct_rank(df['sharpe_ratio'],    higher_is_better=True)

        # Valuation: low PE + high ROE + low D/E + Piotroski
        val_pe  = self.pct_rank(df['trailing_pe'],    higher_is_better=False)
        val_roe = self.pct_rank(df['return_on_equity'], higher_is_better=True)
        val_de  = self.pct_rank(df['debt_to_equity'],  higher_is_better=False)
        val_piot = self.pct_rank(df['piotroski_f_score'], higher_is_better=True)
        df['valuation_score'] = (val_pe * 0.30 + val_roe * 0.30 + val_de * 0.20 + val_piot * 0.20).fillna(50)

        # Screener confluence
        df['screener_net_score'] = (df['bullish_count'].fillna(0) - df['bearish_count'].fillna(0))
        df['confluence_rank']    = self.pct_rank(df['screener_net_score'], higher_is_better=True)

        # ── Composite strategy ranks ───────────────────────────────────
        df['rank_momentum'] = df['momentum_score'].fillna(50)
        df['rank_quality']  = (
            df['momentum_score'].fillna(50) * 0.40 +
            df['vol_rank'].fillna(50)        * 0.30 +
            df['sharpe_rank'].fillna(50)     * 0.30
        )
        df['rank_value']    = df['valuation_score']
        df['rank_composite'] = (
            df['rank_momentum']        * 0.30 +
            df['rank_quality']         * 0.30 +
            df['rank_value']           * 0.20 +
            df['confluence_rank'].fillna(50) * 0.20
        )

        # ── Classification ─────────────────────────────────────────────
        def classify(score):
            if score >= 80: return 'Strong Buy'
            if score >= 65: return 'Buy'
            if score >= 45: return 'Hold'
            if score >= 30: return 'Avoid'
            return 'Sell'

        df['composite_class'] = df['rank_composite'].apply(classify)

        print(f"[QuantEngine] Computed scores for {len(df)} symbols. Saving to quant_scores...")
        self._save(df)
        print("[QuantEngine] Done.")

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _save(self, df: pd.DataFrame):
        now = datetime.datetime.now().isoformat()
        cols = [
            'symbol',
            'return_1w', 'return_1m', 'return_3m', 'return_6m', 'return_12m',
            'above_sma200', 'sma200_distance_pct', 'momentum_score',
            'annualized_vol', 'sharpe_ratio', 'max_drawdown_1y',
            'vol_rank', 'sharpe_rank',
            'trailing_pe', 'forward_pe', 'debt_to_equity', 'return_on_equity',
            'operating_margins', 'revenue_growth', 'piotroski_f_score',
            'valuation_score',
            'bullish_count', 'bearish_count',
            'screener_net_score', 'confluence_rank',
            'rank_momentum', 'rank_quality', 'rank_value', 'rank_composite',
            'composite_class', 'ohlcv_days',
        ]
        # Keep only columns that exist in df
        existing = [c for c in cols if c in df.columns]
        rows = df[existing].copy()
        rows['screener_category_breadth'] = None  # placeholder
        rows['last_computed'] = now

        # Coerce numpy types to Python native for sqlite3
        rows = rows.where(pd.notna(rows), None)

        with self.engine.begin() as conn:
            conn.execute(text("DELETE FROM quant_scores"))
            for _, r in rows.iterrows():
                data = {k: (None if (v is None or (isinstance(v, float) and math.isnan(v))) else v)
                        for k, v in r.items()}
                placeholders = ', '.join(f':{k}' for k in data)
                keys = ', '.join(data.keys())
                conn.execute(text(f"INSERT INTO quant_scores ({keys}) VALUES ({placeholders})"), data)

        print(f"[QuantEngine] Saved {len(rows)} rows to quant_scores.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Institutional Quant Engine v2")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of symbols (0 = all)")
    args = parser.parse_args()

    engine = InstitutionalQuantEngine()
    engine.run(limit=args.limit)
