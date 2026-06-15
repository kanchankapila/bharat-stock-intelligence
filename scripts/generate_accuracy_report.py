import sqlite3
import json
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta
import pytz
import os

# 1. Load the symbol mapping
with open('scripts/stocklist.json', 'r', encoding='utf-8') as f:
    stock_list = json.load(f)

# Create a mapping from mcsymbol to NSE symbol
mc_to_nse = {}
for stock in stock_list:
    if 'mcsymbol' in stock and 'symbol' in stock:
        mc_to_nse[stock['mcsymbol'].upper()] = stock['symbol']

# Also add some known index mappings
mc_to_nse['IN;SEN'] = '^BSESN'
mc_to_nse['IN;NSX'] = '^NSEI'
mc_to_nse['IN;NBX'] = '^NSEBANK'

def get_yf_symbol(price_key):
    if not price_key: return None
    
    parts = price_key.split('_')
    if len(parts) >= 2 and parts[0] == 'stk':
        mcsymbol = parts[1].upper()
        if mcsymbol in mc_to_nse:
            return mc_to_nse[mcsymbol] + '.NS'
            
    if 'in;' in price_key.lower():
        idx = price_key.split(';')[-1].upper()
        if 'IN;' + idx in mc_to_nse:
            return mc_to_nse['IN;' + idx]
            
    return None

def parse_timeframe(tf_str):
    tf_str = str(tf_str).lower()
    if 'hour' in tf_str:
        val = int(tf_str.split()[0])
        return timedelta(hours=val), '1h'
    elif 'day' in tf_str:
        val = int(tf_str.split()[0])
        return timedelta(days=val), '1d'
    elif 'week' in tf_str:
        val = int(tf_str.split()[0])
        return timedelta(weeks=val), '1d'
    elif 'month' in tf_str:
        val = int(tf_str.split()[0])
        return timedelta(days=val*30), '1d'
    else:
        return timedelta(days=7), '1d' 

# 2. Connect to DB
conn = sqlite3.connect('database.sqlite')
conn.row_factory = sqlite3.Row
cursor = conn.cursor()

cursor.execute('''
    SELECT 
        pattern_id, pattern_name, time_frame, created_at, 
        meta_data_price_key, meta_data_entry_price, 
        meta_data_target_price, meta_data_stoploss_price, meta_data_pattern_type 
    FROM chart_patterns
''')
rows = cursor.fetchall()

results = []
missing_data = []

symbol_groups = {}
for row in rows:
    d = dict(row)
    yf_symbol = get_yf_symbol(d['meta_data_price_key'])
    if not yf_symbol:
        missing_data.append(d)
        continue
    
    if not d['meta_data_entry_price'] or not d['meta_data_target_price'] or not d['meta_data_stoploss_price']:
        continue
        
    try:
        d['entry_price'] = float(str(d['meta_data_entry_price']).replace(',', ''))
        d['target_price'] = float(str(d['meta_data_target_price']).replace(',', ''))
        d['stoploss_price'] = float(str(d['meta_data_stoploss_price']).replace(',', ''))
    except ValueError:
        continue
        
    if yf_symbol not in symbol_groups:
        symbol_groups[yf_symbol] = []
    symbol_groups[yf_symbol].append(d)

ist = pytz.timezone('Asia/Kolkata')
total_processed = 0
success_hits = 0
sl_hits = 0

print(f"Total unique symbols to process: {len(symbol_groups)}")

