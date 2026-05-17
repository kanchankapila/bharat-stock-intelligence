"""
Strategy Weight Optimizer
===========================
Uses scipy differential_evolution to find the optimal CATEGORY_WEIGHTS and
SOURCE_WEIGHTS for the AlphaQuant scoring engine, maximising win rate and
risk-adjusted return derived from historical strategy_performance data.

Optimization objective:
  Maximise:  (0.5 × win_rate) + (0.3 × profit_factor_norm) + (0.2 × sharpe_norm)
  Subject to: all weights in [0.2, 2.0], source weights in [0.5, 1.5]

After optimisation, writes:
  1. Optimal weights as JSON into screener_weight_history
  2. Per-screener override weights into screener_master.weight_override

Requirements:
    pip install scipy pandas numpy

Run:  python strategy_optimizer.py
      python strategy_optimizer.py --iterations 500
      python strategy_optimizer.py --dry-run      # show weights without saving
      python strategy_optimizer.py --apply         # also writes to screener_master
"""

import os, sys, json, datetime, argparse, sqlite3, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

# Default weights — mirrors scoring_engine.py defaults
DEFAULT_CATEGORY_WEIGHTS = {
    'fundamental': 1.0,
    'technical':   0.85,
    'momentum':    0.95,
    'valuation':   0.9,
    'delivery':    0.8,
    'sector':      0.3,
    'news':        1.2,
    'other':       0.5,
}
DEFAULT_SOURCE_WEIGHTS = {
    'Trendlyne':    1.0,
    'MoneyControl': 0.9,
    'ETnow':        0.85,
}
CATEGORIES = list(DEFAULT_CATEGORY_WEIGHTS.keys())
SOURCES    = list(DEFAULT_SOURCE_WEIGHTS.keys())


