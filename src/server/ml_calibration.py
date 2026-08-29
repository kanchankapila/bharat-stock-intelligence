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
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode
import datetime as _dt
import math

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
        JOIN technical_signals ts ON ts.symbol = so.symbol AND so.signal_date = ts.date::text
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
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

    sigs = conn.execute(
        "SELECT symbol, date, nifty_regime, win_probability FROM technical_signals "
        "WHERE win_probability IS NOT NULL AND win_probability <> 0.5"   # skip unscored 0.5 defaults
    ).fetchall()
    updated = 0
    for s in sigs:
        p = float(s['win_probability'])
        if math.isnan(p):
            continue
        ir = regime_cal.get(s['nifty_regime'], global_ir)
        conn.execute(
            "UPDATE technical_signals SET calibrated_win_probability = ? WHERE symbol = ? AND date = ?",
            (calibrate(ir, p), s['symbol'], s['date']),
        )
        updated += 1
    conn.commit()
    for reg, m in regimes_meta.items():
        print(f"[Calibration] regime={reg} n={m['n']} days={m['distinct_days']} ep={m['episodes']} -> {m['used']}")
    print(f"[Calibration] fit on {len(rows)} WIN/LOSS signals; recalibrated {updated} rows.")
    return {'fit': True, 'n': len(rows), 'updated': updated, 'regimes': regimes_meta}


def per_regime_auc(conn: ConnWrapper, min_n: int = 50) -> dict:
    """Raw win_probability vs WIN/LOSS AUC per regime (≥2 classes, ≥min_n rows)."""
    from sklearn.metrics import roc_auc_score
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date::text
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5          -- exclude unscored 0.5 defaults (see recalibrate)
          AND so.signal_source = 'technical'
    """).fetchall()
    g: dict = {}
    for r in rows:
        p = float(r['p'])
        if not math.isfinite(p):   # stored float NaN/inf passes IS NOT NULL but roc_auc_score
            continue               # rejects it ("Input contains NaN"); isfinite also guards inf
        d = g.setdefault(r['regime'], {'p': [], 'y': []})
        d['p'].append(p)
        d['y'].append(int(r['y']))
    out: dict = {}
    for reg, d in g.items():
        if len(d['p']) >= min_n and len(set(d['y'])) >= 2:
            out[reg] = {'n': len(d['p']), 'auc': float(roc_auc_score(d['y'], d['p']))}
            print(f"[Calibration] per-regime AUC {reg}: {out[reg]['auc']:.3f} (n={out[reg]['n']})")
    return out


def regime_readiness(conn: ConnWrapper, min_regime_days: int = 20, min_regime_episodes: int = 2) -> dict:
    """Per-regime distinct-days/episodes coverage + ready flag (whether it clears the floor)."""
    rows = conn.execute("""
        SELECT ts.nifty_regime AS regime, ts.date AS d
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date::text
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
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
    computed_at    TEXT NOT NULL
)
"""


def ensure_edge_status_table(conn: ConnWrapper) -> None:
    conn.execute(_EDGE_STATUS_DDL)
    conn.commit()


def _pooled_auc(conn: ConnWrapper, min_n: int = 50):
    """Same join as per_regime_auc but pooled across ALL regimes -- the fallback trust level
    regime_edge_weight() uses when a specific regime hasn't cleared the readiness floor."""
    from sklearn.metrics import roc_auc_score
    rows = conn.execute("""
        SELECT ts.win_probability AS p,
               CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END AS y
        FROM signal_outcomes so JOIN technical_signals ts
          ON ts.symbol = so.symbol AND so.signal_date = ts.date::text
        WHERE so.outcome IN ('WIN', 'LOSS') AND ts.win_probability IS NOT NULL
          AND ts.win_probability <> 0.5 AND so.signal_source = 'technical'
    """).fetchall()
    pairs = [(float(r['p']), int(r['y'])) for r in rows if math.isfinite(float(r['p']))]
    if len(pairs) < min_n or len({y for _, y in pairs}) < 2:
        return None
    p = [x[0] for x in pairs]
    y = [x[1] for x in pairs]
    return {'n': len(p), 'auc': float(roc_auc_score(y, p))}


