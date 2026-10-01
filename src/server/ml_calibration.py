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
import math

from db_compat import connect, ConnWrapper, executemany_batched, safe_alter


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
    # win_probability = 0.5 exactly marks an UNSCORED signal — the legacy default written before
    # "unscored -> NULL" was fixed (e.g. the 2026-05-16..23 scoring outage). A real model score is
    # never exactly 0.5, and 0.5 carries no ranking/calibration information. Excluding it here is
    # load-bearing: training the isotonic map on that blob de-calibrates the entire 0.5 region and
    # feeds bad calibrated_win_probability into position sizing.
    # signal_source='technical' (2026-08): without this, a confluence-sourced outcome row that
    # happens to share (symbol, date) with an unrelated technical_signals row gets joined in
    # and treated as if it graded that signal's win_probability -- see the signal_outcomes
    # signal_source migration for the full mechanism.
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.date AS d,
               ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so
        JOIN technical_signals ts ON ts.symbol = so.symbol AND so.signal_date = ts.date
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5 AND so.signal_source = 'technical'
    """).fetchall()
    # Postgres allows storing float('nan') in a NOT NULL-satisfying column — filter those
    # out explicitly since IS NOT NULL doesn't catch NaN and isotonic regression rejects it.
    rows = [r for r in rows if not math.isnan(float(r['p']))]

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

    # Point-in-time (AF-20261001-45): only rows dated after every outcome in the fit are
    # (re)calibrated. Rewriting older rows nightly stamped each one with a calibrator fit on its
    # OWN later outcome -- a look-ahead that backtester.py then read as a historical signal.
    # Each row keeps the value it got from the last fit before its outcomes existed.
    fit_max = max(str(r['d'])[:10] for r in rows)
    sigs = conn.execute(
        "SELECT symbol, date, nifty_regime, win_probability, calibrated_win_probability "
        "FROM technical_signals "
        "WHERE win_probability IS NOT NULL AND win_probability <> 0.5 "   # skip unscored 0.5 defaults
        "AND date > ?",
        (fit_max,),
    ).fetchall()
    updated = 0
    changes = []
    for s in sigs:
        p = float(s['win_probability'])
        if math.isnan(p):
            continue
        ir = regime_cal.get(s['nifty_regime'], global_ir)
        new = calibrate(ir, p)
        updated += 1
        # This re-fits nightly over every scored row in history, and an UPDATE to an identical
        # value still writes a new tuple: measured 2026-09-11, 115,284 rewrites of which 36,485
        # (31.6%) changed value. Send only the changes, batched (one round trip per row was
        # 168s of the step against 83s batched, before this filter).
        old = s['calibrated_win_probability']
        if old is None or not math.isclose(float(old), new, rel_tol=0, abs_tol=1e-12):
            changes.append((new, s['symbol'], s['date']))
    executemany_batched(
        conn,
        "UPDATE technical_signals SET calibrated_win_probability = ? WHERE symbol = ? AND date = ?",
        changes,
    )
    conn.commit()
    for reg, m in regimes_meta.items():
        print(f"[Calibration] regime={reg} n={m['n']} days={m['distinct_days']} ep={m['episodes']} -> {m['used']}")
    print(f"[Calibration] fit on {len(rows)} WIN/LOSS signals; recalibrated {updated} rows "
          f"({len(changes)} changed value and were written).")
    return {'fit': True, 'n': len(rows), 'updated': updated, 'regimes': regimes_meta}


# ── Horizon-stratified AUC ───────────────────────────────────────────────────
# signal_outcomes holds one row per (symbol, signal_date, horizon_days), and the WIN rate is a
# property of the HORIZON, not just the model: measured live 2026-09-24 on the technical-source
# join -- 1d 8010/20941 = 38.2% WIN, 5d 21563/33625 = 64.1%, 15d 32996/41882 = 78.8%.
#
# Pooling those into one WIN/LOSS population and taking a single roc_auc_score measures the
# HORIZON rather than the model, because a ranking is only meaningful against a fixed base rate.
# The result is a textbook Simpson's paradox, and it was not subtle: HIGH_VOL's pooled AUC read
# 0.467 while EVERY one of its own strata read above it (1d 0.648, 5d 0.550, 15d 0.552). An
# average cannot be below all of its parts; the pooled number was reporting a base-rate artifact
# as model skill.
#
# Consequence: HIGH_VOL's regime_edge_weight was pinned at 0.0, silently discarding the edge the
# model actually has in that regime, and regime-edge-trust-floor warned on every single run.
#
# The fix is the standard one -- hold the base rate constant by scoring WITHIN each stratum and
# combining afterwards. The reported figure is the sample-size-weighted mean of the per-stratum
# AUCs, which (a) restores the correct discrimination estimate, (b) cannot fall outside the
# [min, max] range of its own strata, and (c) keeps larger horizons dominating the estimate.
AUC_MIN_STRATUM_N = 200   # a stratum smaller than this cannot support an AUC estimate
                          # (live h=2 n=25 and h=3 n=26 are noise, not signal)


def stratified_auc(pairs, min_n: int = 50, min_stratum_n: int = AUC_MIN_STRATUM_N):
    """Sample-size-weighted mean of the per-stratum AUCs of `pairs`.

    `pairs` is an iterable of (stratum_key, p, y). Strata that hold only one class are always
    dropped (roc_auc_score is undefined there). The `min_stratum_n` floor is applied ONLY when
    there is more than one stratum to aggregate -- its sole purpose is to stop a tiny stratum
    from swinging the sample-weighted mean, and a single-stratum population has no mean to
    protect: its estimate IS the whole population, governed by `min_n`. Applying it
    unconditionally silently deleted any single-horizon population below the floor -- including
    populations the previous pooled code scored -- which erases a regime from
    regime_edge_status for a data-SHAPE reason rather than a data-QUALITY one.

    Returns None when nothing survives, or when the surviving rows do not reach `min_n`.
    Otherwise {'n', 'auc', 'strata', 'dropped_strata'}.
    """
    from sklearn.metrics import roc_auc_score
    buckets: dict = {}
    for key, p, y in pairs:
        p = float(p)
        if not math.isfinite(p):   # stored float NaN/inf passes IS NOT NULL but roc_auc_score
            continue               # rejects it ("Input contains NaN"); isfinite also guards inf
        d = buckets.setdefault(key, {'p': [], 'y': []})
        d['p'].append(p)
        d['y'].append(int(y))

    pooled = len(buckets) == 1
    kept: dict = {}
    dropped: dict = {}
    for k, d in buckets.items():
        n = len(d['p'])
        if len(set(d['y'])) < 2 or (not pooled and n < min_stratum_n):
            dropped[k] = n
            continue
        kept[k] = (n, float(roc_auc_score(d['y'], d['p'])))

    if not kept:
        return None
    total = sum(n for n, _ in kept.values())
    if total < min_n:
        return None
    return {
        'n': total,
        'auc': sum(n * a for n, a in kept.values()) / total,
        'strata': {k: {'n': n, 'auc': a} for k, (n, a) in kept.items()},
        'dropped_strata': dropped,
    }


def stratified_calibration_slope(pairs, min_n: int = 50,
                                 min_stratum_n: int = AUC_MIN_STRATUM_N):
    """Sample-size-weighted mean of the per-stratum Brier-OPTIMAL shrinkage slopes.

    AUC answers "does this probability ORDER outcomes correctly". It cannot answer "is this
    probability the right SIZE", and the size is what edge_adjusted_probability() actually
    changes. Those come apart badly here -- measured live 2026-09-27, HIGH_VOL at h=1 has AUC
    0.648 (good ordering) while its probabilities average 0.790 against a realized 0.403 base
    rate, i.e. wildly over-confident. An AUC-driven weight reads that regime as trustworthy and
    leaves the over-confidence untouched (AF-20260927-08).

    So this measures the quantity the gate can actually fix. With d = p - 0.5, the gate applies
    p' = 0.5 + w*d, and the Brier score mean((0.5 + w*d - y)^2) is minimised in closed form at

        w* = sum(d * (y - 0.5)) / sum(d * d)

    -- the no-intercept OLS slope of outcome on (p - 0.5). Read it as: w* ~ 1 the probability is
    correctly scaled; w* < 1 over-confident, shrink; w* ~ 0 no usable information; w* < 0 the
    scale is INVERTED. Because it IS the optimum, no threshold constant is involved, which
    removes the failure mode that produced this finding (a floor calibrated against one statistic
    silently consumed by another -- see ml-model-bugs.md).

    Stratified per horizon and combined n-weighted, for exactly the reason stratified_auc() is:
    the WIN base rate is a property of the horizon (38%/64%/79% at 1/5/15d), so a no-intercept
    slope fitted across pooled horizons absorbs that level difference into the slope.

    Returns None when nothing survives, else {'n', 'slope', 'strata', 'dropped_strata'}.
    """
    buckets: dict = {}
    for key, p, y in pairs:
        p = float(p)
        if not math.isfinite(p):
            continue
        d = buckets.setdefault(key, {'d': [], 'y': []})
        d['d'].append(p - 0.5)
        d['y'].append(int(y))

    pooled = len(buckets) == 1
    kept: dict = {}
    dropped: dict = {}
    for k, d in buckets.items():
        n = len(d['d'])
        den = sum(x * x for x in d['d'])
        if len(set(d['y'])) < 2 or (not pooled and n < min_stratum_n) or den <= 0:
            dropped[k] = n
            continue
        num = sum(x * (y - 0.5) for x, y in zip(d['d'], d['y']))
        kept[k] = (n, num / den)

    if not kept:
        return None
    total = sum(n for n, _ in kept.values())
    if total < min_n:
        return None
    return {
        'n': total,
        'slope': sum(n * s for n, s in kept.values()) / total,
        'strata': {k: {'n': n, 'slope': s} for k, (n, s) in kept.items()},
        'dropped_strata': dropped,
    }


def per_regime_calibration_slope(conn: ConnWrapper, min_n: int = 50) -> dict:
    """Horizon-stratified Brier-optimal shrinkage slope per regime (see
    stratified_calibration_slope). Same join as per_regime_auc, so the two are comparable."""
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, so.horizon_days AS horizon, ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5 AND so.signal_source = 'technical'
    """).fetchall()
    g: dict = {}
    for r in rows:
        g.setdefault(r['regime'], []).append((r['horizon'], r['p'], r['y']))
    out: dict = {}
    for reg, pairs in g.items():
        res = stratified_calibration_slope(pairs, min_n=min_n)
        if res:
            out[reg] = res
            per_h = ' '.join(f"{k}d={v['slope']:+.3f}(n={v['n']})"
                             for k, v in sorted(res['strata'].items()))
            print(f"[Calibration] per-regime shrinkage slope {reg}: {res['slope']:+.3f} "
                  f"(n={res['n']}) [{per_h}]")
    return out