class StrategyOptimizer:
    def __init__(self, db_path: str = DB_PATH):
        self.conn = sqlite3.connect(db_path)
        self.perf_df = None

    def close(self):
        self.conn.close()

    # ──────────────────────────────────────────────────────────────────────────
    # Load historical performance
    # ──────────────────────────────────────────────────────────────────────────

    def load_performance(self, horizon_days: int = 15) -> pd.DataFrame:
        """Load strategy_performance with category/source breakdown."""
        q = """
            SELECT sp.*, sfb.technical, sfb.fundamental, sfb.momentum,
                   sfb.valuation, sfb.delivery, sfb.news
            FROM strategy_performance sp
            LEFT JOIN stock_factor_breakdown sfb
                   ON sfb.symbol = sp.segment_value AND sfb.timeframe = 'medium'
            WHERE sp.horizon_days = ?
              AND sp.total_signals >= 5
        """
        df = pd.read_sql_query(q, self.conn, params=(horizon_days,))
        return df

    def load_signal_outcomes_with_factors(self, horizon_days: int = 15) -> pd.DataFrame:
        """Load individual outcomes joined with factor breakdown for simulation."""
        q = """
            SELECT so.symbol, so.signal_date, so.horizon_days,
                   so.outcome, so.return_pct, so.signal_score,
                   sfb.technical, sfb.fundamental, sfb.momentum,
                   sfb.valuation, sfb.delivery, sfb.news,
                   ss.source
            FROM signal_outcomes so
            LEFT JOIN stock_factor_breakdown sfb
                   ON sfb.symbol = so.symbol
            LEFT JOIN (
                SELECT symbol, source FROM screener_master
            ) ss ON ss.symbol = so.symbol
            WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
              AND so.return_pct IS NOT NULL
              AND so.horizon_days = ?
        """
        df = pd.read_sql_query(q, self.conn, params=(horizon_days,))
        for col in CATEGORIES:
            df[col] = pd.to_numeric(df.get(col, np.nan), errors='coerce').fillna(0)
        return df

    # ──────────────────────────────────────────────────────────────────────────
    # Objective function
    # ──────────────────────────────────────────────────────────────────────────

    def _objective(self, params: np.ndarray, df: pd.DataFrame) -> float:
        """
        Simulate weighted scores with trial weights, compute objective.
        Returns negative value (scipy minimises).
        """
        cat_weights = dict(zip(CATEGORIES, params[:len(CATEGORIES)]))
        src_weights = dict(zip(SOURCES,    params[len(CATEGORIES):]))

        # Compute trial composite score for each outcome row
        cat_cols = [c for c in CATEGORIES if c in df.columns]
        weighted_score = sum(df[c] * cat_weights.get(c, 1.0) for c in cat_cols)

        # Source weight modifier — default 1.0 if source unknown
        src_modifier = df['source'].map(src_weights).fillna(1.0)
        trial_score  = (weighted_score * src_modifier).clip(0, 100)

        # Split into quartiles by trial score; evaluate top quartile performance
        threshold = trial_score.quantile(0.75)
        top_signals = df[trial_score >= threshold]

        if len(top_signals) < 10:
            return 1.0  # penalise — insufficient top signals

        win_rate      = (top_signals['outcome'] == 'WIN').mean()
        avg_ret       = top_signals['return_pct'].mean()
        std_ret       = top_signals['return_pct'].std()
        profit_factor = (
            top_signals.loc[top_signals['return_pct'] > 0, 'return_pct'].sum() /
            abs(top_signals.loc[top_signals['return_pct'] < 0, 'return_pct'].sum() + 1e-9)
        )
        sharpe = (avg_ret / std_ret) if std_ret > 0 else 0.0

        # Normalise profit_factor and Sharpe into [0, 1]
        pf_norm     = min(profit_factor / 3.0, 1.0)
        sharpe_norm = min(max(sharpe, 0) / 3.0, 1.0)

        objective = 0.5 * win_rate + 0.3 * pf_norm + 0.2 * sharpe_norm
        return -objective  # minimise

    def optimise(
        self,
        horizon_days: int = 15,
        max_iterations: int = 300,
        popsize: int = 12,
    ) -> dict:
        try:
            from scipy.optimize import differential_evolution
        except ImportError:
            print("[Optimizer] scipy not installed. Run: pip install scipy")
            sys.exit(1)

        df = self.load_signal_outcomes_with_factors(horizon_days)
        if len(df) < 30:
            print(f"[Optimizer] Insufficient data ({len(df)} rows) for optimisation.")
            return {}

        print(f"[Optimizer] Optimising on {len(df)} outcome rows  (horizon={horizon_days}d)...")

        baseline = -self._objective(
            list(DEFAULT_CATEGORY_WEIGHTS.values()) + list(DEFAULT_SOURCE_WEIGHTS.values()),
            df,
        )
        print(f"[Optimizer] Baseline objective: {baseline:.4f}")

        # Bounds: categories [0.2, 2.0], sources [0.5, 1.5]
        bounds = [(0.2, 2.0)] * len(CATEGORIES) + [(0.5, 1.5)] * len(SOURCES)

        result = differential_evolution(
            self._objective,
            bounds=bounds,
            args=(df,),
            maxiter=max_iterations,
            popsize=popsize,
            seed=42,
            tol=1e-6,
            mutation=(0.5, 1.5),
            recombination=0.7,
            workers=-1,  # parallel evaluation
            callback=lambda xk, convergence: print(
                f"[Optimizer]   iter... obj={-self._objective(xk, df):.4f}"
            ) if False else None,
        )

        optimised_obj = -result.fun
        print(f"[Optimizer] Optimised objective: {optimised_obj:.4f}  "
              f"(improvement: {(optimised_obj/baseline - 1)*100:+.1f}%)")

        opt_cat = dict(zip(CATEGORIES, result.x[:len(CATEGORIES)]))
        opt_src = dict(zip(SOURCES,    result.x[len(CATEGORIES):]))

        # Simulate win rate at optimised weights
        opt_df_score = sum(df[c] * opt_cat.get(c, 1.0) for c in CATEGORIES if c in df.columns)
        opt_top      = df[opt_df_score >= opt_df_score.quantile(0.75)]
        opt_wr       = (opt_top['outcome'] == 'WIN').mean() if len(opt_top) > 0 else 0.0

        # Simulate win rate at baseline weights
        base_df_score = sum(df[c] * DEFAULT_CATEGORY_WEIGHTS.get(c, 1.0)
                            for c in CATEGORIES if c in df.columns)
        base_top = df[base_df_score >= base_df_score.quantile(0.75)]
        base_wr  = (base_top['outcome'] == 'WIN').mean() if len(base_top) > 0 else 0.0

        return {
            'category_weights': {k: round(v, 4) for k, v in opt_cat.items()},
            'source_weights':   {k: round(v, 4) for k, v in opt_src.items()},
            'optimised_objective': round(optimised_obj, 6),
            'baseline_objective':  round(baseline, 6),
            'baseline_win_rate':   round(float(base_wr), 4),
            'optimised_win_rate':  round(float(opt_wr), 4),
            'improvement_pct':     round((optimised_obj / baseline - 1) * 100, 2),
            'training_samples':    len(df),
            'horizon_days':        horizon_days,
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Per-screener weight refinement (fine-tuning on top of global optimisation)
    # ──────────────────────────────────────────────────────────────────────────

    def compute_screener_overrides(self, opt_weights: dict) -> dict[str, float]:
        """
        Compute per-screener weight multipliers based on historical signal count
        and win rate. Screeners that consistently appear in winning signals get
        a boost; those appearing in losing signals get penalised.
        """
        q = """
            SELECT sm.scan_id, sm.name, sm.source, sm.inferred_category,
                   COUNT(so.symbol) AS appearances,
                   SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
            FROM screener_master sm
            JOIN trendlyne_screener_stocks tss ON tss.screener_id = sm.scan_id
            JOIN signal_outcomes so ON so.symbol = tss.symbol
            WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
            GROUP BY sm.scan_id, sm.name
            HAVING appearances >= 10
        """
        df = pd.read_sql_query(q, self.conn)
        if df.empty:
            return {}

        df['win_rate'] = df['wins'] / df['appearances']

        # Mean revert: weight = 0.8 + (win_rate / overall_win_rate) × 0.4, capped [0.5, 1.8]
        overall_wr = df['win_rate'].mean()
        if overall_wr <= 0:
            return {}

        df['weight_override'] = (0.8 + (df['win_rate'] / overall_wr) * 0.4).clip(0.5, 1.8)
        overrides = dict(zip(df['scan_id'].astype(str), df['weight_override'].round(4)))
        return overrides

    # ──────────────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────────────

    def save_to_history(self, result: dict, overrides: dict, method: str = 'differential_evolution'):
        cur = self.conn.cursor()
        cur.execute("""
            INSERT INTO screener_weight_history
                (snapshot_at, optimization_method, category_weights_json,
                 source_weights_json, screener_overrides_json,
                 baseline_win_rate, optimized_win_rate, improvement_pct, training_samples)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            datetime.datetime.now().isoformat(),
            method,
            json.dumps(result.get('category_weights', {})),
            json.dumps(result.get('source_weights', {})),
            json.dumps(overrides),
            result.get('baseline_win_rate'),
            result.get('optimised_win_rate'),
            result.get('improvement_pct'),
            result.get('training_samples'),
        ))
        self.conn.commit()
        print(f"[Optimizer] Saved to screener_weight_history (id={cur.lastrowid})")

    def apply_screener_overrides(self, overrides: dict[str, float]):
        """Write per-screener weight_override values to screener_master."""
        cur = self.conn.cursor()
        n = 0
        for scan_id, weight in overrides.items():
            cur.execute(
                "UPDATE screener_master SET weight_override = ? WHERE scan_id = ?",
                (weight, scan_id),
            )
            if cur.rowcount > 0:
                n += 1
        self.conn.commit()
        print(f"[Optimizer] Applied weight_override to {n} screeners in screener_master.")

    def apply_to_scoring_engine(self, result: dict):
        """
        Write optimal weights to app_settings for scoring_engine.py to read at startup.
        Key: 'optimal_category_weights' / 'optimal_source_weights'
        """
        cur = self.conn.cursor()
        now = datetime.datetime.now().isoformat()
        for key, val in [
            ('optimal_category_weights', json.dumps(result.get('category_weights', {}))),
            ('optimal_source_weights',   json.dumps(result.get('source_weights', {}))),
        ]:
            cur.execute("""
                INSERT INTO app_settings (key, value, updatedAt)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
            """, (key, val, now))
        self.conn.commit()
        print("[Optimizer] Optimal weights saved to app_settings for scoring_engine.py.")

    # ──────────────────────────────────────────────────────────────────────────
    # Main
    # ──────────────────────────────────────────────────────────────────────────

    def run(self, horizon_days: int = 15, max_iterations: int = 300,
            dry_run: bool = False, apply: bool = True):
        print(f"[Optimizer] Starting at {datetime.datetime.now()}")
        result = self.optimise(horizon_days=horizon_days, max_iterations=max_iterations)
        if not result:
            return

        print("\n[Optimizer] Optimised Category Weights:")
        for k, v in result['category_weights'].items():
            default = DEFAULT_CATEGORY_WEIGHTS.get(k, 1.0)
            print(f"  {k:<15} {default:.2f} → {v:.4f}  ({(v/default - 1)*100:+.1f}%)")

        print("\n[Optimizer] Optimised Source Weights:")
        for k, v in result['source_weights'].items():
            default = DEFAULT_SOURCE_WEIGHTS.get(k, 1.0)
            print(f"  {k:<15} {default:.2f} → {v:.4f}  ({(v/default - 1)*100:+.1f}%)")

        print(f"\n[Optimizer] Win rate:  baseline={result['baseline_win_rate']:.1%}  "
              f"→ optimised={result['optimised_win_rate']:.1%}  "
              f"({result['improvement_pct']:+.1f}%)")

        overrides = self.compute_screener_overrides(result)
        print(f"[Optimizer] {len(overrides)} per-screener overrides computed.")

        if dry_run:
            print("[Optimizer] Dry-run: not saving.")
            return

        self.save_to_history(result, overrides)
        self.apply_to_scoring_engine(result)
        if apply:
            self.apply_screener_overrides(overrides)

        print("[Optimizer] Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Strategy Weight Optimizer")
    parser.add_argument("--horizon",    type=int,  default=15)
    parser.add_argument("--iterations", type=int,  default=300)
    parser.add_argument("--dry-run",    action="store_true")
    parser.add_argument("--apply",      action="store_true", default=True,
                        help="Apply screener overrides to screener_master (default: true)")
    parser.add_argument("--no-apply",   dest="apply", action="store_false")
    args = parser.parse_args()

    opt = StrategyOptimizer()
    try:
        opt.run(
            horizon_days=args.horizon,
            max_iterations=args.iterations,
            dry_run=args.dry_run,
            apply=args.apply,
        )
    finally:
        opt.close()
