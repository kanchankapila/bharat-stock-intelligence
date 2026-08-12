import urllib.request
import json
import sys
import os
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect as db_connect
from sql_translate import use_postgres

url = "https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns?deviceType=W&version=174&start=0&limit=540&pattern_type=active&pattern_name=&time_frame=&instrument_type=&search=&analyst_id="

req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))
        
        if 'list' in data and 'data' in data['list'] and isinstance(data['list']['data'], list):
            items = data['list']['data']
        else:
            items = []
        
        if not items:
            print("No items found in JSON structure:", list(data.keys()))
            sys.exit(1)
            
        flattened_items = []
        for item in items:
            flat_item = item.copy()
            if 'meta_data' in flat_item:
                md_str = flat_item.pop('meta_data')
                if md_str:
                    try:
                        md_dict = json.loads(md_str)
                        if isinstance(md_dict, dict):
                            for k, v in md_dict.items():
                                flat_item[f"meta_data_{k}"] = v
                        else:
                            flat_item['meta_data_raw'] = md_str
                    except Exception:
                        flat_item['meta_data_raw'] = md_str
            flattened_items.append(flat_item)
            
        items = flattened_items
        
        print(f"Found {len(items)} items. Computing all unique keys across items...")
        
        all_keys = {}
        for item in items:
            for k, v in item.items():
                if k not in all_keys or all_keys[k] is None:
                    all_keys[k] = v

        print("Keys:", list(all_keys.keys()))
        
        conn = db_connect()
        table_name = 'chart_patterns'
        
        conn.execute(f"DROP TABLE IF EXISTS {table_name}")
        
        columns = []
        is_pg = use_postgres()
        for key, val in all_keys.items():
            if isinstance(val, int):
                col_type = 'BIGINT' if is_pg else 'INTEGER'
            elif isinstance(val, float):
                col_type = 'DOUBLE PRECISION' if is_pg else 'REAL'
            else:
                col_type = 'TEXT'
            
            safe_key = key.replace('-', '_').replace(' ', '_')
            columns.append(f'"{safe_key}" {col_type}')
            
        create_table_query = f"CREATE TABLE {table_name} ({', '.join(columns)});"
        print("Create table query:")
        print(create_table_query)
        conn.execute(create_table_query)
        
        col_names = ', '.join(['"' + k.replace('-', '_').replace(' ', '_') + '"' for k in all_keys.keys()])
        placeholders = ', '.join(['?' for _ in all_keys.keys()])
        insert_query = f"INSERT INTO {table_name} ({col_names}) VALUES ({placeholders})"
        
        for item in items:
            values = []
            for key in all_keys.keys():
                val = item.get(key, None)
                if isinstance(val, (dict, list)):
                    val = json.dumps(val)
                values.append(val)
            try:
                conn.execute(insert_query, values)
            except Exception as e:
                print(f"Error inserting row: {e}")
                
        conn.commit()
        conn.close()
        print(f"Successfully inserted {len(items)} rows into {table_name} table.")
        
except Exception as e:
    print("Error:", e)
