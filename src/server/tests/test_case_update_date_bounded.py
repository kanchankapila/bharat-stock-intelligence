"""A `CASE WHEN date >= floor THEN new ELSE <col> END` update must bound its WHERE by the floor.

For every row older than the floor the SET is `col = col`, but Postgres still writes a new tuple:
`WHERE symbol = ?` alone rewrites a symbol's whole technical_signals history (~51 rows) to change
the one row at/after the floor. Measured 2026-09-11 on mc_pricefeed_fetcher's statement across
the live universe: 115,629 tuples / 216MB of WAL per run unbounded, 2,535 tuples / 6MB bounded,
identical resulting data -- and ~9 fetchers ran this shape nightly on a 362MB table.

Scope: statements whose every ELSE preserves the column. An `ELSE NULL` statement is excluded on
purpose -- bounding it WOULD change what it writes (see recurring-bugs.md's ELSE NULL entry).
"""
import glob
import os
import re

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STMT = re.compile(r'("""|\'\'\')(\s*UPDATE\s+technical_signals\s+SET.*?)\1', re.S | re.I)


def _preserves_every_column(sql):
    """True when each `col = CASE WHEN date >= ? ... ELSE <x> END` has x == col.

    Only the OUTER ELSE counts (followed by a comma or the end of the SET list) -- a nested
    `CASE ... ELSE 0 END` inside a THEN branch (index_membership's nifty_tier) is not the
    fallback. An ELSE that writes anything but the column itself (NULL, 0, another column) means
    bounding the WHERE would change what the statement writes, so it is out of scope.
    """
    targets = re.findall(r"^\s*(\w+)\s*=\s*CASE\s+WHEN", sql, re.I | re.M)
    outer = re.findall(r"ELSE\s+([\w.]+)\s+END\s*(?=,|\s*(?:FROM|WHERE)\b)", sql, re.I)
    strip = lambda name: name.split(".")[-1].lower()  # noqa: E731
    return bool(targets) and len(targets) == len(outer) and \
        all(strip(t) == strip(e) for t, e in zip(targets, outer))


def _offenders():
    found, scanned = [], 0
    for path in sorted(glob.glob(os.path.join(SERVER_DIR, "*.py"))):
        src = open(path, encoding="utf-8").read()
        for m in STMT.finditer(src):
            sql = m.group(2)
            whens = re.findall(r"CASE\s+WHEN\s+(?:technical_signals\.)?date\s*>=\s*\?", sql, re.I)
            if not whens or not _preserves_every_column(sql):
                continue
            scanned += 1
            where = re.split(r"\bWHERE\b", sql, flags=re.I)[-1]
            if not re.search(r"(?:technical_signals\.)?date\s*>=", where, re.I):
                found.append(f"{os.path.basename(path)}:{src[:m.start()].count(chr(10)) + 1}")
    return found, scanned


def test_floor_guarded_case_updates_bound_their_where_clause():
    found, scanned = _offenders()
    # 9 statements were in scope when this guard was written (2026-09-11).
    assert scanned >= 9, f"scan found only {scanned} -- the pattern or the file layout changed"
    assert found == []


def test_scope_excludes_statements_whose_else_writes_something_else():
    keep = "UPDATE technical_signals SET\n a = CASE WHEN date >= ? THEN ? ELSE a END,\n b = CASE WHEN date >= ? THEN ? ELSE b END\n WHERE symbol = ?"
    nested = ("UPDATE technical_signals SET\n t = CASE WHEN date >= ? THEN\n CASE WHEN x = 1 THEN 5 ELSE 0 END\n"
              " ELSE technical_signals.t END\n FROM nse_stocks ns WHERE technical_signals.symbol = ns.symbol")
    assert _preserves_every_column(keep)
    assert _preserves_every_column(nested)
    for other in ("NULL", "0", "b"):
        assert not _preserves_every_column(keep.replace("ELSE a END", f"ELSE {other} END"))