def _pooled_calibration_slope(conn: ConnWrapper, min_n: int = 50):
    """The __GLOBAL__ fallback slope, horizon-stratified across all regimes."""
    rows = conn.execute("""
        SELECT so.horizon_days AS horizon, ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5 AND so.signal_source = 'technical'
    """).fetchall()
    return stratified_calibration_slope(
        [(r['horizon'], r['p'], r['y']) for r in rows], min_n=min_n)


def per_regime_auc(conn: ConnWrapper, min_n: int = 50) -> dict:
    """Horizon-stratified win_probability vs WIN/LOSS AUC per regime. See stratified_auc() for
    why the horizons are scored separately rather than pooled."""
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, so.horizon_days AS horizon, ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5          -- exclude unscored 0.5 defaults (see recalibrate)
          AND so.signal_source = 'technical'
    """).fetchall()
    g: dict = {}
    for r in rows:
        g.setdefault(r['regime'], []).append((r['horizon'], r['p'], r['y']))
    out: dict = {}
    for reg, pairs in g.items():
        res = stratified_auc(pairs, min_n=min_n)
        if res:
            out[reg] = res
            per_h = ' '.join(f"{k}d={v['auc']:.3f}(n={v['n']})" for k, v in sorted(res['strata'].items()))
            print(f"[Calibration] per-regime AUC {reg}: {res['auc']:.3f} (n={res['n']}) "
                  f"[{per_h}]")
    return out


def regime_readiness(conn: ConnWrapper, min_regime_days: int = 20, min_regime_episodes: int = 2) -> dict:
    """Per-regime distinct-days/episodes coverage + ready flag (whether it clears the floor)."""
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.date AS d
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5          -- exclude unscored 0.5 defaults (see recalibrate)
          AND so.signal_source = 'technical'
    """).fetchall()
    g: dict = {}
    for r in rows:
        g.setdefault(r['regime'], []).append(str(r['d']))
    out: dict = {}
    for reg, days in g.items():
        dd = len(set(days))
        ep = count_episodes(days)
        out[reg] = {'n': len(days), 'distinct_days': dd, 'episodes': ep,
                    'first_day': min(days), 'last_day': max(days),
                    'ready': dd >= min_regime_days and ep >= min_regime_episodes}
        print(f"[Calibration] readiness {reg}: days={dd} ep={ep} ready={out[reg]['ready']}")
    return out


