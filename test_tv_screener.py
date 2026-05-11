from tradingview_screener import get_all_symbols
import json

try:
    symbols = get_all_symbols(market='india')
    print("total:", len(symbols))
    print("first:", symbols[0])
except Exception as e:
    print(e)
