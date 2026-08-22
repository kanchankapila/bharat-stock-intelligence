"""Every throwaway-schema teardown must go through pg_test_support.drop_throwaway_schema().

Root cause (measured live 2026-08-21): a test body that opens a connection and never closes it
leaves it `idle in transaction`, holding AccessShareLocks on that schema's tables.
`DROP SCHEMA ... CASCADE` needs AccessExclusiveLock, so it waits behind them:

    pid 10545  active               DROP SCHEMA IF EXISTS "t_f068e24d96c3" CASCADE   (waiting)
    pid 10546  idle in transaction  SELECT vwap FROM intraday_ohlcv ...              (blocker)

Observed at 5-10 MINUTES per test, which is why the Python suite looked like it was stalling
under "memory pressure" while free RAM was 5.4/23 GB. Three files plus both shared conftest
fixtures had a raw DROP; after routing them through the helper, the three worst files went from
wedging past a 10-minute timeout to 60 tests in 18.9s.

Note `db_compat.dispose_engines()` alone is NOT sufficient and this guard deliberately does not
accept it as a substitute: SQLAlchemy's Engine.dispose() replaces the pool but does not close
connections that are still CHECKED OUT, which is precisely the leaked-connection case.

The file list is derived by SCANNING the tree, not hand-enumerated, so a new fixture with this
shape fails here instead of silently re-adding minutes-per-test (see recurring-bugs.md: "a guard
test built on a hand-enumerated allowlist only guards what someone remembered to list").
"""
import io
import os
import tokenize

TESTS_DIR = os.path.dirname(__file__)
SERVER_DIR = os.path.join(TESTS_DIR, "..")
SCAN_DIRS = [TESTS_DIR, os.path.join(SERVER_DIR, "__tests__"), SERVER_DIR]

# Files that legitimately contain the raw statement. Kept tiny and individually justified rather
# than used as a general escape -- adding a name here without a reason re-opens the bug.
EXEMPT = {
    "pg_test_support.py",          # implements the helper
    os.path.basename(__file__),    # this guard's own docstring quotes the statement
    # Creates AND drops `leaked_test_schema` on ONE connection, inside the test body, to
    # reproduce the densify duplicate-column bug. A backend cannot block itself, so the
    # lock-eviction the helper provides is structurally unnecessary here -- and the helper
    # takes a psycopg2 connection while this test holds a ConnWrapper.
    "test_densify_feature_matrix.py",
}


def _scan(src):
    """(has_raw_drop, uses_helper) from TOKENS, not raw text.

    Tokenized deliberately. Two earlier regex versions were wrong in opposite directions and each
    looked correct until negative-controlled: a bare `DROP SCHEMA` pattern also matched the
    explanatory COMMENTS this fix added (failing already-correct files), and a
    `dispose_engines\\(\\)` pattern also matched the words inside that same comment (so deleting
    the real call still PASSED). SQL lives in STRING tokens and calls are NAME tokens, so
    tokenizing separates code from prose exactly.
    """
    has_raw_drop = uses_helper = False
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return False, False
    for i, t in enumerate(toks):
        if t.type == tokenize.STRING and "DROP SCHEMA" in t.string:
            has_raw_drop = True
        if (t.type == tokenize.NAME and t.string == "drop_throwaway_schema"
                and i + 1 < len(toks) and toks[i + 1].string == "("):
            uses_helper = True
    return has_raw_drop, uses_helper


def _creates_throwaway_schema(src):
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(src).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return False
    return any(t.type == tokenize.STRING and "CREATE SCHEMA" in t.string for t in toks)


def _candidate_files():
    out = []
    seen = set()
    for d in SCAN_DIRS:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".py") or name in EXEMPT or name in seen:
                continue
            path = os.path.join(d, name)
            if not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8") as fh:
                src = fh.read()
            if _creates_throwaway_schema(src):
                seen.add(name)
                out.append((path, src))
    return out


def test_scan_finds_the_files_it_is_meant_to_guard():
    """Control: an empty scan would make the assertion below vacuously true."""
    found = _candidate_files()
    assert len(found) >= 3, (
        f"scan found only {len(found)} schema-creating fixtures -- the guard below is vacuous"
    )


def test_no_fixture_drops_a_throwaway_schema_with_a_raw_statement():
    offenders = []
    for path, src in _candidate_files():
        has_raw_drop, _uses_helper = _scan(src)
        # Deliberately NOT "has a raw drop AND never uses the helper": conftest.py has two
        # schema fixtures, and a file-level check let a raw DROP in one hide behind the other
        # one's correct helper call. Caught by negative-controlling this guard against conftest.
        # Post-refactor no non-exempt file needs the raw statement at all, so flag it outright.
        if has_raw_drop:
            offenders.append(
                f"{os.path.basename(path)}: drops a throwaway schema with a raw DROP SCHEMA "
                "statement -- route it through pg_test_support.drop_throwaway_schema(), which "
                "evicts leaked lock-holders first, or the DROP blocks for minutes"
            )
    assert not offenders, "throwaway-schema teardown bug:\n  " + "\n  ".join(offenders)


def test_dispose_engines_actually_empties_the_cache():
    import sys
    sys.path.insert(0, SERVER_DIR)
    import db_compat

    fake = _FakeEngine()
    db_compat._engines["sqlite://__guard__"] = fake
    db_compat.dispose_engines()
    assert fake.disposed, "dispose_engines() did not call dispose() on a cached engine"
    assert db_compat._engines == {}, "dispose_engines() left the cache populated"


class _FakeEngine:
    def __init__(self):
        self.disposed = False

    def dispose(self):
        self.disposed = True