# ── Regime Edge Status Persistence ───────────────────────────────────────────
#
# per_regime_auc/regime_readiness above are print-only -- nothing persists them, so no
# consumer can read "does this regime's win_probability currently carry live edge?" without
# recomputing the join itself. This snapshots both (plus a pooled global AUC) into a small
# table every consumer can read cheaply.

_EDGE_STATUS_DDL = """
CREATE TABLE IF NOT EXISTS regime_edge_status (
    regime         TEXT PRIMARY KEY,
    auc            REAL,
    auc_n          INTEGER,
    distinct_days  INTEGER,
    episodes       INTEGER,
    ready          INTEGER NOT NULL DEFAULT 0,
    first_day      TEXT,
    last_day       TEXT,
    computed_at    TEXT NOT NULL,
    calib_slope    REAL,
    calib_slope_n  INTEGER
)
"""


def ensure_edge_status_table(conn: ConnWrapper) -> None:
    conn.execute(_EDGE_STATUS_DDL)
    # CREATE TABLE IF NOT EXISTS no-ops on an existing table, so columns added after the table
    # first shipped need an explicit ALTER or they silently never appear (bugs-data-layer.md's
    # stale-inline-DDL class). safe_alter is passed `conn` on purpose: these run in the same
    # still-open transaction as the CREATE above, and a private connection cannot see an
    # uncommitted table (AF-20260917-19).
    for ddl in (
        "ALTER TABLE regime_edge_status ADD COLUMN IF NOT EXISTS calib_slope REAL",
        "ALTER TABLE regime_edge_status ADD COLUMN IF NOT EXISTS calib_slope_n INTEGER",
    ):
        safe_alter(conn, ddl)
    conn.commit()


