import sqlite3, sys
sym = sys.argv[1] if len(sys.argv) > 1 else 'ADANIPORTS'
conn=sqlite3.connect('database.sqlite')
cur=conn.cursor()
cur.execute('SELECT MIN(date), MAX(date), COUNT(1) FROM stock_ohlcv WHERE symbol=?', (sym,))
print(cur.fetchone())
conn.close()
