"""
Optimizer Agent
Runs at 17:30 IST daily. Reads 30-day audit trail, nudges screener weights
for underperforming signal types, triggers full strategy_optimizer.py when
overall win rate stays below 50% for 5+ consecutive days.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import requests
from sqlalchemy import text
from db_compat import get_engine, translate
from narrative_client import get_narrative

ENGINE = get_engine()
ALPHAQUANT_URL = "http://127.0.0.1:8002/api/v1/optimize"
WEIGHT_MIN, WEIGHT_MAX = 0.3, 2.0


def _clamp(v: float) -> float:
    return round(max(WEIGHT_MIN, min(WEIGHT_MAX, v)), 3)


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # 30-day audit rows
        rows = conn.execute(text(translate("""
            SELECT timeframe, hit_rate, avg_return_pct,
                   signal_attribution_json, run_date
            FROM agent_audit_reports
            ORDER BY run_date DESC LIMIT 120
        """))).fetchall()

        if not rows:
            print("[OPTIMIZER] No audit data yet — skipping")
            return {"skipped": True}

        # Rolling win rates per timeframe
        tf_rates: dict[str, list[float]] = defaultdict(list)
        signal_wins: dict[str, list[float]] = defaultdict(list)
        for row in rows:
            tf, hit_rate, _, attr_json, _ = row
            tf_rates[tf].append(float(hit_rate or 0))
            try:
                attr = json.loads(attr_json or "{}")
                for sig_type, wr in attr.items():
                    signal_wins[sig_type].append(float(wr))
            except Exception:
                pass

        avg_rates = {tf: sum(rates) / len(rates) for tf, rates in tf_rates.items()}
        overall_rate = sum(avg_rates.values()) / max(len(avg_rates), 1)

        # Check consecutive underperformance — fetch last 7 calendar days (covers 5 trading days)
        recent_days = conn.execute(text(translate("""
            SELECT AVG(hit_rate) FROM agent_audit_reports
            WHERE date(run_date) >= date('now', '-7 days')
            GROUP BY run_date ORDER BY run_date
        """))).fetchall()
        consecutive_bad = sum(1 for r in recent_days if r[0] and float(r[0]) < 50)

        full_optimizer = len(recent_days) >= 5 and consecutive_bad >= 5

        # Determine underperforming signal types
        changes: dict[str, dict] = {}
        for sig_type, rates in signal_wins.items():
            avg = sum(rates) / len(rates)
            cur_row = conn.execute(text(translate("""
                SELECT weight_override FROM screener_master
                WHERE name LIKE :pattern LIMIT 1
            """)), {"pattern": f"%{sig_type}%"}).fetchone()
            if cur_row and cur_row[0] is not None:
                before = float(cur_row[0])
                if avg < 45:
                    after = _clamp(before * 0.88)
                elif avg > 65:
                    after = _clamp(before * 1.10)
                else:
                    continue
                if abs(after - before) >= 0.01:
                    conn.execute(text(translate("""
                        UPDATE screener_master SET weight_override = :w
                        WHERE name LIKE :pattern
                    """)), {"w": after, "pattern": f"%{sig_type}%"})
                    changes[sig_type] = {"before": before, "after": after}

        weights_changed = len(changes) > 0

        # Commit weight changes BEFORE the long optimizer call below -- the same connection
        # must not sit idle-in-transaction holding screener_master row locks for up to 30
        # minutes while requests.post runs.
        conn.commit()

    # ── DB connection intentionally closed here ──
    # 2026-09-02 fix (same class as strategy_optimizer.py 2026-08-25/26 and
    # backtest_optimizer.py 2026-08-27): one connection checked out at the top and reused
    # AFTER a 25-30 min requests.post died server-side (pool_pre_ping only validates at
    # checkout), so the final INSERT failed and the whole run reported failure — every
    # full_optimizer-triggered run is exposed, and one died exactly this way 2026-09-02
    # 12:26 UTC (job_run_history). The report INSERT now runs on a fresh connection.
    underperforming = {tf: r for tf, r in avg_rates.items() if r < 55}

    # Trigger full optimizer if needed
    if full_optimizer:
        try:
            requests.post(ALPHAQUANT_URL,
                           json={"horizon_days": 15, "iterations": 200, "apply": True},
                           timeout=30 * 60)
            print("[OPTIMIZER] Full optimizer triggered via AlphaQuant API")
        except Exception as exc:
            print(f"[OPTIMIZER] Full optimizer call failed: {exc}")

    tf_table = "\n".join(
        f"  {tf}: {r:.1f}% win rate" for tf, r in avg_rates.items()
    )
    prompt = (
        f"You are a quantitative portfolio optimizer for Indian equities.\n"
        f"30-day performance by timeframe:\n{tf_table}\n\n"
        f"Weight adjustments made: {json.dumps(changes)}\n"
        f"Full optimizer triggered: {'yes' if full_optimizer else 'no'}\n\n"
        f"Write a 4-sentence optimization report: performance trend assessment, "
        f"which adjustments were made and the rationale, expected improvement, "
        f"and one metric to monitor over the next 5 trading days."
    )
    narrative = get_narrative(prompt)

    with ENGINE.connect() as conn:
        conn.execute(text(translate("""
            INSERT INTO agent_optimizer_reports
              (run_date, trigger, baseline_win_rate, new_win_rate,
               improvement_pct, weights_changed, full_optimizer_triggered,
               changes_json, underperforming_segments_json, narrative)
            VALUES
              (:rd, :trig, :base, :new, :imp,
               :wc, :fo, :changes, :under, :narr)
        """)), {
            "rd": today,
            "trig": "performance_drop" if full_optimizer else "scheduled",
            "base": round(overall_rate, 2),
            "new": round(overall_rate, 2),
            "imp": 0.0,
            "wc": int(weights_changed),
            "fo": int(full_optimizer),
            "changes": json.dumps(changes),
            "under": json.dumps(underperforming),
            "narr": narrative,
        })
        conn.commit()

    print(f"[OPTIMIZER] {today} | Overall win rate: {overall_rate:.1f}% | "
          f"Weights changed: {len(changes)} | Full optimizer: {full_optimizer}")
    return {"overall_rate": overall_rate, "changes": len(changes),
            "full_optimizer": full_optimizer}


if __name__ == "__main__":
    run()
