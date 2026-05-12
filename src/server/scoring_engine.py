import sqlite3
import json
import os
import datetime

# Configuration
DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

def run_scoring():
    if not os.path.exists(DB_PATH):
        print(f"ERROR: Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    print("Fetching screeners and stocks...")
    
    stock_stats = {} # symbol -> {stock_id, score, pos_count, neg_count, reasons[]}

    # --- 1. Process Trendlyne Screeners ---
    cursor.execute("SELECT screener_id, screener_name FROM trendlyne_screeners")
    tl_screeners = {row[0]: row[1] for row in cursor.fetchall()}
    
    cursor.execute("SELECT screener_id, stock_id, symbol FROM trendlyne_screener_stocks")
    tl_mappings = cursor.fetchall()

    for sid, stock_id, symbol in tl_mappings:
        key = symbol if symbol else f"ID:{stock_id}"
        if key not in stock_stats:
            stock_stats[key] = {'stock_id': stock_id, 'score': 0, 'pos_count': 0, 'neg_count': 0, 'reasons': []}
        
        sname = tl_screeners.get(sid, "Unknown Trendlyne Screener")
        # Trendlyne screeners currently assumed positive in this simplified engine
        # In a real scenario, we'd check keywords in sname
        stock_stats[key]['score'] += 1
        stock_stats[key]['pos_count'] += 1
        stock_stats[key]['reasons'].append({'name': sname, 'sentiment': 'positive', 'source': 'Trendlyne'})

    # --- 2. Process MoneyControl Screeners ---
    cursor.execute("SELECT scan_id, screener_name, is_positive FROM moneycontrol_screeners")
    mc_screeners = {row[0]: {'name': row[1], 'is_positive': row[2]} for row in cursor.fetchall()}

    cursor.execute("SELECT scan_id, mcsymbol, symbol FROM moneycontrol_screener_stocks")
    mc_mappings = cursor.fetchall()

    for scan_id, mcsymbol, symbol in mc_mappings:
        key = symbol if symbol else f"MC:{mcsymbol}"
        if key not in stock_stats:
            stock_stats[key] = {'stock_id': mcsymbol, 'score': 0, 'pos_count': 0, 'neg_count': 0, 'reasons': []}
        
        screener = mc_screeners.get(scan_id)
        if not screener: continue

        sname = screener['name']
        is_pos = screener['is_positive']

        if is_pos:
            stock_stats[key]['score'] += 1
            stock_stats[key]['pos_count'] += 1
            stock_stats[key]['reasons'].append({'name': sname, 'sentiment': 'positive', 'source': 'MoneyControl'})
        else:
            stock_stats[key]['score'] -= 1
            stock_stats[key]['neg_count'] += 1
            stock_stats[key]['reasons'].append({'name': sname, 'sentiment': 'negative', 'source': 'MoneyControl'})

    print(f"Calculated scores for {len(stock_stats)} stocks using Trendlyne and MoneyControl data")

    # Update database
    print("Saving scores to database...")
    
    # Clear old scores to avoid stale data
    cursor.execute("DELETE FROM stock_scores")

    for symbol, stats in stock_stats.items():
        cursor.execute("""
            INSERT INTO stock_scores 
            (symbol, stock_id, score, positive_count, negative_count, reasons, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            symbol,
            stats['stock_id'],
            stats['score'],
            stats['pos_count'],
            stats['neg_count'],
            json.dumps(stats['reasons']),
            datetime.datetime.now().isoformat()
        ))

    conn.commit()
    conn.close()
    print("Scoring complete!")

if __name__ == "__main__":
    run_scoring()
