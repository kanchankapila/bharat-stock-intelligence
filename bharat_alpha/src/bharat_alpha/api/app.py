"""Read-only HTTP API. Serves ONLY the canonical recommendation table plus the evidence behind
it; there is no endpoint that computes an alternative "final" score on the fly.

Every recommendation response carries the edge status and the realised track record, so a
consumer can never see a ranked list without seeing whether the ranking has earned trust.
"""
from __future__ import annotations

import datetime as dt

from fastapi import FastAPI, HTTPException, Query

from bharat_alpha.config import get_settings
from bharat_alpha.db import connect, get_status, jsonable, read_df
from bharat_alpha.learning.monitor import realized_edge

app = FastAPI(title="bharat_alpha", version="0.1.0")


def _latest_date(conn, horizon: int) -> dt.date | None:
    d = read_df(conn, "SELECT max(as_of_date) d FROM alpha.recommendation WHERE horizon=%s", (horizon,)).d[0]
    return d


@app.get("/health")
def health():
    with connect() as conn:
        dq = read_df(conn, """SELECT DISTINCT ON (check_id) check_id, status, detail, run_at FROM alpha.dq_result
                              ORDER BY check_id, run_at DESC""")
        last = read_df(conn, "SELECT max(trade_date) d FROM alpha.trading_day").d[0]
    failing = dq[dq.status == "fail"]
    return {"status": "degraded" if len(failing) else "ok", "latest_session": str(last) if last else None,
            "failing_checks": failing[["check_id", "detail"]].to_dict("records")}


@app.get("/recommendations")
def recommendations(horizon: int = 21, as_of: dt.date | None = None, action: str | None = Query(None, pattern="^(BUY|HOLD|AVOID)$"),
                    limit: int = Query(50, le=5000)):
    with connect() as conn:
        as_of = as_of or _latest_date(conn, horizon)
        if as_of is None:
            raise HTTPException(404, "no recommendations published yet")
        q = """SELECT r.rank, s.symbol, r.action, r.score, r.pred_excess, r.prob_outperform, r.interval_lo,
                      r.interval_hi, r.edge_status, r.model_id
               FROM alpha.recommendation r
               JOIN alpha.symbol_history s ON s.instrument_id = r.instrument_id
                    AND s.valid_from <= r.as_of_date AND (s.valid_to IS NULL OR s.valid_to >= r.as_of_date)
               WHERE r.as_of_date=%s AND r.horizon=%s AND (%s::text IS NULL OR r.action=%s)
               ORDER BY r.rank LIMIT %s"""
        rows = read_df(conn, q, (as_of, horizon, action, action, limit))
        model_id = rows.model_id.iloc[0] if len(rows) else None
        track = realized_edge(conn, model_id, horizon) if model_id else {}
    return jsonable({"as_of": as_of, "horizon": horizon, "edge_status": rows.edge_status.iloc[0] if len(rows) else None,
                     "realized_track_record": track, "items": rows.drop(columns=["model_id", "edge_status"]).to_dict("records")})


@app.get("/stock/{symbol}")
def stock(symbol: str, horizon: int = 21, days: int = Query(60, le=500)):
    with connect() as conn:
        iid = read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s ORDER BY valid_from DESC LIMIT 1",
                      (symbol.upper(),))
        if iid.empty:
            raise HTTPException(404, f"unknown symbol {symbol}")
        i = int(iid.instrument_id[0])
        hist = read_df(conn, """SELECT r.as_of_date, r.rank, r.action, r.pred_excess, o.excess_mean AS realized_excess
                                FROM alpha.recommendation r
                                LEFT JOIN alpha.outcome o ON o.model_id=r.model_id AND o.as_of_date=r.as_of_date
                                     AND o.instrument_id=r.instrument_id
                                WHERE r.instrument_id=%s AND r.horizon=%s ORDER BY r.as_of_date DESC LIMIT %s""",
                       (i, horizon, days))
    return jsonable({"symbol": symbol.upper(), "horizon": horizon, "history": hist.to_dict("records")})


@app.get("/models")
def models():
    with connect() as conn:
        m = read_df(conn, """SELECT model_id, horizon, status, trained_at, train_start, train_end, promoted_at,
                                    cv_report->'ensemble' AS oof_ensemble, cv_report->'backtest' AS oof_backtest,
                                    gate_report->'failures' AS gate_failures
                             FROM alpha.model ORDER BY trained_at DESC LIMIT 20""")
        monitor = {f"h{h}": get_status(conn, f"monitor_h{h}") for h in get_settings().horizons}
    return jsonable({"models": m.to_dict("records"), "monitor": monitor})
