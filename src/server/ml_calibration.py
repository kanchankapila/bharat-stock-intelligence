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


def recalibrate_win_probabilities(conn: ConnWrapper, min_samples: int = 200) -> dict:
    """Fit isotonic on resolved WIN/LOSS signals, write calibrated_win_probability for all
    technical_signals that have a raw win_probability. Idempotent."""
    rows = conn.execute("""
        SELECT ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so
        JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
    """).fetchall()

    if len(rows) < min_samples:
        print(f"[Calibration] insufficient data ({len(rows)} < {min_samples}); skipping.")
        return {'fit': False, 'reason': 'insufficient', 'n': len(rows)}

    preds = [float(r['p']) for r in rows]
    ys = [int(r['y']) for r in rows]
    if len(set(ys)) < 2:
        print("[Calibration] only one outcome class; skipping.")
        return {'fit': False, 'reason': 'one_class', 'n': len(rows)}

    ir = fit_calibrator(preds, ys)

    sigs = conn.execute(
        "SELECT symbol, date, win_probability FROM technical_signals WHERE win_probability IS NOT NULL"
    ).fetchall()
    cal_values = ir.predict([float(s['win_probability']) for s in sigs])
    updated = 0
    for s, cal in zip(sigs, cal_values):
        conn.execute(
            "UPDATE technical_signals SET calibrated_win_probability = ? WHERE symbol = ? AND date = ?",
            (float(cal), s['symbol'], s['date']),
        )
        updated += 1
    conn.commit()
    print(f"[Calibration] fit on {len(rows)} WIN/LOSS signals; recalibrated {updated} rows.")
    return {'fit': True, 'n': len(rows), 'updated': updated}


def run():
    conn = connect()
    try:
        recalibrate_win_probabilities(conn)
    finally:
        conn.close()


if __name__ == '__main__':
    run()
