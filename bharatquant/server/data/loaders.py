"""SQL loaders — every datasource in the platform, returning tidy DataFrames."""
import pandas as pd

from ..db import qdf


def universe() -> pd.DataFrame:
    return qdf("""
        SELECT symbol, name, sector, industry, market_cap, pe_ratio, dividend_yield,
               isin, is_asm, gsm_stage, fno_eligible, is_nifty50, is_nifty100,
               is_nifty200, is_midcap150, is_smallcap250, listing_date
        FROM nse_stocks WHERE status = 'ACTIVE';
    """)


def daily_all(days_back: int = 760) -> pd.DataFrame:
    return qdf("""
        SELECT symbol, date, open, high, low, close, volume, is_suspect
        FROM stock_ohlcv
        WHERE date >= (SELECT max(date) FROM stock_ohlcv) - (%s || ' days')::interval
        ORDER BY symbol, date;
    """, (days_back,))


def daily_index(symbol: str = "NIFTY50", days_back: int = 500) -> pd.DataFrame:
    return qdf("""
        SELECT date, open, high, low, close, volume
        FROM stock_ohlcv
        WHERE symbol = %s AND date >= (SELECT max(date) FROM stock_ohlcv) - (%s || ' days')::interval
        ORDER BY date;
    """, (symbol, days_back))


def intraday_session(day: str) -> pd.DataFrame:
    """15m bars for one IST date, correctly-stamped grid only (UTC 03:45..10:00)."""
    return qdf("""
        SELECT symbol, datetime, open, high, low, close, volume
        FROM intraday_ohlcv
        WHERE datetime::date = %s::date
          AND datetime::time BETWEEN '03:45' AND '10:00'
        ORDER BY symbol, datetime;
    """, (day,))


def intraday_days_liquid(k: int = 3) -> pd.DataFrame:
    """Most recent k dates with widest intraday universe coverage."""
    return qdf("""
        SELECT d::date AS day, syms FROM (
          SELECT datetime::date d, count(DISTINCT symbol) syms
          FROM intraday_ohlcv
          WHERE datetime::time BETWEEN '03:45' AND '10:00'
          GROUP BY 1) x
        WHERE syms > 500 ORDER BY d DESC LIMIT %s;
    """, (k,))

def valuation_snapshot() -> pd.DataFrame:
    """Latest PE/PB per symbol + percentile of that value within its 3y history.
    Single-window query (row_number for latest, percent_rank for historical value).
    """
    return qdf("""
        WITH recent AS (
          SELECT symbol, date, pe_ttm FROM trendlyne_pe_history
          WHERE date > (SELECT max(date) FROM trendlyne_pe_history) - interval '3 years'),
        ranked AS (
          SELECT symbol, pe_ttm,
                 row_number() OVER (PARTITION BY symbol ORDER BY date DESC) rn,
                 percent_rank()   OVER (PARTITION BY symbol ORDER BY pe_ttm)  pr
          FROM recent),
        rpe AS (SELECT symbol, pe_ttm, pr AS pe_pct FROM ranked WHERE rn = 1),
        pb3 AS (
          SELECT symbol, date, pb_ratio FROM trendlyne_pb_history
          WHERE date > (SELECT max(date) FROM trendlyne_pb_history) - interval '3 years'),
        pranked AS (
          SELECT symbol, pb_ratio,
                 row_number() OVER (PARTITION BY symbol ORDER BY date DESC) rn,
                 percent_rank()   OVER (PARTITION BY symbol ORDER BY pb_ratio)  pr
          FROM pb3),
        rpb AS (SELECT symbol, pb_ratio, pr AS pb_pct FROM pranked WHERE rn = 1)
        SELECT rpe.symbol, rpe.pe_ttm, rpe.pe_pct, rpb.pb_ratio, rpb.pb_pct
        FROM rpe LEFT JOIN rpb USING (symbol);
    """)


def fundamentals_latest() -> pd.DataFrame:
    return qdf("""
        SELECT DISTINCT ON (symbol) symbol, as_of_date, piotroski_f_score, debt_to_equity,
               operating_margins, return_on_equity, revenue_growth, earnings_growth, pledge_pct
        FROM fundamentals_history ORDER BY symbol, as_of_date DESC;
    """)


def options_oi_recent(days_back: int = 120) -> pd.DataFrame:
    return qdf("""
        SELECT symbol, date, pcr, total_call_oi, total_put_oi, atm_iv, iv_skew
        FROM stock_options_oi
        WHERE date >= (SELECT max(date) FROM stock_options_oi) - (%s || ' days')::interval;
    """, (days_back,))


def futures_oi_recent(days_back: int = 30) -> pd.DataFrame:
    return qdf("""
        SELECT symbol, date, open_interest, oi_change, oi_pct_change, oi_buildup, basis,
               futures_volume, spot_price
        FROM stock_futures_oi_history
        WHERE date >= (SELECT max(date) FROM stock_futures_oi_history) - (%s || ' days')::interval;
    """, (days_back,))


def fii_dii(days_back: int = 30) -> pd.DataFrame:
    return qdf("""
        SELECT date, fii_net, dii_net FROM fii_dii_flow
        WHERE date >= (SELECT max(date) FROM fii_dii_flow) - (%s || ' days')::interval ORDER BY date;
    """, (days_back,))


def regimes(days_back: int = 40) -> pd.DataFrame:
    return qdf("""
        SELECT date, regime, regime_prob FROM market_regimes
        WHERE date >= (SELECT max(date) FROM market_regimes) - (%s || ' days')::interval ORDER BY date;
    """, (days_back,))


def news_for_symbol(symbol: str, days_back: int = 21, limit: int = 40) -> pd.DataFrame:
    return qdf("""
        SELECT id, title, source, sentiment, category, timestamp
        FROM news_articles
        WHERE (',' || symbols || ',') ILIKE %s
          AND timestamp >= now() - (%s || ' days')::interval
        ORDER BY timestamp DESC LIMIT %s;
    """, (f"%,{symbol},%", days_back, limit))


def news_recent(limit: int = 60) -> pd.DataFrame:
    return qdf("""
        SELECT id, title, source, sentiment, category, symbols, timestamp
        FROM news_articles ORDER BY timestamp DESC LIMIT %s;
    """, (limit,))


def preopen(day: str) -> pd.DataFrame:
    return qdf("""
        SELECT symbol, iep, prev_close, iep_gap_pct, preopen_imbalance, total_buy_qty, total_sell_qty
        FROM preopen_stock_snapshot WHERE snapshot_date = %s::date;
    """, (day,))

def delivery_recent(days_back: int = 120) -> pd.DataFrame:
    return qdf("""
        SELECT symbol, date, delivery_pct, traded_qty
        FROM stock_delivery_data
        WHERE date >= (SELECT max(date) FROM stock_delivery_data) - (%s || ' days')::interval;
    """, (days_back,))


def pe_history(symbol: str) -> pd.DataFrame:
    return qdf("SELECT date, pe_ttm FROM trendlyne_pe_history WHERE symbol=%s ORDER BY date;", (symbol,))


def pb_history(symbol: str) -> pd.DataFrame:
    return qdf("SELECT date, pb_ratio FROM trendlyne_pb_history WHERE symbol=%s ORDER BY date;", (symbol,))