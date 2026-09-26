"""Negative control for test_ml_ensemble_never_reads_the_retired_gdelt_table: proves the
whole-file guard actually detects the SQL shape it replaced. Run:
    python src/server/tests/_negctl_gdelt_guard.py
"""
import ast
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import test_own_news_fallback as m

OLD_SQL = '''if _has_gdelt:
    news_sent_sel = """COALESCE(ts.news_sentiment_score, (
               SELECT AVG(g.avg_tone) / 10.0 FROM gdelt_sentiment g
               WHERE g.symbol = so.symbol AND g.date <= so.signal_date
           )) AS news_sentiment_score"""
'''


def _flags(src):
    return [(n, l.strip()) for n, l in m._code_lines(src)
            if "gdelt" in l.lower() and not l.lstrip().startswith("#")]


flags = _flags(OLD_SQL)
print("old SQLite-branch SQL detected as violations:", len(flags))
for n, l in flags:
    print("   line", n, "->", l[:80])
assert flags, "the guard does NOT detect the SQL shape that was removed — it is decorative"

# A docstring naming the retirement must NOT be flagged (documentation is wanted).
DOC = '"""It replaces GDELT (retired 2026-09-11)."""\nx = 1\n'
print("docstring mention flagged (should be 0):", len(_flags(DOC)))
assert not _flags(DOC), "the guard flags documentation — it will be silenced within a week"

# A comment naming it must NOT be flagged.
print("comment mention flagged (should be 0):", len(_flags("# gdelt_sentiment retired\nx = 1\n")))
print("OK: catches code, tolerates prose")
