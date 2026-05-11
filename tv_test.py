import sys
import json

def test_ta():
    try:
        from tradingview_ta import TA_Handler, Interval, Exchange
        tesla = TA_Handler(
            symbol="RELIANCE",
            screener="india",
            exchange="NSE",
            interval=Interval.INTERVAL_1_DAY
        )
        print("TA:", json.dumps(tesla.get_analysis().summary))
    except Exception as e:
        print("TA error:", e)

def test_screener():
    try:
        from tradingview_screener import Query, Column
        q = (Query()
             .select('name', 'close', 'volume', 'market_cap_basic')
             .get_scanner_data())
        print("Screener result count:", len(q))
    except Exception as e:
        print("Screener error:", e)

def test_scraper():
    try:
        from tradingview_scraper import Ticker
        ticker = Ticker("NSE:RELIANCE")
        print("Scraper info:", ticker.ticker)
    except Exception as e:
        print("Scraper error:", e)

if __name__ == "__main__":
    test_ta()
    test_screener()
    test_scraper()
