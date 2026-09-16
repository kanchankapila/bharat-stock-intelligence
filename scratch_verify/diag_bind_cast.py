"""Empirical check: how does SQLAlchemy 2.0 + psycopg2 handle ':p1::date' binds,
and what does convert_placeholders do to '?::date' inside a VALUES clause?"""
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
import sqlalchemy

print("SQLAlchemy", sqlalchemy.__version__)

# 1) Does text() treat :p1 as a bind when followed by ::date?
sql = "SELECT symbol FROM (VALUES (:p1::date)) AS p(anchor)"
try:
    t = text(sql)
    compiled = t.compile(dialect=postgresql.dialect())
    print("[1] compiled OK ->", compiled.string[:100])
    print("    bind names:", sorted(compiled.params.keys()))
except Exception as e:
    print("[1] COMPILE FAILED:", type(e).__name__, str(e)[:400])

# 2) What the repo actually sends after translate(): named binds but params built
#    positionally -> build_params maps tuple to {'p0':..,'p1':..}. Simulate a
#    mismatch: statement has :p1 only, params dict has p0/p1/p2.
try:
    t2 = text(sql)
    compiled2 = t2.compile(dialect=postgresql.dialect(), params={"p1": "2026-08-07"})
    print("[2] compiled with explicit param OK")
except Exception as e:
    print("[2] FAILED:", type(e).__name__, str(e)[:300])

# 3) Repo translator on the actual call-site SQL
import sys
sys.path.insert(0, r"d:/Github/bharat-stock-intelligence/src/server")
from sql_translate import translate, build_params

raw = ("SELECT symbol, anchor FROM (\n"
       "  SELECT * FROM (VALUES (?, ?::date, ?)) AS p(symbol, anchor, mode)\n"
       ") t")
tr = translate(raw)
print("[3] translate() output:")
print(tr)
bp = build_params(("QSC", "2026-08-07", "AFTER_OPEN"))
print("    build_params ->", bp)

t3 = text(tr)
try:
    c3 = t3.compile(dialect=postgresql.dialect(), params=bp)
    print("[3] compiled OK; binds seen:", sorted(c3.params.keys()))
except Exception as e:
    print("[3] compile FAILED:", type(e).__name__, str(e)[:500])

# 4) psycopg2-style %s sanity (not used here, just confirming driver paramstyle)
import sqlalchemy.dialects.postgresqldbapi  # noqa
