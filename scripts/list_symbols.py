import sqlite3
conn=sqlite3.connect('database.sqlite')
cur=conn.cursor()
rows=cur.execute('SELECT DISTINCT symbol FROM stock_ohlcv LIMIT 200').fetchall()
print(len(rows))
for r in rows:
    print(r[0])
conn.close()
