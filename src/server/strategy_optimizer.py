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

import os, sys, json, datetime, argparse, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

from db_compat import connect

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
    def __init__(self):
        self.conn = connect()
        self.perf_df = None

    def close(self):
        self.conn.close()

    def _read_df(self, sql: str, params=()) -> pd.DataFrame:
        """SELECT through self.conn instead of the global-engine read_df() helper -- this
        class accepts an injected self.conn (see __init__) but every load_* method used to
        read via the module-level read_df()/get_engine() regardless, silently ignoring
        whatever connection the caller set. Harmless in normal use (self.conn and the global
        engine point at the same DB), but made this class untestable against an isolated
        connection (test_strategy_optimizer.py's test_optimise_uses_temporal_split built its
        own in-memory sqlite `conn`, assigned it to self.conn, and got live production data
        back instead). dict(row) works for both the Row wrapper (db_compat) and sqlite3.Row
        (tests) since both are mapping-like, so this needs no hardcoded column list even for
        the `SELECT sp.*` case in load_performance."""
        rows = self.conn.execute(sql, params).fetchall()
        return pd.DataFrame([dict(r) for r in rows])

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
                   ON sfb.symbol = sp.segment_value AND sfb.timeframe = 'long_term'
            WHERE sp.horizon_days = ?
              AND sp.total_signals >= 5
        """
        df = self._read_df(q, (horizon_days,))
        return df

    def load_signal_outcomes_with_factors(self, horizon_days: int = 15) -> pd.DataFrame:
        """Load individual outcomes joined with factor breakdown for simulation."""
        # scoring_engine.py only ever writes timeframe IN ('long_term', 'intraday')
        # (HORIZON_MAP maps 'swing'/'positional' -> 'long_term'). This previously joined
        # on timeframe='medium', a bucket that has never existed -- stock_factor_breakdown
        # always came back NULL, so the optimizer's category-weight objective ran on an
        # all-zero factor breakdown the whole time. 'long_term' is the multi-day bucket
        # that matches signal_outcomes' 5/15-day horizons (vs. same-day 'intraday').
        # screener_master join removed: signal_outcomes are from technical_signals,
        # not screener sources (Trendlyne/MC/ETnow), so source was always NULL.
        q = """
            SELECT so.symbol, so.signal_date, so.horizon_days,
                   so.outcome, so.return_pct, so.signal_score,
                   sfb.technical, sfb.fundamental, sfb.momentum,
                   sfb.valuation, sfb.delivery, sfb.news
            FROM signal_outcomes so
            LEFT JOIN stock_factor_breakdown sfb
                   ON sfb.symbol = so.symbol AND sfb.timeframe = 'long_term'
            WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
              AND so.return_pct IS NOT NULL
              AND so.horizon_days = ?
        """
        df = self._read_df(q, (horizon_days,))
        for col in CATEGORIES:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
            else:
                df[col] = 0.0
        return df

    # ──────────────────────────────────────────────────────────────────────────
    # Objective function
    # ──────────────────────────────────────────────────────────────────────────

    def _compute_score(self, params: np.ndarray, df: pd.DataFrame) -> float:
        cat_weights = dict(zip(CATEGORIES, params[:len(CATEGORIES)]))
        src_weights = dict(zip(SOURCES,    params[len(CATEGORIES):]))

        # Compute trial composite score for each outcome row
        cat_cols = [c for c in CATEGORIES if c in df.columns]
        weighted_score = sum(df[c] * cat_weights.get(c, 1.0) for c in cat_cols)
        trial_score = weighted_score.clip(0, 100)

        # Guard against degenerate score distributions
        if trial_score.std() == 0:
            return -1.0
        threshold = trial_score.quantile(0.75)
        top_signals = df[trial_score >= threshold]

        if len(top_signals) < 10:
            return -1.0  # penalise — insufficient top signals

        n             = len(top_signals)
        win_rate      = (top_signals['outcome'] == 'WIN').mean()
        avg_ret       = top_signals['return_pct'].mean()
        std_ret       = top_signals['return_pct'].std()
        wins_sum      = top_signals.loc[top_signals['return_pct'] > 0, 'return_pct'].sum()
        loss_sum      = abs(top_signals.loc[top_signals['return_pct'] < 0, 'return_pct'].sum())
        profit_factor = wins_sum / (loss_sum + 1e-9)
        sharpe = (avg_ret / std_ret) if std_ret > 0 else 0.0

        # Normalise profit_factor and Sharpe into [0, 1]
        pf_norm       = min(profit_factor / 3.0, 1.0)
        sharpe_norm   = min(max(sharpe, 0) / 3.0, 1.0)
        # Weight by sample confidence: full weight at n>=100, half at n=50, near-zero at n<10
        sample_weight = min(n, 100) / 100.0

        objective = sample_weight * (0.5 * win_rate + 0.3 * pf_norm + 0.2 * sharpe_norm)
        return objective
        
    def _objective(self, params: np.ndarray, train_df: pd.DataFrame) -> float:
        """
        Simulate weighted scores with trial weights on the TRAIN split only.
        Returns negative value (scipy minimises).

        test_df is scored separately in optimise() for reporting. Previously this
        objective blended in 0.3*test_score, so the optimizer's search saw the holdout
        score on every single iteration -- that isn't a genuine walk-forward evaluation,
        it's the test set actively shaping the fit.
        """
        train_score = self._compute_score(params, train_df)
        return -train_score  # minimise

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

        # Chronological 80/20 train/test split (walk-forward validation)
        df = df.sort_values('signal_date').reset_index(drop=True)
        split_idx = int(len(df) * 0.8)
        train_df = df.iloc[:split_idx]
        test_df = df.iloc[split_idx:]

        baseline_params = list(DEFAULT_CATEGORY_WEIGHTS.values()) + list(DEFAULT_SOURCE_WEIGHTS.values())
        baseline_train = -self._objective(baseline_params, train_df)
        baseline_test  = self._compute_score(baseline_params, test_df)
        print(f"[Optimizer] Baseline — train: {baseline_train:.4f}  held-out test: {baseline_test:.4f}")

        # Bounds: categories [0.2, 2.0], sources [0.5, 1.5]
        bounds = [(0.2, 2.0)] * len(CATEGORIES) + [(0.5, 1.5)] * len(SOURCES)

        result = differential_evolution(
            self._objective,
            bounds=bounds,
            args=(train_df,),
            maxiter=max_iterations,
            popsize=popsize,
            seed=42,
            tol=1e-6,
            mutation=(0.5, 1.5),
            recombination=0.7,
            workers=1,  # SQLite connection cannot be pickled to multiple processes easily
            callback=lambda xk, convergence: print(
                f"[Optimizer]   iter... obj={-self._objective(xk, train_df):.4f}"
            ) if False else None,
        )

        optimised_train = -result.fun
        optimised_test  = self._compute_score(result.x, test_df)
        print(f"[Optimizer] Optimised — train: {optimised_train:.4f}  held-out test: {optimised_test:.4f}")
        if optimised_test < baseline_test:
            print("[Optimizer] WARNING: optimised weights underperform baseline on held-out "
                  "test data -- likely overfit to the train split. Review before applying.")

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

        # improvement_pct is now measured on the held-out test split, not the train-blended
        # objective the optimizer searched over -- an honest walk-forward number instead of
        # one the optimization itself could inflate.
        improvement_pct = ((optimised_test / baseline_test - 1) * 100) if baseline_test > 0 else 0.0

        return {
            'category_weights': {k: round(float(v), 4) for k, v in opt_cat.items()},
            'source_weights':   {k: round(float(v), 4) for k, v in opt_src.items()},
            'optimised_objective': round(float(optimised_train), 6),
            'baseline_objective':  round(float(baseline_train), 6),
            'optimised_test_objective': round(float(optimised_test), 6),
            'baseline_test_objective':  round(float(baseline_test), 6),
            'baseline_win_rate':   round(float(base_wr), 4),
            'optimised_win_rate':  round(float(opt_wr), 4),
            'improvement_pct':     round(float(improvement_pct), 2),
            'training_samples':    len(df),
            'horizon_days':        horizon_days,
        }

    # ──────────────────────────────────────────────────────────────────────────
    # Per-screener weight refinement (fine-tuning on top of global optimisation)
    # ──────────────────────────────────────────────────────────────────────────

    def compute_screener_overrides(self, opt_weights: dict, train_frac: float = 0.8) -> dict[str, float]:
        """
        Compute per-screener weight multipliers based on historical signal count
        and win rate. Screeners that consistently appear in winning signals get
        a boost; those appearing in losing signals get penalised.

        Fit on the earlier train_frac of signal dates only, with the remaining dates
        held out purely to log a generalisation check. Previously this used ALL-history
        win rates with zero split before writing straight into screener_master
        .weight_override -- an in-sample fit with no signal of whether it generalises.
        """
        q = """
            SELECT sm.scan_id, sm.name, sm.source, sm.inferred_category,
                   so.signal_date, so.symbol, so.outcome
            FROM screener_master sm
            JOIN trendlyne_screener_stocks tss ON tss.screener_id = sm.scan_id
            JOIN signal_outcomes so ON so.symbol = tss.symbol
            WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
        """
        raw = self._read_df(q)
        if raw.empty:
            return {}
        raw['signal_date'] = pd.to_datetime(raw['signal_date'])
        raw = raw.sort_values('signal_date')
        dates = raw['signal_date'].unique()
        if len(dates) < 10:
            return {}
        cutoff = dates[int(len(dates) * train_frac)]
        train_raw, holdout_raw = raw[raw['signal_date'] <= cutoff], raw[raw['signal_date'] > cutoff]

        def _agg(rows: pd.DataFrame) -> pd.DataFrame:
            g = rows.groupby('scan_id').agg(
                appearances=('symbol', 'count'),
                wins=('outcome', lambda s: (s == 'WIN').sum()),
            )
            g = g[g['appearances'] >= 10]
            g['win_rate'] = g['wins'] / g['appearances']
            return g

        df = _agg(train_raw)
        if df.empty:
            return {}

        # Mean revert: weight = 0.8 + (win_rate / overall_win_rate) × 0.4, capped [0.5, 1.8]
        overall_wr = df['win_rate'].mean()
        if overall_wr <= 0:
            return {}

        df['weight_override'] = (0.8 + (df['win_rate'] / overall_wr) * 0.4).clip(0.5, 1.8)

        # Generalisation check: does the train-fit override direction agree with the
        # holdout window's actual win rate? Individual screeners can legitimately fail
        # this on a small holdout (kept as log-only, per-scan_id, by design), but a
        # NEGATIVE aggregate correlation means the override direction as a whole doesn't
        # generalise -- writing every scan_id's weight_override in that case is the
        # unconditional-apply-regardless-of-holdout-result pattern Finding #42 flagged
        # (same class of bug as optimise()'s pre-fix unconditional save/apply). Fixed by
        # gating the entire batch on the aggregate correlation, not filtering per screener.
        holdout_agg = _agg(holdout_raw)
        if not holdout_agg.empty:
            joined = df[['weight_override']].join(holdout_agg[['win_rate']], how='inner')
            if len(joined) >= 5:
                corr = joined['weight_override'].corr(joined['win_rate'])
                print(f"[Optimizer] screener override train->holdout win-rate correlation: {corr:.3f} "
                      f"(n={len(joined)})")
                if corr < 0:
                    print("[Optimizer] WARNING: screener overrides are NEGATIVELY correlated with "
                          "holdout win rate -- override direction does not generalise. Skipping "
                          "screener_master.weight_override write for this run.")
                    return {}

        overrides = {str(scan_id): round(float(w), 4) for scan_id, w in df['weight_override'].items()}
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
            RETURNING id
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
        new_id = cur.fetchone()[0]
        self.conn.commit()
        print(f"[Optimizer] Saved to screener_weight_history (id={new_id})")

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
        
        import requests
        try:
            requests.post("http://127.0.0.1:3000/api/internal/notify", json={
                "type": "SUCCESS",
                "title": "Optimization Complete",
                "message": "Strategy Optimizer finished. Weight overrides applied."
            }, timeout=2)
        except requests.RequestException:
            pass
            
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
                INSERT INTO app_settings (key, value, "updatedAt")
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"
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
            print(f"  {k:<15} {default:.2f} -> {v:.4f}  ({(v/default - 1)*100:+.1f}%)")

        print("\n[Optimizer] Optimised Source Weights:")
        for k, v in result['source_weights'].items():
            default = DEFAULT_SOURCE_WEIGHTS.get(k, 1.0)
            print(f"  {k:<15} {default:.2f} -> {v:.4f}  ({(v/default - 1)*100:+.1f}%)")

        print(f"\n[Optimizer] Win rate:  baseline={result['baseline_win_rate']:.1%}  "
              f"-> optimised={result['optimised_win_rate']:.1%}  "
              f"({result['improvement_pct']:+.1f}%)")

        overrides = self.compute_screener_overrides(result)
        print(f"[Optimizer] {len(overrides)} per-screener overrides computed.")

        if dry_run:
            print("[Optimizer] Dry-run: not saving.")
            return

        # Promotion gate (Finding #42, 2026-07-28 full-stack audit): optimise() already
        # computes an honest held-out test score and logs a warning when the optimised
        # weights underperform baseline on it -- but this used to save/apply regardless.
        # These weights are read by scoring_engine.py at startup and drive every score
        # platform-wide, so an overfit run must not reach app_settings at all, not just
        # log a warning about it. Matches the already-proven gate pattern in
        # backtest_optimizer.py (only updates app_settings when the holdout result beats
        # the constraint/baseline).
        if result['optimised_test_objective'] < result['baseline_test_objective']:
            print("[Optimizer] Optimised weights underperform baseline on held-out test data -- "
                  "NOT saving to screener_weight_history or applying to scoring_engine/screener_master.")
            return result

        self.save_to_history(result, overrides)
        self.apply_to_scoring_engine(result)
        if apply:
            self.apply_screener_overrides(overrides)

        print("[Optimizer] Done.")
        return result


from pydantic import BaseModel
class OptimizeRequest(BaseModel):
    horizon_days: int = 15
    iterations: int = 300
    dry_run: bool = False
    apply: bool = True


def run_optimizer(req: OptimizeRequest):
    opt = StrategyOptimizer()
    try:
        return opt.run(
            horizon_days=req.horizon_days,
            max_iterations=req.iterations,
            dry_run=req.dry_run,
            apply=req.apply,
        )
    finally:
        opt.close()


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
