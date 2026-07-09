#!/usr/bin/env python3
import os
import json

# Define paths
SCRIPTS_DIR = os.path.dirname(__file__)
STOCKLIST_JSON_PATH = os.path.join(SCRIPTS_DIR, "stocklist.json")
STOCKLIST_JS_PATH = os.path.join(SCRIPTS_DIR, "stocklist.js")
STOCKLIST_TS_PATH = os.path.join(os.path.dirname(SCRIPTS_DIR), "src", "data", "stocklist.ts")
FINOLOGY_MAPPINGS_PATH = os.path.join(SCRIPTS_DIR, "finology_mappings.json")

def main():
    if not os.path.exists(FINOLOGY_MAPPINGS_PATH):
        print(f"Error: {FINOLOGY_MAPPINGS_PATH} does not exist. Run fetch_finology_mappings.py first.")
        return

    if not os.path.exists(STOCKLIST_JSON_PATH):
        print(f"Error: {STOCKLIST_JSON_PATH} does not exist.")
        return

    # 1. Load Finology mappings
    with open(FINOLOGY_MAPPINGS_PATH, "r", encoding="utf-8") as f:
        fin_list = json.load(f)
    
    fin_map = {}
    for entry in fin_list:
        sym = entry.get("symbol")
        if sym:
            fin_map[sym.upper()] = {
                "fincode": entry.get("fincode"),
                "scripcode": entry.get("scripcode")
            }

    # 2. Load and update Stocklist array
    with open(STOCKLIST_JSON_PATH, "r", encoding="utf-8") as f:
        stock_list = json.load(f)

    updated_count = 0
    for entry in stock_list:
        sym = entry.get("symbol")
        if sym:
            sym_upper = sym.strip().upper()
            if sym_upper in fin_map:
                fin_data = fin_map[sym_upper]
                # Only add if we have valid codes
                if fin_data["fincode"] is not None:
                    entry["fincode"] = fin_data["fincode"]
                    updated_count += 1
                if fin_data["scripcode"] is not None:
                    entry["scripcode"] = fin_data["scripcode"]

    print(f"Successfully updated {updated_count} stocks in stocklist.json")

    # 3. Write back to scripts/stocklist.json
    with open(STOCKLIST_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(stock_list, f, indent=2, ensure_ascii=False)
    print(f"Wrote updated scripts/stocklist.json")

    # 4. Generate src/data/stocklist.ts
    ts_interface = """export interface StockMapping {
  name: string;
  mcsymbol: string;
  tlid: string;
  tlname: string;
  isin: string;
  symbol: string;
  stockid: string;
  companyid: string;
  tickertape_sid?: string;
  fincode?: number;
  scripcode?: number;
}
"""
    ts_array_str = json.dumps(stock_list, indent=2, ensure_ascii=False)
    ts_content = f"{ts_interface}\nconst stockData: StockMapping[] = {ts_array_str};\n\nexport default stockData;\n"
    
    with open(STOCKLIST_TS_PATH, "w", encoding="utf-8") as f:
        f.write(ts_content)
    print(f"Wrote updated {STOCKLIST_TS_PATH}")

    # 5. Generate scripts/stocklist.js
    js_array_str = json.dumps(stock_list, indent=4, ensure_ascii=False)
    js_content = f'"use strict";\nObject.defineProperty(exports, "__esModule", {{ value: true }});\nvar stockData = {js_array_str};\nexports.default = stockData;\n'
    
    with open(STOCKLIST_JS_PATH, "w", encoding="utf-8") as f:
        f.write(js_content)
    print(f"Wrote updated scripts/stocklist.js")

if __name__ == "__main__":
    main()
