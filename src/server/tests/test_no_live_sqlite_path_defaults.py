"""Guard: no module may declare a live SQLite file path.

SQLite was decommissioned 2026-08-19 (`use_postgres()` returns True unconditionally, there is
no `sqlite3.connect` left in `src/`). What survived the decommission was cosmetic but not
harmless: ten modules still carried `DB_PATH = os.getenv("DB_PATH", "database.sqlite")` or an
`os.path.join(..., 'database.sqlite')`, every one of them ignored at runtime because each
chatbot tool's `_connect(db_path)` discards its argument and returns `db_compat.connect()`.

That cost real time on 2026-09-10: a session auditing disk usage grepped for `database.sqlite`,
found five live files referencing it -- including the running chatbot service -- and correctly
stopped short of deleting the (genuinely dead) 3.3 GB file. The references were the lie, not the
file. Cleaned up under AF-20260910-14.

This test asserts the ASSIGNMENT form only, deliberately. CLAUDE.md's own decommission note warns
that a bare `grep -r "database.sqlite"` is not a valid check: it matches the explanatory comments
that describe the retired pattern (there are 9 such comments in `src/` right now, which is why
they are not a failure here) and, from the repo root, also descends into gitignored worktrees.
A constant being assigned a `.sqlite` path is the thing that misleads a reader into believing a
file is load-bearing, so that is what is banned.
"""

from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "server"

# NAME = <anything> "....sqlite..." -- an assignment whose value embeds a .sqlite/.db path
# literal. Comments and docstrings mentioning the retired pattern do not match.
ASSIGNMENT_RE = re.compile(
    r"""^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^#\n]*['"][^'"\n]*\.sqlite[^'"\n]*['"]""",
    re.MULTILINE,
)


def _python_files() -> list[Path]:
    return [
        p
        for p in SRC.rglob("*.py")
        if "node_modules" not in p.parts and "venv" not in p.parts
    ]


def test_no_module_assigns_a_sqlite_path_literal() -> None:
    offenders: list[str] = []
    for path in _python_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in ASSIGNMENT_RE.finditer(text):
            line_no = text.count("\n", 0, match.start()) + 1
            offenders.append(f"{path.relative_to(SRC.parent.parent)}:{line_no}: {match.group().strip()}")

    assert not offenders, (
        "SQLite is decommissioned; a module assigning a .sqlite path makes a dead file look "
        "load-bearing (AF-20260910-14). Use db_compat.connect() and drop the constant.\n  "
        + "\n  ".join(offenders)
    )


def test_the_guard_can_actually_fail() -> None:
    """Negative control.

    A regex guard that silently matches nothing passes forever and protects nothing -- the
    failure mode `recurring-bugs.md` records for hand-rolled static checks. Assert the pattern
    fires on the exact shape that was removed, and stays quiet on the comment form that is
    allowed to remain.
    """
    assert ASSIGNMENT_RE.search('DB_PATH = os.getenv("DB_PATH", "database.sqlite")')
    assert ASSIGNMENT_RE.search("DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')")
    assert not ASSIGNMENT_RE.search('# the old "database.sqlite" default was misleading')
    assert not ASSIGNMENT_RE.search('DB_PATH = os.getenv("DB_PATH", "<unused:postgres-only>")')
