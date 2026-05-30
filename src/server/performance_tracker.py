from pathlib import Path
"""
Performance Feedback Engine
==============================
Evaluates every signal / recommendation against actual market outcomes.

Computes per-segment metrics:
  - Hit rate (win %), profit factor, Sharpe ratio, max drawdown
  - Alpha vs Nifty/Sensex benchmark
  - False positive rate, signal decay half-life
  - Breakdown by: signal_type, market_regime, sector, horizon, score_bucket

Writes results to strategy_performance and resolves outstanding recommendation_log entries.

Run:  python performance_tracker.py
      python performance_tracker.py --horizon 15
      python performance_tracker.py --segment signal_type
      python performance_tracker.py --resolve-recs   # resolve pending recommendation_log rows
"""

import os
import math
import json
import datetime
import argparse
import sqlite3

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

DB_PATH      = Path(__file__).parent.parent.parent / "database.sqlite"
# WIN threshold: > +1% within horizon = WIN, < -1% = LOSS, else NEUTRAL
WIN_THRESHOLD  =  1.0
LOSS_THRESHOLD = -1.0

NIFTY_SYMBOLS = ('NIFTY50', 'NIFTY', '^NSEI', 'NIFTY_50')


class PerformanceTracker:
    def __init__(self, db_path: str = DB_PATH):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row

    def close(self):
        self.conn.close()

    # ──────────────────────────────────────────────────────────────────────────
    # Data loading
    # ──────────────────────────────────────────────────────────────────────────

    def load_outcomes(self, horizon_days: int | None = None) -> pd.DataFrame:
        """Load signal_outcomes joined with technical_signals for context."""
        base_q = """
            SELECT
                so.symbol,
                so.signal_date,
                so.horizon_days,
                so.return_pct,
                so.outcome,
                so.signal_score,
                so.entry_price,
                so.exit_price,
                ts.nifty_regime,
                ts.adx,
                ts.rsi,
                ts.signals_json,
                ns.sector
            FROM signal_outcomes so
            LEFT JOIN technical_signals ts
                   ON ts.symbol = so.symbol AND ts.date = so.signal_date
            LEFT JOIN nse_stocks ns ON ns.symbol = so.symbol
            WHERE so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
              AND so.return_pct IS NOT NULL
        """
        params = []
        if horizon_days:
            base_q += " AND so.horizon_days = ?"
            params.append(horizon_days)
        df = pd.read_sql_query(base_q, self.conn, params=params if params else None)
        df['return_pct'] = pd.to_numeric(df['return_pct'], errors='coerce')
        df['signal_score'] = pd.to_numeric(df['signal_score'], errors='coerce').fillna(5)
        df['nifty_regime'] = df['nifty_regime'].fillna('UNKNOWN')
        return df

    def load_nifty_returns(self) -> pd.Series:
        """Daily Nifty returns indexed by date."""
        q = f"SELECT date, close FROM stock_ohlcv WHERE symbol IN {NIFTY_SYMBOLS} ORDER BY date ASC"
        df = pd.read_sql_query(q, self.conn)
        if df.empty:
            return pd.Series(dtype=float)
        df['date']  = pd.to_datetime(df['date'])
        df['close'] = pd.to_numeric(df['close'], errors='coerce')
        df = df.dropna().sort_values('date').set_index('date')
        return df['close'].pct_change().fillna(0)

    # ──────────────────────────────────────────────────────────────────────────
    # Core metric computation
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    def compute_metrics(returns: pd.Series, outcomes: pd.Series, horizon_days: int) -> dict:
        """Compute comprehensive performance metrics for a group of signals."""
        n = len(returns)
        if n == 0:
            return {}

        wins    = outcomes == 'WIN'
        losses  = outcomes == 'LOSS'
        win_rate = wins.mean()
        win_returns  = returns[wins]
        loss_returns = returns[losses]

        avg_ret    = float(returns.mean())
        median_ret = float(returns.median())
        avg_win    = float(win_returns.mean())   if len(win_returns)  > 0 else 0.0
        avg_loss   = float(loss_returns.mean())  if len(loss_returns) > 0 else 0.0
        std_ret    = float(returns.std())        if len(returns) > 1  else 0.0

        # Annualised Sharpe: scale by sqrt(252 / horizon)
        ann_factor = math.sqrt(252 / max(horizon_days, 1))
        sharpe = (avg_ret / std_ret * ann_factor) if std_ret > 0 else 0.0

        # Profit factor = sum(wins) / abs(sum(losses))
        sum_wins   = float(win_returns.sum())         if len(win_returns)  > 0 else 0.0
        sum_losses = abs(float(loss_returns.sum()))   if len(loss_returns) > 0 else 1e-9
        profit_factor = sum_wins / sum_losses if sum_losses > 0 else sum_wins

        # Max drawdown (cumulative return trajectory)
        cum_ret = (1 + returns / 100).cumprod()
        peak    = cum_ret.cummax()
        dd      = ((cum_ret - peak) / peak * 100)
        max_dd  = float(dd.min()) if len(dd) > 0 else 0.0

        # False positive rate: signalled WIN but got LOSS (among those that resolved)
        resolved = wins | losses
        fp_rate  = float((losses[resolved]).mean()) if resolved.sum() > 0 else 0.0

        return {
            'total_signals':    n,
            'win_count':        int(wins.sum()),
            'loss_count':       int(losses.sum()),
            'neutral_count':    int((outcomes == 'NEUTRAL').sum()),
            'win_rate':         round(float(win_rate), 4),
            'avg_return_pct':   round(avg_ret, 4),
            'median_return_pct': round(median_ret, 4),
            'avg_win_pct':      round(avg_win, 4),
            'avg_loss_pct':     round(avg_loss, 4),
            'profit_factor':    round(profit_factor, 4),
            'sharpe_ratio':     round(sharpe, 4),
            'max_drawdown_pct': round(max_dd, 4),
            'false_positive_rate': round(fp_rate, 4),
        }

    @staticmethod
    def signal_decay_halflife(df: pd.DataFrame, horizon_col: str = 'horizon_days') -> float | None:
        """
        Estimate how many days until signal edge decays to half.
        Fits exponential decay on rolling 30-day win_rate buckets.
        Returns half-life in days, or None if insufficient data.
        """
        if len(df) < 20:
            return None
        df = df.copy()
        df['signal_date_dt'] = pd.to_datetime(df['signal_date'], errors='coerce')
        df['days_ago'] = (pd.Timestamp.now() - df['signal_date_dt']).dt.days
        df = df.dropna(subset=['days_ago'])

        # Bucket by 30-day intervals
        df['bucket'] = (df['days_ago'] // 30).astype(int)
        bucket_stats = df.groupby('bucket').agg(
            win_rate=('outcome', lambda x: (x == 'WIN').mean()),
            n=('outcome', 'count'),
        ).reset_index()
        bucket_stats = bucket_stats[bucket_stats['n'] >= 5]

        if len(bucket_stats) < 3:
            return None

        try:
            from scipy.optimize import curve_fit
            def exp_decay(x, a, lam):
                return a * np.exp(-lam * x)

            popt, _ = curve_fit(
                exp_decay,
                bucket_stats['bucket'].values,
                bucket_stats['win_rate'].values,
                p0=[0.6, 0.05],
                maxfev=1000,
            )
            lam = popt[1]
            if lam > 0:
                return round(math.log(2) / lam * 30, 1)  # convert bucket units to days
        except Exception:
            pass
        return None

    def alpha_vs_nifty(self, df: pd.DataFrame, nifty_rets: pd.Series) -> float | None:
        """
        Compute alpha: avg signal return minus expected Nifty return over same horizon.
        """
        if nifty_rets.empty or len(df) == 0:
            return None

        alphas = []
        for _, row in df.iterrows():
            try:
                entry_dt = pd.to_datetime(row['signal_date'])
                horizon  = int(row['horizon_days'])
                nifty_window = nifty_rets.loc[entry_dt: entry_dt + pd.Timedelta(days=horizon + 5)]
                if len(nifty_window) < 1:
                    continue
                nifty_cum = float(((1 + nifty_window).cumprod().iloc[-1] - 1) * 100)
                signal_ret = float(row['return_pct'])
                alphas.append(signal_ret - nifty_cum)
            except Exception:
                continue

        return round(float(np.mean(alphas)), 4) if alphas else None

    # ──────────────────────────────────────────────────────────────────────────
    # Segmented analysis
    # ──────────────────────────────────────────────────────────────────────────

    def _extract_signal_types(self, signals_json_series: pd.Series) -> pd.Series:
        """Extract primary signal type from signals_json column."""
        def first_type(s):
            try:
                sigs = json.loads(s or '[]')
                if sigs and isinstance(sigs, list):
                    return sigs[0].get('type', 'UNKNOWN')
            except Exception:
                pass
            return 'UNKNOWN'
        return signals_json_series.apply(first_type)

    def compute_segment(
        self,
        df: pd.DataFrame,
        segment: str,
        horizon_days: int,
        nifty_rets: pd.Series,
    ) -> list[dict]:
        """Compute performance metrics for each value of a segment column."""
        rows = []

        if segment == 'signal_type':
            df = df.copy()
            df['_seg'] = self._extract_signal_types(df['signals_json'])
        elif segment == 'score_bucket':
            df = df.copy()
            df['_seg'] = pd.cut(
                df['signal_score'],
                bins=[0, 3, 5, 7, 10],
                labels=['1-3', '4-5', '6-7', '8-10'],
            ).astype(str)
        else:
            df = df.copy()
            df['_seg'] = df.get(segment, pd.Series(['ALL'] * len(df), index=df.index))

        df['_seg'] = df['_seg'].fillna('UNKNOWN')

        for val, grp in df.groupby('_seg'):
            if len(grp) < 5:
                continue
            metrics = self.compute_metrics(grp['return_pct'], grp['outcome'], horizon_days)
            if not metrics:
                continue
            alpha  = self.alpha_vs_nifty(grp, nifty_rets)
            decay  = self.signal_decay_halflife(grp)
            regime = grp['nifty_regime'].mode().iloc[0] if not grp.empty else 'ALL'

            rows.append({
                'perf_key':      f"{val}|{regime}|{horizon_days}",
                'strategy_name': str(val),
                'segment':       segment,
                'segment_value': str(val),
                'horizon_days':  horizon_days,
                'market_regime': regime,
                'alpha_vs_nifty': alpha,
                'signal_decay_halflife_days': decay,
                **metrics,
            })

        return rows

    # ──────────────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────────────

    def save_strategy_performance(self, rows: list[dict]):
        now = datetime.datetime.now().isoformat()
        cur = self.conn.cursor()
        for r in rows:
            r['last_computed'] = now
            cols   = ', '.join(r.keys())
            places = ', '.join(f':{k}' for k in r.keys())
            cur.execute(f"""
                INSERT INTO strategy_performance ({cols})
                VALUES ({places})
                ON CONFLICT(perf_key, horizon_days, market_regime) DO UPDATE SET
                    total_signals     = excluded.total_signals,
                    win_count         = excluded.win_count,
                    loss_count        = excluded.loss_count,
                    neutral_count     = excluded.neutral_count,
                    win_rate          = excluded.win_rate,
                    avg_return_pct    = excluded.avg_return_pct,
                    median_return_pct = excluded.median_return_pct,
                    avg_win_pct       = excluded.avg_win_pct,
                    avg_loss_pct      = excluded.avg_loss_pct,
                    profit_factor     = excluded.profit_factor,
                    sharpe_ratio      = excluded.sharpe_ratio,
                    max_drawdown_pct  = excluded.max_drawdown_pct,
                    alpha_vs_nifty    = excluded.alpha_vs_nifty,
                    false_positive_rate = excluded.false_positive_rate,
                    signal_decay_halflife_days = excluded.signal_decay_halflife_days,
                    last_computed     = excluded.last_computed
            """, r)
        self.conn.commit()
        print(f"[PerfTracker] Saved {len(rows)} segment rows to strategy_performance.")

    def resolve_recommendations(self):
        """Update recommendation_log rows that have a matching signal_outcomes entry."""
        cur = self.conn.cursor()
        # Join on best-matching horizon: prefer exact match, fall back to any resolved outcome
        cur.execute("""
            UPDATE recommendation_log
            SET
                actual_exit_price = (
                    SELECT so.exit_price FROM signal_outcomes so
                    WHERE so.symbol = recommendation_log.symbol
                      AND so.signal_date = recommendation_log.signal_date
                      AND so.outcome NOT IN ('PENDING')
                    ORDER BY so.horizon_days ASC, so.computed_at DESC LIMIT 1
                ),
                actual_return_pct = (
                    SELECT so.return_pct FROM signal_outcomes so
                    WHERE so.symbol = recommendation_log.symbol
                      AND so.signal_date = recommendation_log.signal_date
                      AND so.outcome NOT IN ('PENDING')
                    ORDER BY so.horizon_days ASC, so.computed_at DESC LIMIT 1
                ),
                outcome = (
                    SELECT so.outcome FROM signal_outcomes so
                    WHERE so.symbol = recommendation_log.symbol
                      AND so.signal_date = recommendation_log.signal_date
                      AND so.outcome NOT IN ('PENDING')
                    ORDER BY so.horizon_days ASC, so.computed_at DESC LIMIT 1
                ),
                status = 'RESOLVED',
                resolved_at = CURRENT_TIMESTAMP
            WHERE status = 'ACTIVE'
              AND EXISTS (
                SELECT 1 FROM signal_outcomes so
                WHERE so.symbol = recommendation_log.symbol
                  AND so.signal_date = recommendation_log.signal_date
                  AND so.outcome NOT IN ('PENDING')
              )
        """)
        updated = cur.rowcount
        self.conn.commit()
        print(f"[PerfTracker] Resolved {updated} recommendation_log rows.")
        return updated

    # ──────────────────────────────────────────────────────────────────────────
    # Summary reporting
    # ──────────────────────────────────────────────────────────────────────────

    def print_summary(self, horizon_days: int):
        cur = self.conn.cursor()
        cur.execute("""
            SELECT strategy_name, segment, win_rate, profit_factor,
                   sharpe_ratio, alpha_vs_nifty, total_signals, max_drawdown_pct
            FROM strategy_performance
            WHERE horizon_days = ?
            ORDER BY win_rate DESC
            LIMIT 20
        """, (horizon_days,))
        rows = cur.fetchall()
        if not rows:
            print(f"[PerfTracker] No results for horizon={horizon_days}d.")
            return
        print(f"\n{'='*80}")
        print(f" PERFORMANCE REPORT — {horizon_days}-day horizon")
        print(f"{'='*80}")
        print(f"{'Strategy':<30} {'Segment':<15} {'WinRate':>7} {'PF':>6} {'Sharpe':>7} {'Alpha':>7} {'N':>5}")
        print(f"{'-'*80}")
        for r in rows:
            wr    = f"{r[2]*100:.1f}%" if r[2] else "N/A"
            pf    = f"{r[3]:.2f}"      if r[3] else "N/A"
            sh    = f"{r[4]:.2f}"      if r[4] else "N/A"
            alpha = f"{r[5]:+.2f}%"    if r[5] else "N/A"
            print(f"{r[0]:<30} {r[1]:<15} {wr:>7} {pf:>6} {sh:>7} {alpha:>7} {r[6]:>5}")

    # ──────────────────────────────────────────────────────────────────────────
    # Main run
    # ──────────────────────────────────────────────────────────────────────────

    def run(self, horizon_days: int = 15, segments: list[str] | None = None,
            resolve_recs: bool = True):
        print(f"[PerfTracker] Starting at {datetime.datetime.now()}")

        if resolve_recs:
            self.resolve_recommendations()

        df = self.load_outcomes(horizon_days=horizon_days)
        print(f"[PerfTracker] {len(df)} resolved outcomes for horizon={horizon_days}d")

        if df.empty:
            print("[PerfTracker] No data to analyse. Run computeSignalOutcomes first.")
            return

        nifty_rets = self.load_nifty_returns()

        if segments is None:
            segments = ['signal_type', 'nifty_regime', 'sector', 'score_bucket']

        all_rows: list[dict] = []
        for seg in segments:
            print(f"[PerfTracker]   Segment: {seg}...")
            rows = self.compute_segment(df, seg, horizon_days, nifty_rets)
            all_rows.extend(rows)

        # Overall aggregate
        overall = self.compute_metrics(df['return_pct'], df['outcome'], horizon_days)
        if overall:
            alpha = self.alpha_vs_nifty(df, nifty_rets)
            decay = self.signal_decay_halflife(df)
            all_rows.append({
                'perf_key':     f"OVERALL|ALL|{horizon_days}",
                'strategy_name': 'OVERALL',
                'segment':       'overall',
                'segment_value': 'ALL',
                'horizon_days':  horizon_days,
                'market_regime': 'ALL',
                'alpha_vs_nifty': alpha,
                'signal_decay_halflife_days': decay,
                **overall,
            })

        self.save_strategy_performance(all_rows)
        self.print_summary(horizon_days)
        print("[PerfTracker] Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Performance Feedback Engine")
    parser.add_argument("--horizon",      type=int,   default=15,
                        help="Outcome horizon in days (default: 15)")
    parser.add_argument("--segment",      type=str,   default="",
                        help="Comma-separated segments to compute (default: all)")
    parser.add_argument("--resolve-recs", action="store_true", default=True,
                        help="Resolve pending recommendation_log entries (default: true)")
    parser.add_argument("--no-resolve",   dest="resolve_recs", action="store_false")
    args = parser.parse_args()

    segs = [s.strip() for s in args.segment.split(",") if s.strip()] if args.segment else None

    tracker = PerformanceTracker()
    try:
        tracker.run(
            horizon_days=args.horizon,
            segments=segs,
            resolve_recs=args.resolve_recs,
        )
    finally:
        tracker.close()
