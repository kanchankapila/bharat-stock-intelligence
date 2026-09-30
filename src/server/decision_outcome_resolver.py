"""Resolve realized outcomes for market_decision_event rows into market_decision_outcome.

record_decision_outcome() existed from 2026-09-25 with no caller, so every decision the ranker
emitted stayed ungraded and the table's freshness check could never pass.

Label `next_open_close_h{N}` (one label per horizon row, keyed by horizon_days):
  entry  = OPEN of the first session strictly after the IST date on which the decision became
           knowable (generated_at in Asia/Kolkata) -- the ranker runs after the close, so the
           same-day bar is never tradeable against it;
  exit   = CLOSE of the N-th session counting the entry session as 1;
  mfe/mae = max(high)/min(low) over those N sessions vs entry, in percent.
return_pct is the raw price move; the decision's direction lives on market_decision_event and is
deliberately not folded in here, so a Sell and a Buy on one name grade against the same move.

A window containing an is_suspect bar is recorded `excluded` (no prices), never graded.
Pending rows are written once and upgraded in place when enough sessions exist.
"""
import argparse
import sys
from collections import defaultdict
from typing import Dict, Iterable

from db_compat import connect
from semantic_evidence import record_decision_outcome, semantic_schema_available

LABEL = "next_open_close"
HORIZONS = (1, 5, 15)


def resolve_decision_outcomes(conn, horizons: Iterable[int] = HORIZONS) -> Dict[str, int]:
    if not semantic_schema_available(conn):
        raise RuntimeError("market decision schema is not installed")
    horizons = tuple(int(h) for h in horizons)
    events = conn.execute(
        "SELECT decision_key, symbol, "
        "       (generated_at AT TIME ZONE 'Asia/Kolkata')::date AS knowable_date "
        "FROM market_decision_event"
    ).fetchall()
    done = {
        (r[0], int(r[1])) for r in conn.execute(
            "SELECT decision_key, horizon_days FROM market_decision_outcome "
            "WHERE label_definition = ? AND outcome_status IN ('resolved', 'excluded')",
            [LABEL]).fetchall()
    }
    pending_seen = {
        (r[0], int(r[1])) for r in conn.execute(
            "SELECT decision_key, horizon_days FROM market_decision_outcome "
            "WHERE label_definition = ? AND outcome_status = 'pending'", [LABEL]).fetchall()
    }
    todo = [(k, s, d) for k, s, d in events if any((k, h) not in done for h in horizons)]
    counts = {"resolved": 0, "excluded": 0, "pending": 0, "unchanged": 0}
    if not todo:
        return counts

    by_symbol = defaultdict(list)
    for k, s, d in todo:
        by_symbol[s].append((k, d))
    floor = min(d for _, _, d in todo)
    bars = defaultdict(list)
    for sym, date, o, h, l, c, sus in conn.execute(
        "SELECT symbol, date, open, high, low, close, COALESCE(is_suspect, 0) "
        "FROM stock_ohlcv WHERE date >= ? AND symbol = ANY(?) ORDER BY symbol, date",
        [floor, list(by_symbol)]).fetchall():
        bars[sym].append((date, o, h, l, c, sus))

    for sym, decisions in by_symbol.items():
        series = bars.get(sym, [])
        for key, knowable in decisions:
            after = [b for b in series if b[0] > knowable]
            for hz in horizons:
                if (key, hz) in done:
                    continue
                window = after[:hz]
                if len(window) < hz:
                    if (key, hz) in pending_seen:
                        counts["unchanged"] += 1
                        continue
                    record_decision_outcome(conn, decision=key, label_definition=LABEL,
                                            horizon_days=hz, outcome_status="pending",
                                            source_table="stock_ohlcv")
                    counts["pending"] += 1
                    continue
                ref = f"{window[0][0]}..{window[-1][0]}"
                entry = window[0][1]
                if any(b[5] for b in window) or not entry or entry <= 0:
                    record_decision_outcome(conn, decision=key, label_definition=LABEL,
                                            horizon_days=hz, outcome_status="excluded",
                                            source_table="stock_ohlcv", source_ref=ref)
                    counts["excluded"] += 1
                    continue
                exit_ = window[-1][4]
                hi = max(b[2] for b in window)
                lo = min(b[3] for b in window)
                record_decision_outcome(
                    conn, decision=key, label_definition=LABEL, horizon_days=hz,
                    outcome_status="resolved", entry_price=entry, exit_price=exit_,
                    return_pct=(exit_ / entry - 1) * 100, mfe_pct=(hi / entry - 1) * 100,
                    mae_pct=(lo / entry - 1) * 100, resolved_at=str(window[-1][0]),
                    source_table="stock_ohlcv", source_ref=ref)
                counts["resolved"] += 1
    return counts


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--horizons", default=",".join(map(str, HORIZONS)))
    args = p.parse_args(argv)
    conn = connect()
    try:
        counts = resolve_decision_outcomes(conn, [int(h) for h in args.horizons.split(",")])
        conn.commit()
    finally:
        conn.close()
    print(f"[decision-outcomes] {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
