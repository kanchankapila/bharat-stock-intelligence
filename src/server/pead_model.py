"""
PEAD Model
==========
Post-Earnings Announcement Drift scorer.
Uses: eps_growth_yoy, eps_growth_qoq, eps_acceleration, volume_ratio, rs_rank_21d
to predict 10-30 day drift after results.

Academic finding: stocks that beat estimates continue drifting for 30-60 days.
Underreaction is strongest in: small-caps, high-retail-ownership, low-analyst-coverage stocks.

Writes: technical_signals.pead_score (float, range -1 to +1)
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode
import sys, math
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect

def ensure_schema(con):
    try:
        con.execute('ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS pead_score DOUBLE PRECISION')
        con.commit()
    except Exception:
        con.rollback()

def compute_pead_score(row: dict) -> float | None:
    """
    PEAD score from -1 (strong miss drift) to +1 (strong beat drift).

    Inputs (all from technical_signals):
      eps_growth_yoy   — YoY EPS growth (proxy for beat if > analyst expectation)
      eps_growth_qoq   — QoQ EPS growth (momentum)
      eps_acceleration — acceleration vs prior quarter
      volume_ratio     — volume vs 20d avg on results day
      rs_rank_21d      — relative strength (beat stocks drift more when already strong)
      days_to_next_results — if < 7, pre-results positioning; if > 7, post-drift
    """
    eps_yoy   = row.get('eps_growth_yoy')
    eps_qoq   = row.get('eps_growth_qoq')
    eps_acc   = row.get('eps_acceleration')
    vol_r     = row.get('volume_ratio') or 1.0
    rs_21     = row.get('rs_rank_21d') or 50.0
    days_res  = row.get('days_to_next_results')

    if eps_yoy is None and eps_qoq is None:
        return None

    # Skip if results are imminent (< 5 days) — pre-results noise
    if days_res is not None and days_res < 5:
        return None

    score = 0.0

    # EPS YoY signal (strongest component)
    if eps_yoy is not None:
        if eps_yoy > 20:    score += 0.40
        elif eps_yoy > 10:  score += 0.25
        elif eps_yoy > 0:   score += 0.10
        elif eps_yoy > -10: score -= 0.10
        else:               score -= 0.35

    # EPS QoQ acceleration
    if eps_qoq is not None:
        if eps_qoq > 10:   score += 0.20
        elif eps_qoq > 0:  score += 0.10
        elif eps_qoq < 0:  score -= 0.15

    # Acceleration (second derivative)
    if eps_acc is not None:
        score += max(-0.15, min(0.15, eps_acc / 100.0))

    # Volume confirmation (high volume on beat = institutions noticed)
    if vol_r > 2.0:    score *= 1.30
    elif vol_r > 1.5:  score *= 1.15
    elif vol_r < 0.7:  score *= 0.80

    # RS rank confirmation (drift is stronger in already-strong stocks)
    rs_mult = 0.7 + (rs_21 / 100.0) * 0.6  # range 0.7 to 1.3
    score *= rs_mult

    return max(-1.0, min(1.0, score))

def run():
    con = connect()
    ensure_schema(con)

    today = datetime.now().strftime('%Y-%m-%d')
    # Use latest date that actually has eps data (fetchers may have run on a prior day)
    latest_eps = con.execute("""
        SELECT MAX(date)::text AS d FROM technical_signals
        WHERE eps_growth_yoy IS NOT NULL OR eps_growth_qoq IS NOT NULL
    """).fetchone()
    target_date = (latest_eps['d'] if latest_eps and latest_eps.get('d') else today)
    print(f"[PEAD] Using date={target_date} (today={today})")

    rows = con.execute("""
        SELECT symbol, date::text AS date, eps_growth_yoy, eps_growth_qoq, eps_acceleration,
               volume_ratio, rs_rank_21d, days_to_next_results
        FROM technical_signals
        WHERE date::text = ?
          AND (eps_growth_yoy IS NOT NULL OR eps_growth_qoq IS NOT NULL)
    """, (target_date,)).fetchall()

    print(f"[PEAD] Scoring {len(rows)} signals...")
    updated = 0
    for row in rows:
        score = compute_pead_score(dict(row))
        if score is not None:
            con.execute(
                "UPDATE technical_signals SET pead_score = ? WHERE symbol = ? AND date::text = ?",
                (round(score, 4), row['symbol'], target_date)
            )
            updated += 1
    con.commit()
    print(f"[PEAD] Wrote pead_score for {updated} symbols.")

    # Show top PEAD candidates
    tops = con.execute("""
        SELECT symbol, pead_score, eps_growth_yoy, eps_growth_qoq, volume_ratio
        FROM technical_signals
        WHERE date = ? AND pead_score IS NOT NULL
        ORDER BY pead_score DESC LIMIT 10
    """, (today,)).fetchall()
    print("[PEAD] Top PEAD candidates:")
    for r in tops:
        print(f"  {r['symbol']}: PEAD={r['pead_score']:+.3f} EPS_YOY={r['eps_growth_yoy']} VOL={r['volume_ratio']}")

if __name__ == '__main__':
    run()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
