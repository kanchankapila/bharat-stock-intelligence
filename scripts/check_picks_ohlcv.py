import sqlite3, json
conn=sqlite3.connect('database.sqlite')
with open('picks_sample.json') as f:
    syms=json.load(f)
cur=conn.cursor()
start='2023-01-01'
end='2024-12-31'
for s in syms:
    cur.execute('SELECT COUNT(1) FROM stock_ohlcv WHERE symbol=? AND date BETWEEN ? AND ?', (s,start,end))
    c=cur.fetchone()[0]
    print(s, c)
conn.close()
