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

import polars as pl
import argparse
import json
import sys
from as_of import logical_trading_date
from db_compat import connect, query_all

# The ONLY endpoints extract_features() below actually reads. extra_endpoints_fetcher.py
# imports this to decide what its nightly (--scope daily) pass fetches.
#
# Measured 2026-08-12: the fetcher was pulling all 34 registry endpoints for ~1,994 symbols
# (~38,000 requests) and being SIGKILLed at 55% of the universe, while this parser -- the
# table's only production consumer -- read 5 of those 34. ~74% of the nightly request budget
# was collecting responses nothing ever parsed.
#
# Do NOT hand-edit this to add an endpoint without adding the matching branch below:
# test_extra_features_parser.py derives the branch literals from extract_features()'s own
# source and asserts they equal this set, so the two cannot drift (the hand-enumerated
# allowlist trap in .claude/rules/recurring-bugs.md, Testing).
PARSED_ENDPOINTS = frozenset({
    "marketservices_shareholding",
    "trading80_header_info",
    "marketsmojo_header_info",
    "investsights_score",
    "tapetide_score",
})

def parse_json(json_str: str) -> dict:
    if not json_str:
        return {}
    try:
        return json.loads(json_str)
    except Exception:
        return {}

# Trading80/MarketsMojo's dot_summary uses -99997 (and similar large-magnitude values) as a
# "no score computed for this stock" sentinel in q_rank/v_rank/f_pts/tech_score -- live-verified
# 2026-07-30 across a 15-stock sample (LPDC, MAHAPEXLTD, ZIMLAB, VIDHIING all returned q_rank=-99997
# while genuinely-scored stocks ranged 2-66). Without this guard the sentinel passes straight through
# float() and gets fed to ml_ensemble.py as if -99997 were a real (extremely bearish) score.
_SENTINEL_ABS_THRESHOLD = 90000

