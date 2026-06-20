"""
Auditor Agent
Runs at 16:30 IST daily. Compares yesterday's strategy picks against
actual price data and writes per-timeframe audit reports.
"""
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text
from db_compat import get_engine, translate
from ollama_client import get_narrative

ENGINE = get_engine()


def _get_price(conn, symbol: str, as_of: str | None = None) -> float | None:
    if as_of:
        row = conn.execute(text(translate(
            "SELECT close FROM stock_ohlcv WHERE symbol=:s AND date<=:d ORDER BY date DESC LIMIT 1"
        )), {"s": symbol, "d": as_of}).fetchone()
    else:
        row = conn.execute(text(translate(
            "SELECT close FROM stock_ohlcv WHERE symbol=:s ORDER BY date DESC LIMIT 1"
        )), {"s": symbol}).fetchone()
    return float(row[0]) if row and row[0] else None


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # Most recent previous strategy run
        prev_row = conn.execute(text(translate("""
            SELECT DISTINCT run_date FROM agent_strategy_picks
            WHERE run_date < :today ORDER BY run_date DESC LIMIT 1
        """)), {"today": today}).fetchone()
        if not prev_row:
            print("[AUDITOR] No previous picks to audit")
            return {"skipped": True}
        audit_date = prev_row[0]

        # Nifty benchmark close-to-close
        nifty_entry = _get_price(conn, "^NSEI", audit_date)
        nifty_now = _get_price(conn, "^NSEI")
        nifty_return = ((nifty_now - nifty_entry) / nifty_entry * 100) \
            if nifty_entry and nifty_now and nifty_entry > 0 else 0.0

        picks = conn.execute(text(translate("""
            SELECT symbol, timeframe, conviction, entry_zone_low, entry_zone_high,
                   stop_loss, target_1, supporting_signals_json
            FROM agent_strategy_picks WHERE run_date = :d
        """)), {"d": audit_date}).fetchall()

        by_tf: dict[str, list] = defaultdict(list)
        for p in picks:
            by_tf[p[1]].append(p)

        reports_inserted = 0
        for tf, tf_picks in by_tf.items():
            hits = misses = opens = 0
            returns: list[float] = []
            best_sym = best_ret = None
            worst_sym = worst_ret = None
            signal_wins: dict[str, list] = defaultdict(list)

            for p in tf_picks:
                sym, _, _, el, eh, sl, t1, sigs_json = p
                entry_mid = ((el or 0) + (eh or 0)) / 2
                current = _get_price(conn, sym)
                if not current or not entry_mid or entry_mid == 0:
                    opens += 1
                    continue

                ret = (current - entry_mid) / entry_mid * 100

                if sl and current <= sl:
                    outcome = "MISS"
                    misses += 1
                elif t1 and current >= t1:
                    outcome = "HIT"
                    hits += 1
                else:
                    outcome = "OPEN"
                    opens += 1

                returns.append(ret)

                if best_ret is None or ret > best_ret:
                    best_ret, best_sym = ret, sym
                if worst_ret is None or ret < worst_ret:
                    worst_ret, worst_sym = ret, sym

                try:
                    sigs = json.loads(sigs_json or "[]")
                    for sig in sigs:
                        sig_type = sig.get("type", "unknown") if isinstance(sig, dict) else str(sig)
                        signal_wins[sig_type].append(1 if outcome == "HIT" else 0)
                except Exception:
                    pass

            total = len(tf_picks)
            resolved = hits + misses
            hit_rate = (hits / resolved * 100) if resolved > 0 else 0.0
            avg_ret = sum(returns) / len(returns) if returns else 0.0
            pos_sum = sum(r for r in returns if r > 0) or 0.001
            neg_sum = abs(sum(r for r in returns if r < 0)) or 0.001
            profit_factor = pos_sum / neg_sum
            alpha = avg_ret - nifty_return

            attribution = {
                st: round(sum(wins) / len(wins) * 100, 1)
                for st, wins in signal_wins.items() if wins
            }
            top_sigs = sorted(attribution.items(), key=lambda x: x[1], reverse=True)[:3]
            weak_sigs = sorted(attribution.items(), key=lambda x: x[1])[:3]

            prompt = (
                f"You are a quantitative analyst auditing yesterday's Indian market picks.\n"
                f"Timeframe: {tf}\n"
                f"Hit rate: {hit_rate:.0f}% | Avg return: {avg_ret:+.2f}% | "
                f"Alpha vs Nifty: {alpha:+.2f}%\n"
                f"Best: {best_sym} ({(best_ret or 0):+.2f}%) | "
                f"Worst: {worst_sym} ({(worst_ret or 0):+.2f}%)\n"
                f"Top signals: {[s[0] for s in top_sigs]} | "
                f"Weak signals: {[s[0] for s in weak_sigs]}\n\n"
                f"Write a 4-sentence audit report: overall performance verdict, "
                f"what worked, what failed and why, and one actionable insight for the strategist."
            )
            narrative = get_narrative(prompt)

            conn.execute(text(translate("""
                INSERT INTO agent_audit_reports
                  (run_date, audit_for_date, timeframe, total_picks,
                   hits, misses, open_positions, hit_rate, avg_return_pct,
                   profit_factor, nifty_return_pct, alpha_pct,
                   best_pick, worst_pick, signal_attribution_json, narrative)
                VALUES
                  (:rd, :afd, :tf, :total, :hits, :misses, :opens,
                   :hr, :avg, :pf, :nifty, :alpha, :best, :worst, :attr, :narr)
            """)), {
                "rd": today, "afd": audit_date, "tf": tf, "total": total,
                "hits": hits, "misses": misses, "opens": opens,
                "hr": round(hit_rate, 2), "avg": round(avg_ret, 3),
                "pf": round(profit_factor, 3), "nifty": round(nifty_return, 3),
                "alpha": round(alpha, 3), "best": best_sym, "worst": worst_sym,
                "attr": json.dumps(attribution), "narr": narrative,
            })
            reports_inserted += 1

        conn.commit()

    print(f"[AUDITOR] {today} | Audited {audit_date} | {reports_inserted} timeframe reports")
    return {"audited_date": audit_date, "reports": reports_inserted}


if __name__ == "__main__":
    run()
