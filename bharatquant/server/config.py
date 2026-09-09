"""BharatQuant Desk — configuration, IST market clock, constants."""
import os
from datetime import datetime, time as dtime, date
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
UTC = ZoneInfo("UTC")

POSTGRES_URL = os.environ.get(
    "POSTGRES_URL", "postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel")
API_PORT = int(os.environ.get("BQ_API_PORT", "8811"))

# Portfolio defaults for position-sizing shown in UI
DEFAULT_CAPITAL = 100_000.0
RISK_PER_TRADE = 0.01          # 1% of capital risked per position
SWING_STOP_ATR = 2.5           # stop = entry - 2.5 * ATR14
SWING_TARGET_ATR = 4.0         # target = entry + 4.0 * ATR14
INTRADAY_STOP_PCT = 0.03       # disaster stop -3%
INTRADAY_TIME_EXIT = dtime(14, 45)
INTRADAY_HARD_EXIT = dtime(15, 15)

TIER_A_Q = 0.80                # top 20% by 20d avg turnover
TIER_B_Q = 0.50                # next 30%
MIN_PRICE = 20.0               # swing/long-term min price
INTRADAY_MIN_PRICE = 2.0
MIN_TURNOVER_CR = 5.0          # min 20d avg turnover (Rs crore) for swing


def ist_now() -> datetime:
    return datetime.now(IST)


def market_session(now: datetime | None = None) -> str:
    """PRE_OPEN | OPEN | CLOSING | CLOSED (weekends/holidays not modeled beyond weekends)."""
    now = now or ist_now()
    if now.weekday() >= 5:
        return "CLOSED"
    t = now.time()
    if dtime(9, 0) <= t < dtime(9, 15):
        return "PRE_OPEN"
    if dtime(9, 15) <= t < dtime(15, 20):
        return "OPEN"
    if dtime(15, 20) <= t <= dtime(15, 40):
        return "CLOSING"
    return "CLOSED"


def last_trading_date(now: datetime | None = None) -> date:
    now = now or ist_now()
    d = now.date()
    if now.time() < dtime(16, 0):
        d = d  # current day counts until data lands; loaders handle missing rows
    while d.weekday() >= 5:
        d = d.fromordinal(d.toordinal() - 1)
    return d
