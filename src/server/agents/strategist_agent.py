"""
Strategist Agent
Runs at 08:30 IST daily. Produces ranked picks for 4 timeframes using
quant_scores + confluence + regime alignment, with Ollama narratives.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text
from db_compat import get_engine, translate
from ollama_client import get_narrative

ENGINE = get_engine()

TIMEFRAMES = ["intraday", "swing", "positional", "investment"]
PICKS_PER_TF = 5


def _compute_atr14(conn, symbol: str) -> float:
    rows = conn.execute(text(translate("""
        SELECT high, low, close FROM stock_ohlcv
        WHERE symbol = :s ORDER BY date DESC LIMIT 15
    """)), {"s": symbol}).fetchall()
    if len(rows) < 2:
        return 0.0
    trs = []
    for i in range(len(rows) - 1):
        h, l, pc = rows[i][0], rows[i][1], rows[i + 1][2]
        if h and l and pc:
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return sum(trs[-14:]) / max(len(trs[-14:]), 1)


def _regime_bonus(regime: str | None, sentiment: str | None) -> float:
    if not regime or not sentiment:
        return 0.0
    if regime == "BULL" and sentiment == "bullish":
        return 15.0
    if regime == "BULL" and sentiment == "bearish":
        return -15.0
    return 0.0


def parse_timeframe(time_horizon_str: str | None, signals_json: str | None) -> str:
    if time_horizon_str:
        s = str(time_horizon_str).lower().strip()
        if "intraday" in s:
            return "intraday"
        if "swing" in s or "3-7d" in s or "3-10d" in s:
            return "swing"
        if "positional" in s or "2-4w" in s or "3-6w" in s:
            return "positional"
        if "investment" in s:
            return "investment"
    try:
        sigs = json.loads(signals_json or "[]")
        sig_types = {s.get("type") if isinstance(s, dict) else str(s) for s in sigs}
        long_term = {"WEEK_52_BREAKOUT", "GOLDEN_CROSS", "DEATH_CROSS", "EMA_BULL_STACK"}
        if sig_types & long_term:
            return "positional"
    except Exception:
        pass
    return "swing"


def _get_candidates_for_tf(conn, timeframe: str) -> list[dict]:
    if timeframe == "investment":
        rows = conn.execute(text(translate("""
            SELECT q.symbol,
                   COALESCE(q.rank_composite, 50)  AS quant_rank,
                   COALESCE(c.confluence_score, 0) AS confluence_score,
                   CASE WHEN c.bullish_screener_count > c.bearish_screener_count THEN 'bullish' WHEN c.bearish_screener_count > c.bullish_screener_count THEN 'bearish' ELSE 'neutral' END AS sentiment,
                   COALESCE(c.current_price, (SELECT cmp FROM technical_signals ts WHERE ts.symbol = q.symbol ORDER BY ts.date DESC LIMIT 1)) AS cmp
            FROM quant_scores q
            LEFT JOIN confluence_signals c ON c.symbol = q.symbol
            WHERE q.rank_composite IS NOT NULL
            ORDER BY q.rank_composite DESC
            LIMIT 50
        """))).fetchall()
        return [{"symbol": r[0], "quant_rank": float(r[1] or 50),
                 "confluence_score": float(r[2] or 0),
                 "sentiment": r[3], "cmp": float(r[4] or 0)} for r in rows]
    else:
        rows = conn.execute(text(translate("""
            SELECT ts.symbol,
                   COALESCE(q.rank_composite, 50)   AS quant_rank,
                   COALESCE(c.confluence_score, 0)  AS confluence_score,
                   CASE WHEN c.bullish_screener_count > c.bearish_screener_count THEN 'bullish' WHEN c.bearish_screener_count > c.bullish_screener_count THEN 'bearish' ELSE 'neutral' END AS sentiment,
                   ts.cmp,
                   ts.time_horizon,
                   ts.signals_json
            FROM technical_signals ts
            LEFT JOIN quant_scores q ON q.symbol = ts.symbol
            LEFT JOIN confluence_signals c ON c.symbol = ts.symbol
            WHERE date(ts.date) = date('now')
            ORDER BY ts.signal_score DESC
        """))).fetchall()

        candidates = []
        for r in rows:
            symbol, qr, cs, sentiment, cmp, time_horizon, signals_json = r
            resolved_tf = parse_timeframe(time_horizon, signals_json)
            if resolved_tf == timeframe:
                candidates.append({
                    "symbol": symbol, "quant_rank": float(qr or 50),
                    "confluence_score": float(cs or 0),
                    "sentiment": sentiment, "cmp": float(cmp or 0)
                })
        return candidates[:100]


def _score_candidate(c: dict, regime: str | None,
                      reliability_map: dict) -> float:
    rel_avg = reliability_map.get(c["symbol"], 50.0)
    bonus = _regime_bonus(regime, c["sentiment"])
    score = (
        0.35 * c["quant_rank"] +
        0.30 * min(c["confluence_score"], 100) +
        0.20 * (50 + bonus) +
        0.15 * rel_avg
    )
    return round(score, 2)


def _conviction(score: float, n_signals: int) -> str:
    if score >= 75 and n_signals >= 3:
        return "HIGH"
    if score >= 60:
        return "MEDIUM"
    return "LOW"


def run() -> dict:
    today = datetime.now().strftime("%Y-%m-%d")

    with ENGINE.connect() as conn:
        # Quality gate from DS report
        ds_row = conn.execute(text(translate("""
            SELECT quality_grade, stale_symbols_count
            FROM agent_data_scientist_reports
            ORDER BY created_at DESC LIMIT 1
        """))).fetchone()
        if ds_row and ds_row[0] == "D":
            print("[STRATEGIST] Aborted — data quality grade D")
            return {"aborted": True, "reason": "data quality D"}
        stale_warn = ds_row and int(ds_row[1] or 0) > 100

        # Regime
        regime_row = conn.execute(text(translate("""
            SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1
        """))).fetchone()
        regime = regime_row[0] if regime_row else "UNKNOWN"

        # FII/DII
        fii_row = conn.execute(text(translate("""
            SELECT fii_net FROM fii_dii_flow ORDER BY date DESC LIMIT 1
        """))).fetchone()
        fii_net = float(fii_row[0]) if fii_row and fii_row[0] else 0.0
        fii_direction = "buying" if fii_net > 0 else "selling"

        # Screener reliability map
        rel_rows = conn.execute(text(translate("""
            SELECT scan_id, reliability_score FROM screener_reliability
        """))).fetchall()
        reliability_map: dict[str, float] = {r[0]: float(r[1] or 50) for r in rel_rows}

        total_inserted = 0
        high_conviction_picks: list[dict] = []

        for tf in TIMEFRAMES:
            candidates = _get_candidates_for_tf(conn, tf)
            if not candidates:
                print(f"[STRATEGIST] No candidates for {tf}")
                continue

            scored = []
            for c in candidates:
                sig_row = conn.execute(text(translate("""
                    SELECT signals_json FROM technical_signals
                    WHERE symbol = :s AND date(date) = date('now') LIMIT 1
                """)), {"s": c["symbol"]}).fetchone()
                n_signals = len(json.loads(sig_row[0])) if sig_row and sig_row[0] else 0

                score = _score_candidate(c, regime, reliability_map)
                conv = _conviction(score, n_signals)
                scored.append({**c, "score": score, "conviction": conv,
                                "n_signals": n_signals})

            scored.sort(key=lambda x: x["score"], reverse=True)
            top = scored[:PICKS_PER_TF]

            # Build Ollama prompt for top 3
            top3_lines = "\n".join(
                f"{i+1}. {p['symbol']} | Score: {p['score']:.0f} | "
                f"Conviction: {p['conviction']}"
                for i, p in enumerate(top[:3])
            )
            prompt = (
                f"You are a senior equity strategist for Indian markets.\n"
                f"Market regime: {regime}. "
                f"FII net flow: ₹{fii_net:,.0f}Cr ({fii_direction}).\n\n"
                f"Top {tf} picks:\n{top3_lines}\n\n"
                f"Write a 5-sentence strategy brief: market context, "
                f"{tf} timeframe rationale, top pick conviction reasoning, "
                f"key risk, and action trigger."
            )
            narrative = get_narrative(prompt)

            for rank, pick in enumerate(top, 1):
                symbol = pick["symbol"]
                cmp = pick["cmp"] or 0.0
                atr = _compute_atr14(conn, symbol) if cmp > 0 else 0.0

                entry_low = round(cmp * 0.995, 2)
                entry_high = round(cmp * 1.005, 2)
                entry_mid = (entry_low + entry_high) / 2
                sl = round(entry_mid - 2 * atr, 2) if atr > 0 else round(entry_mid * 0.97, 2)
                r = entry_mid - sl
                t1 = round(entry_mid + 1.5 * r, 2)
                t2 = round(entry_mid + 2.5 * r, 2)
                t3 = round(entry_mid + 4.0 * r, 2)

                sig_row = conn.execute(text(translate("""
                    SELECT signals_json FROM technical_signals
                    WHERE symbol = :s AND date(date) = date('now') LIMIT 1
                """)), {"s": symbol}).fetchone()
                signals_list = json.loads(sig_row[0]) if sig_row and sig_row[0] else []

                regime_align = "ALIGNED" if pick["sentiment"] == "bullish" and regime == "BULL" \
                    else "OPPOSED" if pick["sentiment"] == "bearish" and regime == "BULL" \
                    else "NEUTRAL"

                conn.execute(text(translate("""
                    INSERT INTO agent_strategy_picks
                      (run_date, timeframe, symbol, rank, conviction,
                       entry_zone_low, entry_zone_high, stop_loss,
                       target_1, target_2, target_3,
                       composite_score, quant_rank, confluence_score,
                       regime_alignment, supporting_signals_json, narrative)
                    VALUES
                      (:rd, :tf, :sym, :rank, :conv,
                       :el, :eh, :sl, :t1, :t2, :t3,
                       :score, :qr, :cs, :ra, :sigs, :narr)
                """)), {
                    "rd": today, "tf": tf, "sym": symbol, "rank": rank,
                    "conv": pick["conviction"], "el": entry_low, "eh": entry_high,
                    "sl": sl, "t1": t1, "t2": t2, "t3": t3,
                    "score": pick["score"], "qr": pick["quant_rank"],
                    "cs": pick["confluence_score"], "ra": regime_align,
                    "sigs": json.dumps(signals_list[:5]),
                    "narr": narrative if rank == 1 else "",
                })
                total_inserted += 1

                if pick["conviction"] == "HIGH":
                    high_conviction_picks.append({
                        "timeframe": tf, "symbol": symbol,
                        "entry_low": entry_low, "entry_high": entry_high,
                        "sl": sl, "t1": t1, "t2": t2, "t3": t3,
                        "score": pick["score"],
                    })

        conn.commit()

    if stale_warn:
        print(f"[STRATEGIST] WARNING: >100 stale symbols, picks may be unreliable")

    print(f"[STRATEGIST] {today} | {total_inserted} picks across {len(TIMEFRAMES)} timeframes "
          f"| {len(high_conviction_picks)} HIGH conviction")
    return {"picks": total_inserted, "high_conviction": len(high_conviction_picks),
            "high_picks": high_conviction_picks}


if __name__ == "__main__":
    run()