def _pooled_auc(conn: ConnWrapper, min_n: int = 50):
    """Same join as per_regime_auc but across ALL regimes -- the fallback trust level
    regime_edge_weight() uses when a specific regime hasn't cleared the readiness floor.

    Horizon-stratified for the same reason per_regime_auc is (see stratified_auc): pooling the
    1d/5d/15d populations measures the horizon, not the model. This matters MORE here than for
    the per-regime rows, because __GLOBAL__ is the fallback every not-ready regime inherits -- a
    base-rate artifact in the global row silently degrades regimes that never asked for it.
    """
    rows = conn.execute("""
        SELECT so.horizon_days AS horizon, ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5 AND so.signal_source = 'technical'
    """).fetchall()
    return stratified_auc(
        [(r['horizon'], r['p'], r['y']) for r in rows], min_n=min_n)


def _upsert_edge_status_row(conn: ConnWrapper, row: dict) -> None:
    conn.execute("""
        INSERT INTO regime_edge_status
            (regime, auc, auc_n, distinct_days, episodes, ready, first_day, last_day, computed_at,
             calib_slope, calib_slope_n)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(regime) DO UPDATE SET
            auc = excluded.auc, auc_n = excluded.auc_n,
            distinct_days = excluded.distinct_days, episodes = excluded.episodes,
            ready = excluded.ready, first_day = excluded.first_day,
            last_day = excluded.last_day, computed_at = excluded.computed_at,
            calib_slope = excluded.calib_slope, calib_slope_n = excluded.calib_slope_n
    """, (
        row['regime'], row.get('auc'), row.get('auc_n'),
        row.get('distinct_days'), row.get('episodes'),
        1 if row.get('ready') else 0,
        row.get('first_day'), row.get('last_day'), row['computed_at'],
        row.get('calib_slope'), row.get('calib_slope_n'),
    ))


