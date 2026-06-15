import urllib.request
import json
import sqlite3

url = "https://api.moneycontrol.com/mcapi/technicalpicks/chart-patterns?deviceType=W&version=174&start=0&limit=540&pattern_type=active&pattern_name=&time_frame=&instrument_type=&search=&analyst_id="

req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))
        
        # The structure seems to have 'status' and 'list' at root, and 'data' inside 'list'
        if 'list' in data and 'data' in data['list'] and isinstance(data['list']['data'], list):
            items = data['list']['data']
        else:
            items = []
        
        if not items:
            print("No items found in JSON structure:", list(data.keys()))
            if 'data' in data and isinstance(data['data'], dict):
                print("Keys in data:", list(data['data'].keys()))
            exit(1)
            
        # Flatten meta_data
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
        
        # Find all possible keys across all items since some items might have different meta_data keys
        all_keys = {}
        for item in items:
            for k, v in item.items():
                if k not in all_keys or all_keys[k] is None:
                    all_keys[k] = v

        print("Keys:", list(all_keys.keys()))
        
        # Create database and table
        db_name = 'database.sqlite' # Using the existing one or create new
        conn = sqlite3.connect(db_name)
        cursor = conn.cursor()
        
        table_name = 'chart_patterns'
        
        # Drop table if exists to recreate with new schema
        cursor.execute(f"DROP TABLE IF EXISTS {table_name}")
        
        # Create columns based on all_keys
        columns = []
        for key, val in all_keys.items():
            # Basic type inference for SQLite
            if isinstance(val, int):
                col_type = 'INTEGER'
            elif isinstance(val, float):
                col_type = 'REAL'
            else:
                col_type = 'TEXT'
            
            # Sanitize column name
            safe_key = key.replace('-', '_').replace(' ', '_')
            columns.append(f'"{safe_key}" {col_type}')
            
        create_table_query = f"CREATE TABLE IF NOT EXISTS {table_name} ({', '.join(columns)});"
        print("Create table query:")
        print(create_table_query)
        cursor.execute(create_table_query)
        
        # Insert data
        col_names = ', '.join(['"' + k.replace('-', '_').replace(' ', '_') + '"' for k in all_keys.keys()])
        placeholders = ', '.join(['?' for _ in all_keys.keys()])
        insert_query = f"INSERT INTO {table_name} ({col_names}) VALUES ({placeholders})"
        
        for item in items:
            values = []
            for key in all_keys.keys():
                val = item.get(key, None)
                # Convert dicts/lists to JSON strings
                if isinstance(val, (dict, list)):
                    val = json.dumps(val)
                values.append(val)
            try:
                cursor.execute(insert_query, values)
            except Exception as e:
                print(f"Error inserting row: {e}")
                
        conn.commit()
        conn.close()
        print(f"Successfully inserted {len(items)} rows into {table_name} table in {db_name}.")
        
except Exception as e:
    print("Error:", e)
