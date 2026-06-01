"""
Data Scientist Agent
Runs at 07:00 IST daily. Computes data quality metrics and writes a graded
report + Ollama narrative to agent_data_scientist_reports.
"""
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).parent))
from ollama_client import get_narrative

DB_PATH = Path(__file__).parent.parent.parent.parent / "database.sqlite"
ENGINE = create_engine(f"sqlite:///{DB_PATH}")


def _scalar(conn, sql: str, params: dict | None = None) -> float:
    row = conn.execute(text(sql), params or {}).fetchone()
    return float(row[0]) if row and row[0] is not None else 0.0


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    stale_cutoff = (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d")
    fund_cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # ── OHLCV coverage ────────────────────────────────────────────────────
        total_syms = _scalar(conn, "SELECT COUNT(DISTINCT symbol) FROM stock_ohlcv")
        covered = _scalar(conn, """
            SELECT COUNT(*) FROM (
                SELECT symbol FROM stock_ohlcv
                GROUP BY symbol HAVING COUNT(*) >= 240
            )
        """)
        ohlcv_coverage_pct = (covered / max(total_syms, 1)) * 100

        stale_count = int(_scalar(conn, """
            SELECT COUNT(*) FROM (
                SELECT symbol, MAX(date) AS latest FROM stock_ohlcv GROUP BY symbol
            ) WHERE latest < :cutoff
        """, {"cutoff": stale_cutoff}))

        # ── Fundamentals freshness ────────────────────────────────────────────
        fund_total = max(_scalar(conn, "SELECT COUNT(*) FROM stock_fundamentals"), 1)
        fund_fresh = int(_scalar(conn,
            "SELECT COUNT(*) FROM stock_fundamentals WHERE phase1_synced_at > :c",
            {"c": fund_cutoff}))

        # ── Model AUC + drift ─────────────────────────────────────────────────
        model_row = conn.execute(text("""
            SELECT cv_roc_auc FROM model_registry
            WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1
        """)).fetchone()
        model_auc = float(model_row[0]) if model_row and model_row[0] else 0.0

        prev_row = conn.execute(text("""
            SELECT model_auc FROM agent_data_scientist_reports
            ORDER BY created_at DESC LIMIT 1
        """)).fetchone()
        prev_auc = float(prev_row[0]) if prev_row and prev_row[0] else model_auc
        drift = 1 if (model_auc - prev_auc) < -0.03 else 0

        # ── Signal resolution rate ────────────────────────────────────────────
        total_outcomes = max(_scalar(conn, "SELECT COUNT(*) FROM signal_outcomes"), 1)
        resolved = _scalar(conn,
            "SELECT COUNT(*) FROM signal_outcomes WHERE outcome != 'PENDING'")
        resolution_rate = (resolved / total_outcomes) * 100

        # ── Composite score ───────────────────────────────────────────────────
        fund_score = (fund_fresh / fund_total) * 100
        data_quality_score = (
            0.35 * min(ohlcv_coverage_pct, 100) +
            0.25 * min(model_auc * 100, 100) +
            0.25 * resolution_rate +
            0.15 * fund_score
        )
        grade = "A" if data_quality_score >= 85 else \
                "B" if data_quality_score >= 70 else \
                "C" if data_quality_score >= 55 else "D"

        issues = []
        if stale_count > 50:
            issues.append({"severity": "HIGH",
                           "issue": f"{stale_count} symbols have stale OHLCV (>3 days)"})
        if drift:
            issues.append({"severity": "HIGH",
                           "issue": f"Model AUC dropped {prev_auc:.3f} → {model_auc:.3f}"})
        if resolution_rate < 70:
            issues.append({"severity": "MEDIUM",
                           "issue": f"Signal resolution rate low: {resolution_rate:.1f}%"})
        if ohlcv_coverage_pct < 80:
            issues.append({"severity": "MEDIUM",
                           "issue": f"OHLCV coverage below 80%: {ohlcv_coverage_pct:.1f}%"})

        # ── Ollama narrative ──────────────────────────────────────────────────
        prompt = (
            f"You are a quant data scientist. Given these metrics:\n"
            f"- OHLCV coverage: {ohlcv_coverage_pct:.1f}% ({stale_count} symbols stale)\n"
            f"- Model AUC: {model_auc:.3f} (drift detected: {'yes' if drift else 'no'})\n"
            f"- Signal resolution rate: {resolution_rate:.1f}%\n"
            f"- Data quality score: {data_quality_score:.0f}/100 (Grade {grade})\n"
            f"- Issues flagged: {json.dumps(issues)}\n\n"
            f"Write a 4-sentence analyst briefing: data health status, key risks, "
            f"what the strategist should be aware of today, and one recommended action."
        )
        narrative = get_narrative(prompt)

        # ── Persist ───────────────────────────────────────────────────────────
        conn.execute(text("""
            INSERT INTO agent_data_scientist_reports
              (run_date, ohlcv_coverage_pct, stale_symbols_count,
               fundamentals_fresh_count, model_auc, model_drift_detected,
               signal_resolution_rate, data_quality_score, quality_grade,
               issues_json, narrative)
            VALUES
              (:run_date, :ohlcv, :stale, :fund, :auc, :drift,
               :res, :score, :grade, :issues, :narrative)
        """), {
            "run_date": today, "ohlcv": round(ohlcv_coverage_pct, 2),
            "stale": stale_count, "fund": fund_fresh,
            "auc": round(model_auc, 4), "drift": drift,
            "res": round(resolution_rate, 2), "score": round(data_quality_score, 2),
            "grade": grade, "issues": json.dumps(issues), "narrative": narrative,
        })
        conn.commit()

    result = {"grade": grade, "score": round(data_quality_score, 2),
              "stale": stale_count, "drift": drift}
    print(f"[DATA-SCIENTIST] {today} | Grade={grade} Score={data_quality_score:.1f}")
    return result


if __name__ == "__main__":
    run()