def persist_regime_edge_status(conn: ConnWrapper, min_n: int = 50,
                                min_regime_days: int = 20, min_regime_episodes: int = 2) -> dict:
    """Snapshot per_regime_auc + regime_readiness + a pooled global AUC into regime_edge_status.
    Stateless: every call fully recomputes from the live join and UPSERTs -- no decay/hysteresis,
    so a regime's status re-arms automatically the next time this runs once its live numbers
    cross back over the trust floor (see regime_edge_weight)."""
    ensure_edge_status_table(conn)
    auc = per_regime_auc(conn, min_n=min_n)
    readiness = regime_readiness(conn, min_regime_days, min_regime_episodes)
    pooled = _pooled_auc(conn, min_n=min_n)
    # The weight regime_edge_weight() actually applies. AUC is still persisted beside it because
    # regime-edge-trust-floor and the digests report it, but it no longer drives the weight.
    slope = per_regime_calibration_slope(conn, min_n=min_n)
    pooled_slope = _pooled_calibration_slope(conn, min_n=min_n)
    now = _dt.datetime.utcnow().isoformat()

    out: dict = {}
    for reg in (set(auc) | set(readiness) | set(slope)):
        key = reg if reg is not None else 'UNKNOWN'
        a = auc.get(reg, {})
        r = readiness.get(reg, {})
        s = slope.get(reg, {})
        row = dict(regime=key, auc=a.get('auc'), auc_n=a.get('n'),
                   distinct_days=r.get('distinct_days'), episodes=r.get('episodes'),
                   ready=bool(r.get('ready', False)), first_day=r.get('first_day'),
                   last_day=r.get('last_day'), computed_at=now,
                   calib_slope=s.get('slope'), calib_slope_n=s.get('n'))
        _upsert_edge_status_row(conn, row)
        out[key] = row

    if pooled is not None:
        row = dict(regime='__GLOBAL__', auc=pooled['auc'], auc_n=pooled['n'],
                   distinct_days=None, episodes=None, ready=True,
                   first_day=None, last_day=None, computed_at=now,
                   calib_slope=(pooled_slope or {}).get('slope'),
                   calib_slope_n=(pooled_slope or {}).get('n'))
        _upsert_edge_status_row(conn, row)
        out['__GLOBAL__'] = row

    conn.commit()
    print(f"[Calibration] edge status persisted for {len(out)} regime rows.")
    return out


def load_regime_edge_status(conn: ConnWrapper) -> dict:
    """Read the last persisted per-regime edge snapshot. Returns {} if the table doesn't exist
    yet or is empty -- callers must treat that as 'no data', which regime_edge_weight() already
    treats as full trust (weight=1.0, no-op) rather than assuming no edge."""
    _LEGACY = ("SELECT regime, auc, auc_n, distinct_days, episodes, ready, first_day, last_day, "
               "computed_at FROM regime_edge_status")
    has_slope = True
    try:
        rows = conn.execute(_LEGACY.replace(
            "computed_at FROM", "computed_at, calib_slope, calib_slope_n FROM")).fetchall()
    except Exception:
        # Deploy-order safety net (AF-20260927-08): if this code is live before migration
        # 20260927160000 has been applied, the two new columns do not exist yet. Letting that fall
        # through to the outer `return {}` would be the WORST outcome -- an empty snapshot is the
        # "no data" branch, which regime_edge_weight() deliberately treats as FULL trust, so a
        # missing column would silently disable the gate AND lose the AUC fallback with it. Retry
        # on the legacy column set instead: the AUC path still applies, and the gate degrades to
        # its previous behaviour rather than to no behaviour.
        has_slope = False
        try:
            conn.rollback()   # the failed SELECT aborted the transaction on Postgres
        except Exception:
            pass
        try:
            rows = conn.execute(_LEGACY).fetchall()
        except Exception:
            return {}   # table genuinely absent -- the documented "no data" case
    out = {}
    for r in rows:
        out[r['regime']] = {
            'auc': r['auc'], 'auc_n': r['auc_n'],
            'distinct_days': r['distinct_days'], 'episodes': r['episodes'],
            'ready': bool(r['ready']), 'first_day': r['first_day'],
            'last_day': r['last_day'], 'computed_at': r['computed_at'],
            'calib_slope': r['calib_slope'] if has_slope else None,
            'calib_slope_n': r['calib_slope_n'] if has_slope else None,
        }
    return out