def _clean_score(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        f = float(value)
    except (ValueError, TypeError):
        return None
    if abs(f) >= _SENTINEL_ABS_THRESHOLD:
        return None
    return f

def _as_dict(value) -> dict:
    """Some providers return an empty list (`[]`) instead of `{}` for a nested object when
    there's no data for a stock -- live-confirmed 2026-07-30 for trading80_header_info's
    "data" key on ELGIRUBCO/MUTHOOTFIN/ADANIGREEN, which crashed extract_features() on
    .get("dot_summary", ...) since a list has no .get(). Treat any non-dict as "no data"."""
    return value if isinstance(value, dict) else {}

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
        "ext_mojo_financial_pts": None,
        "ext_is_overall_score": None,
        "ext_is_percentile_rank": None,
        "ext_tt_score": None,
    }

    for endpoint, res_json in responses:
        data = parse_json(res_json)
        if not data or not isinstance(data, dict):
            continue

        if endpoint == "marketservices_shareholding":
            # {"summary": {"dii": {"percentage": 20.97, "changeQoQ": 1.0}, "fii": {"percentage": 18.02, "changeQoQ": -1.49}}}
            summary = _as_dict(data.get("summary"))
            fii = _as_dict(summary.get("fii"))
            dii = _as_dict(summary.get("dii"))
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
            inner = _as_dict(data.get("data"))
            summary = _as_dict(inner.get("dot_summary"))
            if summary:
                feat["ext_t80_tech_score"] = _clean_score(summary.get("tech_score"))
                feat["ext_t80_quality_rank"] = _clean_score(summary.get("q_rank"))
                feat["ext_t80_valuation_rank"] = _clean_score(summary.get("v_rank"))
                feat["ext_t80_financial_pts"] = _clean_score(summary.get("f_pts"))

        elif endpoint == "marketsmojo_header_info":
            # {"data": {"dot_summary": {"q_rank": 1, "v_rank": 0, "f_pts": 4}}}
            # NOTE (live-verified 2026-07-30, 15/15 stocks byte-identical dot_summary): MarketsMojo's
            # header_info is the SAME underlying Trading80 score data reissued under a different
            # provider name, not an independent opinion -- see AI_ENDPOINT_MEMORY.md. Kept as a
            # separate column set only because ml_ensemble.py already reads both; do not treat
            # ext_mojo_* and ext_t80_* as diversified signal.
            inner = _as_dict(data.get("data"))
            summary = _as_dict(inner.get("dot_summary"))
            if summary:
                feat["ext_mojo_quality_rank"] = _clean_score(summary.get("q_rank"))
                feat["ext_mojo_valuation_rank"] = _clean_score(summary.get("v_rank"))
                feat["ext_mojo_financial_pts"] = _clean_score(summary.get("f_pts"))

        elif endpoint == "investsights_score":
            # {"overall_score": 66.19, "percentile_rank": 73.72, "factors": {...},
            #  "forensic_scores": {...}, "risk_indicators": {...}} -- only the headline
            # overall_score/percentile_rank are promoted to ML features for now; factors/
            # forensic_scores/risk_indicators overlap conceptually with existing altman_z/
            # piotroski features from a different source and need a cross-validation pass
            # (do they agree?) before adding them too -- not done yet, see AI_ENDPOINT_MEMORY.md.
            feat["ext_is_overall_score"] = _clean_score(data.get("overall_score"))
            feat["ext_is_percentile_rank"] = _clean_score(data.get("percentile_rank"))

        elif endpoint == "tapetide_score":
            # {"data": {"score": 44, "pillars": {...}, "pillar_weights": {...}}}
            inner = _as_dict(data.get("data"))
            feat["ext_tt_score"] = _clean_score(inner.get("score"))

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

    # Fetch cached responses for these symbols, plus each row's own updated_at.
    # Fixed 2026-07-30 (Finding #65, full-stack audit): extra_endpoint_responses has
    # PRIMARY KEY (symbol, endpoint_name) and only ever holds the LATEST live snapshot --
    # it has no history. Writing that current-only snapshot onto an arbitrary historical
    # technical_signals row (via a past --date, or the "fall back to most recent existing
    # date" path above) was a confirmed look-ahead leak into ext_fii_holding_pct/
    # ext_t80_tech_score/ext_mojo_quality_rank/etc, all consumed by ml_ensemble.py. A
    # snapshot-only table structurally cannot reconstruct what was true on a past date, so
    # this now only ever writes onto the technical_signals row for the date the snapshot
    # was ACTUALLY fetched (updated_at's date) -- never target_date blindly.
    cur.execute("""
        SELECT symbol, endpoint_name, response_json, updated_at
        FROM extra_endpoint_responses
        WHERE symbol IN ({})
    """.format(",".join("?" for _ in symbols)), tuple(symbols))

    responses_by_symbol = {}
    fetched_date_by_symbol = {}
    for r in cur.fetchall():
        sym, endpoint, resp, updated_at = r[0], r[1], r[2], r[3]
        responses_by_symbol.setdefault(sym, []).append((endpoint, resp))
        fetched_date = str(updated_at)[:10] if updated_at else None
        # Latest fetched_date across this symbol's endpoints -- if endpoints were fetched
        # on different days, the snapshot as a whole is only as fresh as its oldest part,
        # but MAX is the closest available proxy without per-endpoint row granularity.
        if fetched_date and fetched_date > fetched_date_by_symbol.get(sym, ""):
            fetched_date_by_symbol[sym] = fetched_date

    # Parse and update
    updated_count = 0
    skipped_stale = 0
    for sym in symbols:
        resps = responses_by_symbol.get(sym, [])
        if not resps:
            continue

        fetched_date = fetched_date_by_symbol.get(sym)
        if fetched_date != target_date:
            # The cached snapshot was NOT captured on target_date -- writing it there would
            # leak a different day's data into this row (backward if fetched_date is newer
            # than target_date, i.e. a historical backfill; stale if older). Skip rather
            # than fabricate a point-in-time value this table cannot actually supply.
            skipped_stale += 1
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
                ext_mojo_financial_pts = ?,
                ext_is_overall_score = ?,
                ext_is_percentile_rank = ?,
                ext_tt_score = ?
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
            feat["ext_is_overall_score"],
            feat["ext_is_percentile_rank"],
            feat["ext_tt_score"],
            sym,
            target_date
        ))
        if cur.rowcount > 0:
            updated_count += 1

    con.commit()
    con.close()
    print(f"[PARSER] Successfully updated features for {updated_count} symbols on {target_date} "
          f"({skipped_stale} skipped -- cached snapshot wasn't fetched on {target_date})")
    return updated_count

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", type=str, help="Update features for a specific date (defaults to today)")
    args = parser.parse_args()

    # NOT date.today(): this feeds a `WHERE symbol = ? AND date = ?` write target, and
    # ml-daily-ops routinely finishes after midnight IST, at which point "today" is a day with
    # no technical_signals grid row -- 0 rows matched, silently (.claude/rules/recurring-bugs.md).
    # It also breaks the run()'s own fetched_date == target_date guard, which compares against
    # extra_endpoint_responses.updated_at: past midnight those two disagree and every symbol is
    # skipped as stale. logical_trading_date() keeps both on the same session.
    target_dt = args.date or logical_trading_date()
    run(target_dt)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