for sym, items in symbol_groups.items():
    print(f"Fetching data for {sym}...")
    min_date = min([datetime.strptime(i['created_at'], '%Y-%m-%d %H:%M:%S') for i in items])
    
    try:
        # download 1h data (fails if older than 730 days, but we assume it's recent)
        df_1h = yf.download(sym, start=min_date.strftime('%Y-%m-%d'), interval='1h', progress=False)
        df_1d = yf.download(sym, start=min_date.strftime('%Y-%m-%d'), interval='1d', progress=False)
    except Exception as e:
        print(f"Error fetching {sym}: {e}")
        for i in items: missing_data.append(i)
        continue
        
    if df_1h.empty and df_1d.empty:
        for i in items: missing_data.append(i)
        continue

    # Flatten multi-index column if any
    if isinstance(df_1h.columns, pd.MultiIndex):
        df_1h.columns = df_1h.columns.get_level_values(0)
    if isinstance(df_1d.columns, pd.MultiIndex):
        df_1d.columns = df_1d.columns.get_level_values(0)

    # ensure timezone aware for comparison
    if not df_1h.empty and df_1h.index.tz is None:
        df_1h.index = df_1h.index.tz_localize('Asia/Kolkata')
    if not df_1d.empty and df_1d.index.tz is None:
        df_1d.index = df_1d.index.tz_localize('Asia/Kolkata')

    for item in items:
        dt = datetime.strptime(item['created_at'], '%Y-%m-%d %H:%M:%S')
        dt = ist.localize(dt)
        delta, interval = parse_timeframe(item['time_frame'])
        end_dt = dt + delta
        
        df = df_1h if interval == '1h' and not df_1h.empty else df_1d
        
        period_df = df[(df.index >= dt) & (df.index <= end_dt)]
        
        if period_df.empty:
            item['status'] = 'Pending/No Data'
            item['max_return'] = 0.0
            results.append(item)
            continue
            
        entry = item['entry_price']
        target = item['target_price']
        sl = item['stoploss_price']
        is_buy = str(item['meta_data_pattern_type']).lower() == 'buy'
        
        target_hit = False
        sl_hit = False
        
        if is_buy:
            max_price = float(period_df['High'].max())
            max_return = (max_price / entry - 1) * 100 if entry > 0 else 0
            for idx, r in period_df.iterrows():
                if float(r['Low']) <= sl:
                    sl_hit = True
                if float(r['High']) >= target:
                    target_hit = True
                if sl_hit or target_hit:
                    break
        else:
            min_price = float(period_df['Low'].min())
            max_return = (1 - min_price / entry) * 100 if entry > 0 else 0
            for idx, r in period_df.iterrows():
                if float(r['High']) >= sl:
                    sl_hit = True
                if float(r['Low']) <= target:
                    target_hit = True
                if sl_hit or target_hit:
                    break
                    
        item['max_return'] = max_return
        if target_hit and not sl_hit:
            item['status'] = 'Target Hit'
            success_hits += 1
        elif sl_hit and not target_hit:
            item['status'] = 'Stoploss Hit'
            sl_hits += 1
        elif target_hit and sl_hit:
            item['status'] = 'Target Hit'
            success_hits += 1
        else:
            item['status'] = 'Time Expired'
            
        results.append(item)
        total_processed += 1

# Export report
artifact_path = r'C:\Users\amitk\.gemini\antigravity-ide\brain\5393392f-08ba-4527-9de6-8fadb6d54347\chart_pattern_accuracy_report.md'
with open(artifact_path, 'w', encoding='utf-8') as f:
    f.write("# Chart Pattern Accuracy Report\n\n")
    
    if total_processed > 0:
        win_rate = (success_hits / total_processed) * 100
        f.write("## Summary Metrics\n")
        f.write(f"- **Total Analyzed:** {total_processed}\n")
        f.write(f"- **Target Achieved:** {success_hits} ({win_rate:.2f}%)\n")
        f.write(f"- **Stoploss Hit:** {sl_hits}\n")
        
        avg_ret = sum(r['max_return'] for r in results) / len(results)
        f.write(f"- **Average Max Return:** {avg_ret:.2f}%\n\n")
        
        f.write("## Performance by Timeframe\n")
        f.write("| Timeframe | Analyzed | Target Hit | Win Rate |\n")
        f.write("|-----------|----------|------------|----------|\n")
        
        tfs = set([r['time_frame'] for r in results])
        for tf in sorted(list(tfs)):
            tf_items = [r for r in results if r['time_frame'] == tf]
            tf_hits = len([r for r in tf_items if r['status'] == 'Target Hit'])
            tf_rate = (tf_hits / len(tf_items)) * 100 if len(tf_items) > 0 else 0
            f.write(f"| {tf} | {len(tf_items)} | {tf_hits} | {tf_rate:.2f}% |\n")
            
        f.write("\n## Detailed Log (Top 25 by Return)\n")
        f.write("| Symbol | Pattern | Timeframe | Entry | Target | SL | Status | Max Return |\n")
        f.write("|--------|---------|-----------|-------|--------|----|--------|------------|\n")
        
        sorted_res = sorted(results, key=lambda x: x['max_return'], reverse=True)[:25]
        for r in sorted_res:
            sym = get_yf_symbol(r['meta_data_price_key'])
            f.write(f"| {sym} | {r['pattern_name']} | {r['time_frame']} | {r['entry_price']} | {r['target_price']} | {r['stoploss_price']} | {r['status']} | {r['max_return']:.2f}% |\n")
            
    f.write("\n## Data Unavailable\n")
    f.write(f"Total rows with unmapped symbols or missing API data: {len(missing_data)}\n")
    if missing_data:
        f.write("\n**Sample Unmapped Keys:**\n")
        samples = list(set([m['meta_data_price_key'] for m in missing_data]))[:10]
        for s in samples:
            f.write(f"- `{s}`\n")

print(f"Report successfully generated at: {artifact_path}")
