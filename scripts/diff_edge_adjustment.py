"""
diff_edge_adjustment.py — read-only before/after check for the regime-edge-adjustment feature
(app_settings.edge_adjustment_enabled) added to ml_ensemble.py / scoring_engine.py /
unified_ranker.py. Makes NO writes. Run before flipping the flag on in production.

  python scripts/diff_edge_adjustment.py
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'server'))

from db_compat import connect
from ml_calibration import (
    persist_regime_edge_status, load_regime_edge_status,
    regime_edge_weight, edge_adjusted_probability,
)


def section(title):
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def main():
    conn = connect()

    section("1. Current regime_edge_status snapshot")
    edge_status = persist_regime_edge_status(conn)
    for reg, row in sorted(edge_status.items(), key=lambda kv: str(kv[0])):
        auc = f"{row['auc']:.3f}" if row['auc'] is not None else "n/a"
        w = regime_edge_weight(reg if reg != '__GLOBAL__' else None, edge_status) if reg != '__GLOBAL__' else None
        print(f"  {reg:>10}  auc={auc:>6}  ready={row['ready']!s:>5}  "
              f"n={row.get('auc_n')}  days={row.get('distinct_days')}  ep={row.get('episodes')}")

    section("2. ml_ensemble expiry gate: recommendation_log ACTIVE rows that would flip")
    rows = conn.execute("""
        SELECT id, symbol, signal_date, win_probability, nifty_regime
        FROM recommendation_log
        WHERE status = 'ACTIVE' AND source = 'technical_scan'
    """).fetchall()
    from ml_ensemble import regime_threshold
    threshold = regime_threshold(conn)
    import datetime
    cutoff_date = (datetime.date.today() - datetime.timedelta(days=2)).isoformat()
    flips = 0
    for r in rows:
        wp = r['win_probability']
        old_expire = (wp is not None and wp < threshold) or (wp is None and str(r['signal_date']) < cutoff_date)
        if wp is None:
            new_expire = str(r['signal_date']) < cutoff_date
        else:
            w = regime_edge_weight(r['nifty_regime'], edge_status)
            if w <= 0.0:
                new_expire = str(r['signal_date']) < cutoff_date
            else:
                adj = 0.5 + w * (float(wp) - 0.5)
                new_expire = adj < threshold
        if old_expire != new_expire:
            flips += 1
            print(f"  FLIP  {r['symbol']:>12}  regime={r['nifty_regime']}  wp={wp}  "
                  f"old_expire={old_expire}  new_expire={new_expire}")
    print(f"  Total ACTIVE rows checked: {len(rows)}; flips: {flips}")

    section("3. scoring_engine: sample win_prob_map adjustment (last 1 day)")
    from scoring_engine import apply_edge_adjustment_to_win_probs
    wp_cutoff = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    wp_rows = conn.execute(
        "SELECT symbol, nifty_regime, COALESCE(calibrated_win_probability, win_probability) AS p "
        "FROM technical_signals WHERE date >= ? AND win_probability IS NOT NULL LIMIT 2000",
        (wp_cutoff,),
    ).fetchall()
    raw_map = {r['symbol']: float(r['p']) for r in wp_rows if r['p'] is not None}
    regime_map = {r['symbol']: r['nifty_regime'] for r in wp_rows}
    adj_map = apply_edge_adjustment_to_win_probs(raw_map, regime_map, edge_status)
    changed = [(s, raw_map[s], adj_map[s]) for s in raw_map if abs(raw_map[s] - adj_map[s]) > 1e-9]
    print(f"  Symbols checked: {len(raw_map)}; changed by edge-adjustment: {len(changed)}")
    for s, old, new in changed[:10]:
        print(f"  {s:>12}  {old:.3f} -> {new:.3f}  (regime={regime_map.get(s)})")

    section("4. unified_ranker: _get_win_probabilities() old vs new (sample)")
    from unified_ranker import UnifiedRanker, bet_size_from_probability
    cutoff30 = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    rows30 = conn.execute(
        "SELECT symbol, nifty_regime, COALESCE(calibrated_win_probability, win_probability) AS p "
        "FROM technical_signals WHERE date >= ? AND win_probability IS NOT NULL",
        (cutoff30,),
    ).fetchall()
    old_acc, new_acc = {}, {}
    for r in rows30:
        p = r['p']
        if p is None:
            continue
        p = float(p)
        old_acc.setdefault(r['symbol'], []).append(p)
        new_acc.setdefault(r['symbol'], []).append(
            edge_adjusted_probability(p, r['nifty_regime'], edge_status))
    old_avg = {s: sum(v) / len(v) for s, v in old_acc.items()}
    new_avg = {s: sum(v) / len(v) for s, v in new_acc.items()}
    bet_changed = 0
    for s in old_avg:
        ob, nb = bet_size_from_probability(old_avg[s]), bet_size_from_probability(new_avg.get(s))
        if abs(ob - nb) > 1e-6:
            bet_changed += 1
    print(f"  Symbols checked: {len(old_avg)}; bet_size_from_probability changed for: {bet_changed}")

    conn.close()
    print("\nDone. No writes were made.")


if __name__ == '__main__':
    main()