def _upsert_edge_status_row(conn: ConnWrapper, row: dict) -> None:
    conn.execute("""
        INSERT INTO regime_edge_status
            (regime, auc, auc_n, distinct_days, episodes, ready, first_day, last_day, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(regime) DO UPDATE SET
            auc = excluded.auc, auc_n = excluded.auc_n,
            distinct_days = excluded.distinct_days, episodes = excluded.episodes,
            ready = excluded.ready, first_day = excluded.first_day,
            last_day = excluded.last_day, computed_at = excluded.computed_at
    """, (
        row['regime'], row.get('auc'), row.get('auc_n'),
        row.get('distinct_days'), row.get('episodes'),
        1 if row.get('ready') else 0,
        row.get('first_day'), row.get('last_day'), row['computed_at'],
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
    now = _dt.datetime.utcnow().isoformat()

    out: dict = {}
    for reg in (set(auc) | set(readiness)):
        key = reg if reg is not None else 'UNKNOWN'
        a = auc.get(reg, {})
        r = readiness.get(reg, {})
        row = dict(regime=key, auc=a.get('auc'), auc_n=a.get('n'),
                   distinct_days=r.get('distinct_days'), episodes=r.get('episodes'),
                   ready=bool(r.get('ready', False)), first_day=r.get('first_day'),
                   last_day=r.get('last_day'), computed_at=now)
        _upsert_edge_status_row(conn, row)
        out[key] = row

    if pooled is not None:
        row = dict(regime='__GLOBAL__', auc=pooled['auc'], auc_n=pooled['n'],
                   distinct_days=None, episodes=None, ready=True,
                   first_day=None, last_day=None, computed_at=now)
        _upsert_edge_status_row(conn, row)
        out['__GLOBAL__'] = row

    conn.commit()
    print(f"[Calibration] edge status persisted for {len(out)} regime rows.")
    return out


def load_regime_edge_status(conn: ConnWrapper) -> dict:
    """Read the last persisted per-regime edge snapshot. Returns {} if the table doesn't exist
    yet or is empty -- callers must treat that as 'no data', which regime_edge_weight() already
    treats as full trust (weight=1.0, no-op) rather than assuming no edge."""
    try:
        rows = conn.execute(
            "SELECT regime, auc, auc_n, distinct_days, episodes, ready, first_day, last_day, computed_at "
            "FROM regime_edge_status"
        ).fetchall()
    except Exception:
        return {}
    out = {}
    for r in rows:
        out[r['regime']] = {
            'auc': r['auc'], 'auc_n': r['auc_n'],
            'distinct_days': r['distinct_days'], 'episodes': r['episodes'],
            'ready': bool(r['ready']), 'first_day': r['first_day'],
            'last_day': r['last_day'], 'computed_at': r['computed_at'],
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
    """0..1 confidence weight for how much live discriminative edge win_probability carries in
    `regime` today, per a persisted regime_edge_status snapshot (see load_regime_edge_status).

    Source of the AUC used (most to least trusted):
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
    def _ready_auc(key):
        row = edge_status.get(key)
        return row['auc'] if (row and row.get('ready') and row.get('auc') is not None) else None

    raw_key = regime if regime is not None else 'UNKNOWN'
    auc_used = _ready_auc(raw_key)
    if auc_used is None:
        reg3 = collapse_regime5(regime)
        key = reg3 if reg3 is not None else 'UNKNOWN'
        auc_used = _ready_auc(key)
    if auc_used is None:
        g = edge_status.get('__GLOBAL__')
        auc_used = g['auc'] if (g and g.get('auc') is not None) else None
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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
