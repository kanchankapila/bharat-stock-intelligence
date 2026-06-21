"""
Post-hoc isotonic recalibration of the ML win_probability meta-label.

ml_ensemble calibrates each base model (CalibratedClassifierCV), but stacking them
de-calibrates the final probability: live reliability shows win_probability spanning
0.07–0.95 while the true WIN/LOSS rate only spans ~0.33–0.57, and it's non-monotonic
(0.65–0.85 predictions actually win 0.41–0.45, i.e. BELOW 0.5). That miscalibration
directly corrupts position sizing (bet_size_from_probability treats win_probability as a
true probability) and the 0.40 gate.

This fits an isotonic map from win_probability -> empirical WIN rate (on the dense
signal_outcomes WIN/LOSS labels the ensemble trains on) and writes a calibrated value to
technical_signals.calibrated_win_probability. Downstream (sizing, gating) should prefer the
calibrated column.

  python ml_calibration.py
"""
import datetime as _dt

from db_compat import connect, ConnWrapper


def count_episodes(days, gap_days: int = 5) -> int:
    """Number of distinct episodes in a set of ISO dates: a gap > gap_days starts a new one."""
    uniq = sorted(set(days))
    if not uniq:
        return 0
    episodes = 1
    prev = _dt.date.fromisoformat(uniq[0])
    for d in uniq[1:]:
        cur = _dt.date.fromisoformat(d)
        if (cur - prev).days > gap_days:
            episodes += 1
        prev = cur
    return episodes


def fit_calibrator(pred_probs, outcomes):
    """Isotonic regression mapping predicted probability -> empirical win rate (outcomes 0/1)."""
    from sklearn.isotonic import IsotonicRegression
    ir = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds='clip')
    ir.fit(list(pred_probs), list(outcomes))
    return ir


def calibrate(ir, p) -> float:
    return float(ir.predict([float(p)])[0])


def recalibrate_win_probabilities(conn: ConnWrapper, min_samples: int = 200,
                                  min_regime_days: int = 20, min_regime_episodes: int = 2) -> dict:
    """Fit isotonic on resolved WIN/LOSS signals and write calibrated_win_probability for all
    technical_signals with a raw win_probability. A regime gets its OWN calibrator only when it
    clears min_regime_days distinct days AND min_regime_episodes episodes AND has ≥2 classes;
    otherwise it falls back to the global calibrator. Idempotent."""
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.date AS d,
               ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so
        JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
    """).fetchall()

    if len(rows) < min_samples:
        print(f"[Calibration] insufficient data ({len(rows)} < {min_samples}); skipping.")
        return {'fit': False, 'reason': 'insufficient', 'n': len(rows)}

    all_p = [float(r['p']) for r in rows]
    all_y = [int(r['y']) for r in rows]
    if len(set(all_y)) < 2:
        print("[Calibration] only one outcome class; skipping.")
        return {'fit': False, 'reason': 'one_class', 'n': len(rows)}
    global_ir = fit_calibrator(all_p, all_y)

    by_regime: dict = {}
    for r in rows:
        g = by_regime.setdefault(r['regime'], {'p': [], 'y': [], 'days': []})
        g['p'].append(float(r['p']))
        g['y'].append(int(r['y']))
        g['days'].append(str(r['d']))

    regime_cal: dict = {}
    regimes_meta: dict = {}
    for reg, g in by_regime.items():
        dd = len(set(g['days']))
        ep = count_episodes(g['days'])
        qualifies = (reg is not None and dd >= min_regime_days and ep >= min_regime_episodes
                     and len(set(g['y'])) >= 2)
        if qualifies:
            regime_cal[reg] = fit_calibrator(g['p'], g['y'])
        regimes_meta[reg] = {'n': len(g['p']), 'distinct_days': dd, 'episodes': ep,
                             'used': 'regime' if qualifies else 'global'}

    sigs = conn.execute(
        "SELECT symbol, date, nifty_regime, win_probability FROM technical_signals WHERE win_probability IS NOT NULL"
    ).fetchall()
    updated = 0
    for s in sigs:
        ir = regime_cal.get(s['nifty_regime'], global_ir)
        conn.execute(
            "UPDATE technical_signals SET calibrated_win_probability = ? WHERE symbol = ? AND date = ?",
            (calibrate(ir, float(s['win_probability'])), s['symbol'], s['date']),
        )
        updated += 1
    conn.commit()
    for reg, m in regimes_meta.items():
        print(f"[Calibration] regime={reg} n={m['n']} days={m['distinct_days']} ep={m['episodes']} -> {m['used']}")
    print(f"[Calibration] fit on {len(rows)} WIN/LOSS signals; recalibrated {updated} rows.")
    return {'fit': True, 'n': len(rows), 'updated': updated, 'regimes': regimes_meta}


def run():
    conn = connect()
    try:
        recalibrate_win_probabilities(conn)
    finally:
        conn.close()


if __name__ == '__main__':
    run()
