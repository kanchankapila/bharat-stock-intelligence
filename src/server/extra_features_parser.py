#!/usr/bin/env python3
"""
Extra Features Parser
=====================
Parses raw JSON responses stored in 'extra_endpoint_responses' table,
extracts high-value features, and updates 'technical_signals' table columns.

Usage:
  python src/server/extra_features_parser.py
  python src/server/extra_features_parser.py --date 2026-07-15
"""

import argparse
import json
import sys
from datetime import date
from db_compat import connect, query_all

def parse_json(json_str: str) -> dict:
    if not json_str:
        return {}
    try:
        return json.loads(json_str)
    except Exception:
        return {}

def extract_features(symbol: str, responses: list) -> dict:
    feat = {
        "ext_fii_holding_pct": None,
        "ext_dii_holding_pct": None,
        "ext_fii_qoq_chg": None,
        "ext_dii_qoq_chg": None,
        "ext_t80_tech_score": None,
        "ext_t80_quality_rank": None,
        "ext_t80_valuation_rank": None,
        "ext_t80_financial_pts": None,
        "ext_mojo_quality_rank": None,
        "ext_mojo_valuation_rank": None,
        "ext_mojo_financial_pts": None
    }

    for endpoint, res_json in responses:
        data = parse_json(res_json)
        if not data:
            continue

        if endpoint == "marketservices_shareholding":
            # {"summary": {"dii": {"percentage": 20.97, "changeQoQ": 1.0}, "fii": {"percentage": 18.02, "changeQoQ": -1.49}}}
            summary = data.get("summary", {})
            fii = summary.get("fii", {})
            dii = summary.get("dii", {})
            if fii:
                try:
                    feat["ext_fii_holding_pct"] = float(fii.get("percentage"))
                    feat["ext_fii_qoq_chg"] = float(fii.get("changeQoQ"))
                except (ValueError, TypeError):
                    pass
            if dii:
                try:
                    feat["ext_dii_holding_pct"] = float(dii.get("percentage"))
                    feat["ext_dii_qoq_chg"] = float(dii.get("changeQoQ"))
                except (ValueError, TypeError):
                    pass

        elif endpoint == "trading80_header_info":
            # {"data": {"dot_summary": {"tech_score": 1.17, "q_rank": 11, "v_rank": 2, "f_pts": 6}}}
            inner = data.get("data", {})
            summary = inner.get("dot_summary", {})
            if summary:
                try:
                    if summary.get("tech_score") is not None:
                        feat["ext_t80_tech_score"] = float(summary.get("tech_score"))
                    if summary.get("q_rank") is not None:
                        feat["ext_t80_quality_rank"] = float(summary.get("q_rank"))
                    if summary.get("v_rank") is not None:
                        feat["ext_t80_valuation_rank"] = float(summary.get("v_rank"))
                    if summary.get("f_pts") is not None:
                        feat["ext_t80_financial_pts"] = float(summary.get("f_pts"))
                except (ValueError, TypeError):
                    pass

        elif endpoint == "marketsmojo_header_info":
            # {"data": {"dot_summary": {"q_rank": 1, "v_rank": 0, "f_pts": 4}}}
            inner = data.get("data", {})
            summary = inner.get("dot_summary", {})
            if summary:
                try:
                    if summary.get("q_rank") is not None:
                        feat["ext_mojo_quality_rank"] = float(summary.get("q_rank"))
                    if summary.get("v_rank") is not None:
                        feat["ext_mojo_valuation_rank"] = float(summary.get("v_rank"))
                    if summary.get("f_pts") is not None:
                        feat["ext_mojo_financial_pts"] = float(summary.get("f_pts"))
                except (ValueError, TypeError):
                    pass

    return feat

def run(target_date: str) -> int:
    con = connect()
    cur = con.cursor()

    # Find symbols that have rows in technical_signals for the target date
    cur.execute("""
        SELECT DISTINCT symbol FROM technical_signals 
        WHERE date = ?
    """, (target_date,))
    symbols = [r[0] for r in cur.fetchall()]

    if not symbols:
        # Fallback to most recent date in technical_signals
        cur.execute("SELECT MAX(date) FROM technical_signals")
        row = cur.fetchone()
        if row and row[0]:
            target_date = row[0]
            cur.execute("""
                SELECT DISTINCT symbol FROM technical_signals 
                WHERE date = ?
            """, (target_date,))
            symbols = [r[0] for r in cur.fetchall()]

    if not symbols:
        print(f"[PARSER] No technical_signals rows found to update for date: {target_date}")
        con.close()
        return 0

    print(f"[PARSER] Found {len(symbols)} symbols in technical_signals for date {target_date}")

    # Fetch cached responses for these symbols
    cur.execute("""
        SELECT symbol, endpoint_name, response_json 
        FROM extra_endpoint_responses
        WHERE symbol IN ({})
    """.format(",".join("?" for _ in symbols)), tuple(symbols))
    
    responses_by_symbol = {}
    for r in cur.fetchall():
        sym, endpoint, resp = r[0], r[1], r[2]
        responses_by_symbol.setdefault(sym, []).append((endpoint, resp))

    # Parse and update
    updated_count = 0
    for sym in symbols:
        resps = responses_by_symbol.get(sym, [])
        if not resps:
            continue
        feat = extract_features(sym, resps)
        
        cur.execute("""
            UPDATE technical_signals
            SET ext_fii_holding_pct = ?,
                ext_dii_holding_pct = ?,
                ext_fii_qoq_chg = ?,
                ext_dii_qoq_chg = ?,
                ext_t80_tech_score = ?,
                ext_t80_quality_rank = ?,
                ext_t80_valuation_rank = ?,
                ext_t80_financial_pts = ?,
                ext_mojo_quality_rank = ?,
                ext_mojo_valuation_rank = ?,
                ext_mojo_financial_pts = ?
            WHERE symbol = ? AND date = ?
        """, (
            feat["ext_fii_holding_pct"],
            feat["ext_dii_holding_pct"],
            feat["ext_fii_qoq_chg"],
            feat["ext_dii_qoq_chg"],
            feat["ext_t80_tech_score"],
            feat["ext_t80_quality_rank"],
            feat["ext_t80_valuation_rank"],
            feat["ext_t80_financial_pts"],
            feat["ext_mojo_quality_rank"],
            feat["ext_mojo_valuation_rank"],
            feat["ext_mojo_financial_pts"],
            sym,
            target_date
        ))
        if cur.rowcount > 0:
            updated_count += 1

    con.commit()
    con.close()
    print(f"[PARSER] Successfully updated features for {updated_count} symbols on {target_date}")
    return updated_count

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", type=str, help="Update features for a specific date (defaults to today)")
    args = parser.parse_args()

    target_dt = args.date or date.today().isoformat()
    run(target_dt)
