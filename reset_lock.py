import sqlite3
con = sqlite3.connect('database.sqlite')
con.execute("UPDATE app_settings SET value='0' WHERE key='dl_retrain_running'")
con.commit()
print("Lock cleared")