# ── Regime-Conditional Edge Weighting ────────────────────────────────────────
#
# win_probability has real live discrimination only in some regimes (e.g. BEAR AUC~0.61) and
# ~coin-flip elsewhere (BULL/SIDEWAYS AUC~0.50). Consumers (ml_ensemble's expiry gate,
# scoring_engine's ML bonus/discount, unified_ranker's position sizing) should trust the
# probability in proportion to its regime's PROVEN discrimination, not treat every regime the
# same. These are pure functions -- no DB access -- callers pass in the edge_status dict already
# loaded via load_regime_edge_status().

AUC_RANDOM = 0.50        # coin-flip baseline -- an AUC at/below this carries zero rank information
AUC_TRUST_FLOOR = 0.55   # empirically: BEAR sits ~0.61 (trust), BULL/SIDEWAYS sit ~0.50 (no edge)


def is_edge_adjustment_enabled(conn: ConnWrapper) -> bool:
    """Feature flag gating the three win_probability consumers' edge-adjustment wiring
    (ml_ensemble's expiry gate, scoring_engine's discount/bonus, unified_ranker's sizing).
    Defaults to OFF (missing row) so shipping the persistence/table work is inert on its own --
    a true kill switch without a redeploy. Flip with:
      UPDATE app_settings SET value='true' WHERE key='edge_adjustment_enabled';
      -- or INSERT if the key has never been set."""
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'edge_adjustment_enabled'"
    ).fetchone()
    return bool(row) and row['value'] == 'true'


def collapse_regime5(regime):
    """5-state HMM regime (market_regimes.regime / app_settings.current_nifty_regime) -> the
    3-class taxonomy technical_signals.nifty_regime / regime_edge_status use. Mirrors
    backfill_technical_features.py's get_regime() closure verbatim -- keep both in sync; a
    mismatch here would make HIGH_VOL/CRASH silently miss the regime_edge_status lookup and
    fall through to the 'no data -> weight=1.0' branch, silently disabling this feature for
    those two states."""
    if not regime:
        return None
    if regime in ('BULL', 'SIDEWAYS'):
        return regime
    return 'BEAR'   # HIGH_VOL | BEAR | CRASH


