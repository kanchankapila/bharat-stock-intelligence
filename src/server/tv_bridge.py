import polars as pl
import sys
import json
import argparse
import traceback

def get_ta(symbol, exchange='NSE'):
    try:
        from tradingview_ta import TA_Handler, Interval
        handler = TA_Handler(
            symbol=symbol,
            screener="india",
            exchange=exchange,
            interval=Interval.INTERVAL_1_DAY
        )
        analysis = handler.get_analysis()
        return {
            "summary": analysis.summary,
            "oscillators": analysis.oscillators,
            "moving_averages": analysis.moving_averages,
            "indicators": analysis.indicators
        }
    except Exception as e:
        return {"error": str(e)}

def get_ideas(symbol):
    try:
        from tradingview_scraper import Ideas
        # Returns a tuple: (pandas DataFrame, symbol description)
        df, description = Ideas().scraper(symbol=symbol, startPage=1, endPage=1)
        # Convert df to list of dicts
        ideas = df.to_dict(orient='records')
        # Handle nan values
        import math
        for idea in ideas:
            for k, v in idea.items():
                if isinstance(v, float) and math.isnan(v):
                    idea[k] = None
        return {"description": description, "ideas": ideas}
    except Exception as e:
        return {"error": str(e)}

def get_screener():
    try:
        from tradingview_screener import stocks
        # Get top 50 indian stocks by market cap (default sorting)
        q = stocks('india')
        count, df = q.get_scanner_data()
        
        # Convert pandas dataframe to list of dicts, handle NaN
        import math
        results = df.to_dict(orient='records')
        for row in results:
            for k, v in row.items():
                if isinstance(v, float) and math.isnan(v):
                    row[k] = None
        
        return {"results": results}
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["ta", "ideas", "screener"])
    parser.add_argument("--symbol", type=str, default="")
    parser.add_argument("--exchange", type=str, default="NSE")
    args = parser.parse_args()

    result = {}
    try:
        if args.action == "ta":
            result = get_ta(args.symbol, args.exchange)
        elif args.action == "ideas":
            result = get_ideas(args.symbol)
        elif args.action == "screener":
            result = get_screener()
    except Exception as e:
        result = {"error": str(e), "traceback": traceback.format_exc()}

    print(json.dumps(result))

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
