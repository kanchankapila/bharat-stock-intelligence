"""AF-20260925-02: a broad `except Exception: pass` around a database call drops a row, symbol or
chunk and the job still reports success. Measured by AST: 29 such handlers on 2026-09-25; the
remaining ones (13 by 2026-10-04) now log to stderr. This scan derives the set from the source
tree (not an allowlist) so a NEW silent handler fails here instead of hiding the next outage."""
import ast
import pathlib

SERVER = pathlib.Path(__file__).resolve().parents[1]
DB_CALLS = {'execute', 'executemany', 'fetchall', 'fetchone', 'read_df', 'read_sql', 'read_sql_query'}
# Test-support module: its swallow is part of schema-reaping teardown, not a production data path.
EXEMPT_FILES = {'pg_test_support.py'}


def _silent_db_handlers(source: str):
    tree = ast.parse(source)
    found, broad_total = [], 0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        called = {n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, 'id', '')
                  for b in node.body for n in ast.walk(b) if isinstance(n, ast.Call)}
        for h in node.handlers:
            broad = h.type is None or (isinstance(h.type, ast.Name) and h.type.id in ('Exception', 'BaseException'))
            if not broad:
                continue
            broad_total += 1
            silent = all(isinstance(s, (ast.Pass, ast.Continue)) or
                         (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)) for s in h.body)
            if silent and (called & DB_CALLS):
                found.append(h.lineno)
    return found, broad_total


def test_scanner_recognises_the_defect_shape():
    bad = "def f(c):\n    try:\n        c.execute('SELECT 1')\n    except Exception:\n        pass\n"
    good = "def f(c):\n    try:\n        c.execute('SELECT 1')\n    except Exception as e:\n        print(e)\n"
    assert _silent_db_handlers(bad)[0] == [4]
    assert _silent_db_handlers(good)[0] == []


def test_no_production_module_swallows_a_database_error_silently():
    offenders, broad_seen = [], 0
    for f in sorted(SERVER.glob('*.py')):
        if f.name.startswith('test_') or f.name in EXEMPT_FILES:
            continue
        hits, broad = _silent_db_handlers(f.read_text(encoding='utf-8-sig'))
        broad_seen += broad
        offenders += [f"{f.name}:{ln}" for ln in hits]
    assert broad_seen > 300, "scan looks vacuous: it found almost no broad handlers at all"
    assert offenders == [], (
        "silent broad `except` around a DB call (log to stderr with the exception, then degrade): "
        + ", ".join(offenders))
