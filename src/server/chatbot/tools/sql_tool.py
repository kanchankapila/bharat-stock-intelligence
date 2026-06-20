import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from db_compat import connect as db_connect

DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def _connect(db_path: str = None):
    return db_connect()


def get_stock_fundamentals(symbol: str, db_path: str = DB_PATH) -> dict | None:
    """Full profile for a single stock: fundamentals + AI score + factor breakdown."""
    conn = _connect(db_path)
    row = conn.execute("""
        SELECT ns.symbol, ns.name, ns.sector, ns.industry,
               sf.trailing_pe, sf.price_to_book, sf.return_on_equity,
               sf.revenue_growth, sf.earnings_growth, sf.debt_to_equity,
               sf.market_cap, sf.piotroski_f_score, sf.dividend_yield,
               ss.score, ss.confidence, ss.classification, ss.top_domain,
               fb.technical AS technical_score, fb.fundamental AS fundamental_score,
               fb.momentum AS momentum_score, fb.valuation AS valuation_score
        FROM nse_stocks ns
        LEFT JOIN stock_fundamentals sf ON ns.symbol = sf.symbol
        LEFT JOIN stock_scores ss ON ns.symbol = ss.symbol AND ss.timeframe = 'long_term'
        LEFT JOIN stock_factor_breakdown fb ON ns.symbol = fb.symbol AND fb.timeframe = 'long_term'
        WHERE ns.symbol = ?
    """, (symbol.upper(),)).fetchone()
    conn.close()
    return dict(row) if row else None


def filter_stocks_by_fundamentals(
    pe_lt: float | None = None,
    pb_lt: float | None = None,
    roe_gt: float | None = None,
    revenue_growth_gt: float | None = None,
    min_score: float = 50.0,
    limit: int = 15,
    db_path: str = DB_PATH,
) -> list[dict]:
    """Filter stocks by fundamental criteria and AI score."""
    conditions = ["ss.score >= ?", "ss.timeframe = 'long_term'"]
    params: list = [min_score]

    if pe_lt is not None:
        conditions.append("sf.trailing_pe < ? AND sf.trailing_pe > 0")
        params.append(pe_lt)
    if pb_lt is not None:
        conditions.append("sf.price_to_book < ? AND sf.price_to_book > 0")
        params.append(pb_lt)
    if roe_gt is not None:
        conditions.append("sf.return_on_equity > ?")
        params.append(roe_gt)
    if revenue_growth_gt is not None:
        conditions.append("sf.revenue_growth > ?")
        params.append(revenue_growth_gt)

    query = f"""
        SELECT ns.symbol, ns.name, ns.sector,
               sf.trailing_pe, sf.price_to_book, sf.return_on_equity,
               sf.revenue_growth, sf.market_cap, sf.piotroski_f_score,
               sf.debt_to_equity, sf.dividend_yield,
               ss.score, ss.classification
        FROM stock_fundamentals sf
        JOIN stock_scores ss ON sf.symbol = ss.symbol
        JOIN nse_stocks ns ON sf.symbol = ns.symbol
        WHERE {' AND '.join(conditions)}
        ORDER BY ss.score DESC
        LIMIT ?
    """
    params.append(limit)

    conn = _connect(db_path)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_buy_signals(
    symbol: str | None = None,
    min_confidence: float = 0.65,
    limit: int = 20,
    db_path: str = DB_PATH,
) -> list[dict]:
    """
    Active BUY signals. Queries unified_signals (live, updated daily).
    """
    conn = _connect(db_path)
    cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

    # unified_signals (live, updated daily)
    try:
        conditions = [
            "signal_type = 'BUY'",
            "signal_date >= ?",
            "confidence_score >= ?",
        ]
        params: list = [cutoff, min_confidence]
        if symbol:
            conditions.append("symbol = ?")
            params.append(symbol.upper())
        params.append(limit)
        rows = conn.execute(
            f"SELECT symbol, signal_date, signal_source, signal_type, "
            f"entry_price AS entry, target_price AS target, stop_loss AS stopLoss, "
            f"confidence_score AS confidence, reasoning "
            f"FROM unified_signals "
            f"WHERE {' AND '.join(conditions)} "
            f"ORDER BY confidence_score DESC, signal_date DESC LIMIT ?",
            params,
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        conn.close()
        return []


def get_screener_membership(symbol: str, db_path: str = DB_PATH) -> list[dict]:
    """Which screeners does this stock appear in?"""
    sym = symbol.upper()
    conn = _connect(db_path)

    rows = conn.execute("""
        SELECT sm.name AS screener_name, sm.source, sm.inferred_sentiment, sm.inferred_category
        FROM trendlyne_screener_stocks tss
        JOIN screener_master sm ON tss.screener_id = sm.scan_id
        WHERE tss.symbol = ?
        UNION
        SELECT sm.name AS screener_name, sm.source, sm.inferred_sentiment, sm.inferred_category
        FROM moneycontrol_screener_stocks mss
        JOIN screener_master sm ON mss.scan_id = sm.scan_id
        WHERE mss.symbol = ?
    """, (sym, sym)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_quant_scores(
    symbol: str | None = None,
    sort_by: str = "momentum_score",
    above_sma200_only: bool = False,
    limit: int = 20,
    db_path: str = DB_PATH,
) -> list[dict]:
    """Quant momentum/return scores, optionally for a single symbol."""
    allowed_sort = {"momentum_score", "return_1m", "return_3m", "return_6m", "return_12m", "return_1w"}
    if sort_by not in allowed_sort:
        sort_by = "momentum_score"

    conditions = []
    params: list = []

    if symbol:
        conditions.append("qs.symbol = ?")
        params.append(symbol.upper())
    if above_sma200_only:
        conditions.append("qs.above_sma200 = 1")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    query = f"""
        SELECT qs.symbol, ns.name, ns.sector,
               qs.return_1w, qs.return_1m, qs.return_3m, qs.return_6m,
               qs.above_sma200, qs.momentum_score,
               ss.score, ss.classification
        FROM quant_scores qs
        JOIN nse_stocks ns ON qs.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON qs.symbol = ss.symbol AND ss.timeframe = 'long_term'
        {where}
        ORDER BY qs.{sort_by} DESC
        LIMIT ?
    """
    params.append(limit)

    conn = _connect(db_path)
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]
