import sys
sys.path.insert(0, "src/server")

modules = [
    "dynamic_exit",
    "transaction_costs",
    "cost_aware_sizing",
    "microstructure_signals",
    "ndtv_profit_fetcher",
    "investsights_fii_dii_fetcher",
]

for mod in modules:
    try:
        __import__(mod)
        print(f"[OK] {mod}")
    except Exception as e:
        print(f"[FAIL] {mod}: {e}")