def regime_edge_weight(regime, edge_status: dict,
                        auc_random: float = AUC_RANDOM, auc_trust_floor: float = AUC_TRUST_FLOOR) -> float:
    """0..1 confidence weight for how much win_probability can be trusted in `regime` today, per
    a persisted regime_edge_status snapshot (see load_regime_edge_status).

    **Driven by `calib_slope` since 2026-09-27 (AF-20260927-08), not by AUC.** The gate applies
    p' = 0.5 + w*(p-0.5), so w is a SCALE on the probability -- and AUC cannot measure scale, only
    ordering. Measured live, the two disagree sharply: HIGH_VOL read AUC 0.648 at h=1 (ordering
    fine) while its probabilities averaged 0.790 against a realized 0.403 base rate (badly
    over-confident), so the AUC-driven weight granted FULL trust to the most over-confident
    stratum in the panel. The measured Brier-optimal slope reads < 1 in every regime
    (BEAR 0.43 / CRASH 0.32 / HIGH_VOL 0.75 / SIDEWAYS 0.36), and in 10 of 14 regime x horizon
    strata the old w=1.0 scored WORSE by Brier than switching the regime off entirely.

    Using the optimum directly also removes the bug class that produced this finding: there is no
    threshold between the measurement and the weight, so re-deriving the statistic can no longer
    silently invalidate a constant (AUC_TRUST_FLOOR had been calibrated against the POOLED AUC and
    was never re-derived when per_regime_auc switched to a stratified one, which made this gate a
    constant 1.0 for every regime -- see ml-model-bugs.md).

    Fallback order for whichever field drives the weight (most to least trusted):
      1. the regime's OWN auc, only if edge_status[regime]['ready'] is True (clears the
         distinct-days/episode floor) -- an un-ready regime's AUC may be one autocorrelated
         episode (the same concurrency problem recalibrate_win_probabilities already guards
         against for the isotonic fit).
      2. the 3-class collapsed regime's auc (collapse_regime5), if the 5-class regime's own row
         isn't ready -- e.g. HIGH_VOL/CRASH borrowing BEAR's reading when they individually
         lack enough history yet.
      3. the pooled '__GLOBAL__' auc, if present.
      4. neither available -> weight = 1.0 (pass through unchanged). Absence of evidence is not
         evidence of no edge.

    Live bug, 2026-08-10: this used to collapse straight to the 3-class key BEFORE ever checking
    edge_status, so HIGH_VOL/CRASH could never reach their OWN row even when
    persist_regime_edge_status() had already computed and stored one (confirmed live: HIGH_VOL's
    own AUC was 0.518 -- no edge -- while it was silently borrowing BEAR's 0.61-0.65 -- proven
    edge -- meaning a HIGH_VOL-regime probability was never actually shrunk at all). The raw
    5-class regime is now checked first, exactly as this docstring already claimed.

    weight = clip((auc_used - auc_random) / (auc_trust_floor - auc_random), 0, 1)
    """
    def _ready_field(key, field):
        row = edge_status.get(key)
        return row[field] if (row and row.get('ready') and row.get(field) is not None) else None

    def _resolve(field):
        """Same 3-tier trust order for whichever field drives the weight."""
        raw_key = regime if regime is not None else 'UNKNOWN'
        v = _ready_field(raw_key, field)
        if v is None:
            reg3 = collapse_regime5(regime)
            v = _ready_field(reg3 if reg3 is not None else 'UNKNOWN', field)
        if v is None:
            g = edge_status.get('__GLOBAL__')
            v = g[field] if (g and g.get(field) is not None) else None
        return v

    # PREFERRED (AF-20260927-08): the measured Brier-optimal shrinkage slope. It IS the weight
    # that minimises probabilistic error, so no threshold constant sits between the measurement
    # and the weight -- which is what went wrong with the AUC path below. A negative slope means
    # the probability's scale is inverted; clamping to 0 collapses it to 0.5 ("no opinion",
    # bet_size 0) rather than letting an inverted signal through at negative weight.
    slope = _resolve('calib_slope')
    if slope is not None:
        return max(0.0, min(1.0, float(slope)))

    # FALLBACK, kept deliberately: a snapshot written before calib_slope existed (or a regime
    # whose slope did not clear its sample floor) still gets the old AUC-vs-floor behaviour
    # rather than silently jumping to full trust. Do NOT treat this path as equivalent -- AUC
    # measures ORDERING and cannot see over-confidence, which is why HIGH_VOL read AUC 0.648
    # while averaging p=0.790 against a 0.403 base rate.
    auc_used = _resolve('auc')
    if auc_used is None:
        return 1.0
    return max(0.0, min(1.0, (auc_used - auc_random) / (auc_trust_floor - auc_random)))


def edge_adjusted_probability(p, regime, edge_status: dict,
                               auc_random: float = AUC_RANDOM, auc_trust_floor: float = AUC_TRUST_FLOOR):
    """Shrink `p` toward the neutral 0.5 point in proportion to regime_edge_weight(regime).
    weight=1 (proven edge, or not enough data to judge) -> p unchanged.
    weight=0 (proven no edge, AUC<=auc_random) -> collapses exactly to 0.5, the neutral point
    every consumer already treats as 'no opinion' (bet_size_from_probability(<=0.5)==0,
    _REGIME_THRESHOLDS are all <0.5, scoring_engine's bonus/discount bands straddle 0.5).
    Shrinking toward 0.5 -- not the regime's empirical base rate -- is a deliberate choice to
    match those existing conventions."""
    if p is None:
        return None
    w = regime_edge_weight(regime, edge_status, auc_random, auc_trust_floor)
    return 0.5 + w * (float(p) - 0.5)


def run():
    conn = connect()
    try:
        recalibrate_win_probabilities(conn)
        regime_readiness(conn)
        per_regime_auc(conn)
        persist_regime_edge_status(conn)
    finally:
        conn.close()


if __name__ == '__main__':
    run()
