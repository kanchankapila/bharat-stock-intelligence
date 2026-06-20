import os
import sys
from datetime import datetime
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from db_compat import connect

import yfinance as yf
from tools.web_tool import web_search

DB_PATH = os.getenv("DB_PATH", "database.sqlite")


def get_live_price(symbol: str) -> dict | None:
    """Fetch real-time quote for an NSE symbol."""
    try:
        ticker = yf.Ticker(symbol.upper() + ".NS")
        fi = ticker.fast_info
        price = fi.last_price
        prev = fi.previous_close or price
        return {
            "symbol": symbol.upper(),
            "price": price,
            "change_pct": round((price - prev) / prev * 100, 2) if prev else 0.0,
            "day_high": fi.day_high,
            "day_low": fi.day_low,
            "week52_high": fi.fifty_two_week_high,
            "week52_low": fi.fifty_two_week_low,
            "volume": fi.last_volume,
        }
    except Exception:
        return None


def get_earnings_calendar(days_ahead: int = 14, db_path: str = DB_PATH) -> dict:
    """
    Fetch upcoming results calendar via web search, then cross-reference
    with DB for bullish-trending stocks.
    """
    month_year = datetime.now().strftime("%B %Y")
    query = f"NSE BSE quarterly results announcement upcoming {month_year} earnings calendar"
    web_results = web_search(query, max_results=5)

    conn = connect()
    bullish = conn.execute("""
        SELECT tas.symbol, ns.name, ns.sector, tas.trend, tas.rsi,
               ss.score, ss.classification
        FROM technical_analysis_signals tas
        JOIN nse_stocks ns ON tas.symbol = ns.symbol
        LEFT JOIN stock_scores ss ON tas.symbol = ss.symbol AND ss.timeframe = 'long_term'
        WHERE tas.trend = 'Bullish'
          AND (ss.classification IN ('Buy','Strong Buy') OR ss.classification IS NULL)
        ORDER BY ss.score DESC
        LIMIT 20
    """).fetchall()
    conn.close()

    return {
        "web_results": web_results,
        "bullish_stocks": [dict(r) for r in bullish],
        "note": f"Web search for upcoming results in {month_year}. Bullish stocks from DB for cross-reference.",
    }
