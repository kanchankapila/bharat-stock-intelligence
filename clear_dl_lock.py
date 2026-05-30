import sqlite3
con = sqlite3.connect("database.sqlite")
con.execute("UPDATE app_settings SET value='0' WHERE key='dl_retrain_running'")
con.commit()
row = con.execute("SELECT value FROM app_settings WHERE key='dl_retrain_running'").fetchone()
print("Lock cleared:", row)
con.close()
