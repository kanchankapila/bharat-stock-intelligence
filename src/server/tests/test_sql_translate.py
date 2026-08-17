import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from sql_translate import (  # noqa: E402
    convert_placeholders,
    translate,
    build_params,
    date_now_text,
)


# ─── convert_placeholders ──────────────────────────────────────────────────────

def test_numbers_positional_placeholders():
    assert convert_placeholders("SELECT * FROM t WHERE a=? AND b=?") == \
        "SELECT * FROM t WHERE a=:p0 AND b=:p1"


def test_ignores_question_mark_in_string_literal():
    assert convert_placeholders("SELECT '?' AS q, a=? FROM t") == \
        "SELECT '?' AS q, a=:p0 FROM t"


def test_ignores_question_mark_in_double_quoted_identifier():
    assert convert_placeholders('SELECT "we?rd" FROM t WHERE a=?') == \
        'SELECT "we?rd" FROM t WHERE a=:p0'


def test_apostrophe_inside_line_comment_does_not_break_later_placeholders():
    """Regression: an apostrophe inside a `-- ...` comment (e.g. "table's") is not a
    string-literal delimiter, but the old scanner had no comment awareness and toggled
    in_single on it anyway -- corrupting every `?` after that line. Hit live in
    screener_signal_generator.py's load_high_performing_screeners() query."""
    sql = (
        "SELECT a\n"
        "-- bridges it without touching the table's stored values.\n"
        "FROM t WHERE a >= ? OR b IN (?, ?)"
    )
    out = convert_placeholders(sql)
    assert "?" not in out
    assert out.count(":p") == 3
    assert "a >= :p0 OR b IN (:p1, :p2)" in out


def test_apostrophe_inside_block_comment_does_not_break_later_placeholders():
    sql = "SELECT a /* the table's rows */ FROM t WHERE a = ?"
    assert convert_placeholders(sql) == "SELECT a /* the table's rows */ FROM t WHERE a = :p0"


def test_double_dash_inside_string_literal_is_not_treated_as_a_comment():
    assert convert_placeholders("SELECT '--' AS q, a=? FROM t") == \
        "SELECT '--' AS q, a=:p0 FROM t"


# ─── function mapping (Postgres path) ──────────────────────────────────────────

def _pg(sql):
    return translate(sql, use_pg=True)


def test_maps_datetime_now_and_modifiers():
    assert _pg("SELECT datetime('now')") == "SELECT now()"
    assert _pg("WHERE d < datetime('now', '-30 days')") == \
        "WHERE d < (now() + interval '-30 days')"


def test_maps_date_now():
    assert _pg("WHERE d = date('now')") == "WHERE d = current_date"


def test_maps_date_column_to_cast():
    assert _pg("WHERE date(cs.computed_at) = ?") == \
        "WHERE (cs.computed_at)::date = :p0"


class TestDdlTypeRewritesAreTypePositionOnly:
    """DATETIME/BLOB are rewritten only where a TYPE can appear, never as a column name.

    `intraday_ohlcv` has a column literally named `datetime`. A bare \bDATETIME\b rewrite
    turned `symbol TEXT, datetime TEXT` into `symbol TEXT, TIMESTAMP TEXT` -- the column
    silently renamed, so every later `SELECT symbol, datetime` raised KeyError on the row
    dict. Shipped and caught the same day (2026-08-17) by the live_datasource suite, which
    is the only place that fixture runs.

    Same class as the REAL -> DOUBLE PRECISION codemod SQLITE_DECOMMISSION_PLAN.md records
    as reverted: a token rewrite that never checks what position the token is in.
    """

    def test_a_column_named_datetime_is_not_rewritten(self):
        out = _pg("CREATE TABLE intraday_ohlcv (symbol TEXT, datetime TEXT, close REAL)")
        assert "datetime TEXT" in out
        assert "TIMESTAMP TEXT" not in out

    def test_datetime_in_type_position_still_becomes_timestamp(self):
        out = _pg("CREATE TABLE t (symbol TEXT, computed_at DATETIME DEFAULT CURRENT_TIMESTAMP)")
        assert "computed_at TIMESTAMP" in out

    def test_a_column_named_datetime_typed_datetime_gets_both_right(self):
        out = _pg("CREATE TABLE t (datetime DATETIME)")
        assert "(datetime TIMESTAMP)" in out

    def test_blob_follows_the_same_rule_in_both_positions(self):
        out = _pg("CREATE TABLE t (payload BLOB, blob TEXT)")
        assert "payload BYTEA" in out
        assert "blob TEXT" in out


def test_maps_two_arg_date_and_datetime_over_a_column_or_literal():
    """The 'now' forms were mapped; every other two-argument form was not.

    `date(d, '-30 days')` fell through to the SINGLE-argument rule, which swallowed the whole
    argument list and produced `(d,'-30 days')::date` -- a row-expression cast that is not a
    translation-time error and reads as plausible SQL. The all-literal form was left completely
    untranslated and reached the server as `function date(unknown, unknown) does not exist`.
    Negative control: all four of these fail against the pre-fix module.
    """
    assert _pg("SELECT date(d, '-30 days') FROM t") == \
        "SELECT (((d)::date + interval '-30 days')::date) FROM t"
    assert _pg("SELECT date('2026-01-01', '-30 days')") == \
        "SELECT ((('2026-01-01')::date + interval '-30 days')::date)"
    assert _pg("SELECT datetime(ts, '+1 day') FROM t") == \
        "SELECT ((ts)::timestamp + interval '+1 day') FROM t"
    # the pre-existing forms must be unchanged by the new rules
    assert _pg("SELECT date('now', '-30 days')") == \
        "SELECT ((current_date + interval '-30 days')::date)"
    assert _pg("SELECT datetime('now', '-1 hour')") == "SELECT (now() + interval '-1 hour')"
    assert _pg("SELECT date(cs.computed_at) FROM t") == "SELECT (cs.computed_at)::date FROM t"


def test_insert_or_ignore_appends_on_conflict_exactly_once():
    """`;?\\s*$` matches twice on SQL with trailing whitespace -- once consuming it, then again
    as an empty match at end-of-string -- so a multi-line INSERT OR IGNORE (i.e. any written as
    a triple-quoted string) got `ON CONFLICT DO NOTHING ON CONFLICT DO NOTHING` and Postgres
    rejected it with `syntax error at or near "ON"`. Fails against the pre-fix module."""
    # A REAL trailing newline + indentation is the trigger; a single-line string never was.
    # Written as a triple-quoted literal so the whitespace cannot be lost to escaping -- the
    # first version of this test used "\\n" (a literal backslash-n), had no trailing whitespace,
    # and therefore passed against the unfixed module.
    sql = """
        INSERT OR IGNORE INTO t (a) VALUES (?)
    """
    out = translate(sql, use_pg=True)
    assert out.count("ON CONFLICT DO NOTHING") == 1, out


def test_maps_julianday_difference():
    assert _pg("AVG(julianday('now') - julianday(date))") == \
        "AVG(current_date - (date)::date)"


def test_maps_ifnull_to_coalesce():
    assert _pg("SELECT IFNULL(a, 0) FROM t") == "SELECT COALESCE(a, 0) FROM t"


def test_maps_insert_or_ignore():
    assert _pg("INSERT OR IGNORE INTO t (a) VALUES (?)") == \
        "INSERT INTO t (a) VALUES (:p0) ON CONFLICT DO NOTHING"


def test_maps_json_extract_single_and_nested():
    assert _pg("SELECT json_extract(meta, '$.k') FROM t") == \
        "SELECT (meta::jsonb ->> 'k') FROM t"
    assert _pg("SELECT json_extract(meta, '$.a.b') FROM t") == \
        "SELECT (meta::jsonb #>> '{a,b}') FROM t"


def test_casts_round_two_arg_to_numeric_paren_aware():
    assert _pg("SELECT ROUND(AVG(score), 1) FROM t") == \
        "SELECT round((AVG(score))::numeric, 1) FROM t"
    assert _pg("SELECT ROUND(COALESCE(x, 0) + 0.2, 3) FROM t") == \
        "SELECT round((COALESCE(x, 0) + 0.2)::numeric, 3) FROM t"
    assert _pg("SELECT ROUND(x) FROM t") == "SELECT ROUND(x) FROM t"


def test_maps_cast_real_and_group_concat():
    assert _pg("SELECT CAST(x AS REAL) FROM t") == \
        "SELECT CAST(x AS double precision) FROM t"
    assert _pg("SELECT GROUP_CONCAT(sym) FROM t") == \
        "SELECT string_agg(sym::text, ',') FROM t"


# ─── INSERT OR REPLACE: rejected loudly, not silently passed through ───────────

def test_insert_or_replace_raises_instead_of_reaching_postgres():
    with pytest.raises(ValueError, match="INSERT OR REPLACE"):
        _pg("INSERT OR REPLACE INTO t (a) VALUES (?)")


def test_insert_or_replace_is_untouched_on_the_sqlite_path():
    # Several fetchers (earnings_surprise_fetcher.py, insider_transactions_fetcher.py,
    # mc_global_macro_fetcher.py, moneycontrol_fetcher.py, stock_option_chain_fetcher.py)
    # correctly dialect-branch and only ever reach INSERT OR REPLACE with use_pg=False,
    # where it is valid SQLite and must keep working exactly as before this change.
    assert translate("INSERT OR REPLACE INTO t (a) VALUES (?)", use_pg=False) == \
        "INSERT OR REPLACE INTO t (a) VALUES (:p0)"


def test_insert_or_ignore_is_unaffected_by_the_guard():
    # only OR REPLACE is rejected; OR IGNORE has a real translation and must still work
    assert _pg("INSERT OR IGNORE INTO t (a) VALUES (?)") == \
        "INSERT INTO t (a) VALUES (:p0) ON CONFLICT DO NOTHING"


# ─── memoization: pure cache, no behavior change ────────────────────────────────

def test_translate_is_memoized_and_still_correct():
    sql = "SELECT * FROM t WHERE d = date('now') AND a = ?"
    first = _pg(sql)
    second = _pg(sql)
    assert second == first == "SELECT * FROM t WHERE d = current_date AND a = :p0"


def test_translate_cache_does_not_cross_contaminate():
    assert _pg("SELECT a FROM t WHERE x = ?") == "SELECT a FROM t WHERE x = :p0"
    assert _pg("SELECT b FROM t WHERE y = ?") == "SELECT b FROM t WHERE y = :p0"
    assert _pg("SELECT a FROM t WHERE x = ?") == "SELECT a FROM t WHERE x = :p0"


def test_translate_cache_is_keyed_on_use_pg_too():
    # same SQL string, different dialect flag, must not share a cache entry
    sql = "SELECT IFNULL(a, 0) FROM t"
    assert translate(sql, use_pg=True) == "SELECT COALESCE(a, 0) FROM t"
    assert translate(sql, use_pg=False) == "SELECT IFNULL(a, 0) FROM t"


# ─── date_now_text(): the explicit opt-in for TEXT date columns ────────────────

def test_date_now_text_no_modifier():
    assert date_now_text() == "current_date::text"


def test_date_now_text_with_modifier():
    assert date_now_text("-3 days") == "((current_date + interval '-3 days')::date)::text"


# ─── SQLite path is a function-mapping no-op (placeholders still convert) ───────

def test_sqlite_path_leaves_functions_unchanged():
    sql = "SELECT IFNULL(a, 0), datetime('now', '-1 day') FROM t WHERE b = ?"
    assert translate(sql, use_pg=False) == \
        "SELECT IFNULL(a, 0), datetime('now', '-1 day') FROM t WHERE b = :p0"


# ─── build_params ──────────────────────────────────────────────────────────────

def test_build_params_positional_to_named():
    assert build_params(("AAA", 5)) == {"p0": "AAA", "p1": 5}
    assert build_params([1, 2, 3]) == {"p0": 1, "p1": 2, "p2": 3}


def test_build_params_dict_passthrough_and_empty():
    assert build_params({"x": 1}) == {"x": 1}
    assert build_params(()) == {}
    assert build_params(None) == {}


def test_build_params_numpy_conversion():
    import numpy as np
    assert build_params({"a": np.float64(19.6)}) == {"a": 19.6}
    assert build_params([np.int64(42)]) == {"p0": 42}
    assert build_params(({"x": np.int32(1)},)) == {"p0": {"x": np.int32(1)}}  # nested dict in tuple isn't deeply cleaned but lists/tuples are:
    assert build_params(([np.float64(1.5)],)) == {"p0": [1.5]}



# ─── Postgres-only guarantee (2026-08-15) ────────────────────────────────────
#
# Deliberately appended to this existing file rather than added as a NEW test file:
# adding any new file to src/server/tests/ deterministically trips a pre-existing
# order/state-dependent failure in test_unified_ranker.py
# (test_history_snapshot_is_append_only_across_reruns -- reproduced 2026-08-15 with a
# throwaway file containing nothing but five `assert True` statements, so it is unrelated
# to this content). That bug is real and unfixed; see docs/session-log.md. Homing these
# tests here pins the guarantee without changing that bug's status either way.

import os
import subprocess
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent.parent


def _resolve_in_clean_process(env_overrides: dict) -> str:
    """Ask a FRESH interpreter -- no pytest in sys.modules -- what dialect it resolves to.

    This is the whole point: the guarantee is about processes that are NOT the test suite.
    Asserting it from inside pytest would test the escape hatch, not the rule.
    """
    env = {k: v for k, v in os.environ.items() if k != "USE_POSTGRES"}
    env.update(env_overrides)
    out = subprocess.run(
        [sys.executable, "-c",
         "from sql_translate import use_postgres; print(use_postgres())"],
        cwd=str(SERVER_DIR), env=env, capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, f"probe failed: {out.stderr[:400]}"
    return out.stdout.strip()


def test_postgres_when_use_postgres_is_unset():
    """The exact incident shape: a script that never loaded .env. Previously SQLite."""
    assert _resolve_in_clean_process({}) == "True"


def test_postgres_even_when_use_postgres_is_explicitly_false():
    """.env must not be able to reroute a non-test process to another database."""
    assert _resolve_in_clean_process({"USE_POSTGRES": "false"}) == "True"


def test_postgres_when_use_postgres_is_garbage():
    """A typo'd value must not silently mean SQLite, which is what `== 'true'` did."""
    assert _resolve_in_clean_process({"USE_POSTGRES": "0"}) == "True"


def test_inside_pytest_sqlite_stays_the_default_fixture():
    """Inside the suite the historical rule still applies: SQLite unless USE_POSTGRES=true.

    This direction is load-bearing for SAFETY, not just compatibility. ~240 Python test files
    build a throwaway SQLite fixture and never set the variable; defaulting them to Postgres
    points the suite at the LIVE production database. Briefly tried 2026-08-15 -- suite went
    115s -> 600s+ (it wrote nothing, confirmed, but that is not a thing to rely on twice).
    """
    probe = (
        "import pytest;"  # puts 'pytest' in sys.modules, simulating a test process
        "from sql_translate import use_postgres; print(use_postgres())"
    )
    env = {k: v for k, v in os.environ.items() if k != "USE_POSTGRES"}
    out = subprocess.run([sys.executable, "-c", probe], cwd=str(SERVER_DIR), env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[:400]
    assert out.stdout.strip() == "False", "a test process must default to the SQLite fixture"

    env["USE_POSTGRES"] = "true"
    out2 = subprocess.run([sys.executable, "-c", probe], cwd=str(SERVER_DIR), env=env,
                          capture_output=True, text=True, timeout=120)
    assert out2.stdout.strip() == "True", "a test must still be able to opt INTO Postgres"


def test_the_two_decision_points_agree_where_they_still_can():
    """pgConfig.ts and sql_translate.py agree for every REAL process: Postgres, no env var.

    They deliberately differ in ONE place, and this test pins that difference rather than
    pretending it away. TypeScript went fully Postgres-only on 2026-08-16 (vitest's `unit` project
    runs inside a throwaway schema built from db/schema.postgres.sql -- see
    vitest.globalSetup.ts); Python still honours USE_POSTGRES inside pytest, because ~100 pytest
    files build their own sqlite3 fixtures and flipping them together would aim the Python suite
    at live production, which a 2026-08-15 attempt actually did.

    Why TS could not keep the pytest-shaped rule: every `*.live.test.ts` calls
    `await import('dotenv/config')`, `.env` sets USE_POSTGRES=true, and vitest's
    `singleFork: true` shares one process.env -- so the first live file to load dotenv flipped
    every later test file onto production. That wrote 2,148 fabricated Saturday stock_ohlcv bars
    to production on 2026-08-16. pytest has no equivalent shared-mutation path today, which is
    why the branch is survivable there and was not here.

    Converting the pytest fixtures is the remaining half of SQLITE_DECOMMISSION_PLAN Phase 2.
    When it lands this test fails, which is the point -- whoever removes the branch is forced
    back here to re-assert real parity instead of leaving a stale claim behind.
    """
    ts = (SERVER_DIR / "pgConfig.ts").read_text(encoding="utf-8")
    ts_body = ts.split("export function usePostgres")[1][:400]
    assert "return true;" in ts_body
    assert "USE_POSTGRES" not in ts_body, (
        "pgConfig.ts's usePostgres() reads an env var again -- that is the exact shape that let "
        "dotenv/config in a live test reroute the whole suite to production"
    )

    py = (SERVER_DIR / "sql_translate.py").read_text(encoding="utf-8")
    assert "if _in_pytest():" in py, (
        "the Python pytest branch is gone -- Phase 2 is complete on both sides, so update this "
        "test to assert genuine parity (neither side reads USE_POSTGRES at all)"
    )


# ─── generated_at uniqueness (2026-08-15) ────────────────────────────────────
#
# Homed here for the same reason as the Postgres-only block above: adding a NEW file under
# src/server/tests/ perturbs suite timing, and timing is exactly what this bug is about.

def test_generated_at_is_strictly_increasing_under_a_coarse_clock():
    """Two runs in quick succession must never share a generated_at.

    unified_recommendations_history is PK (symbol, generated_at) with ON CONFLICT DO NOTHING,
    so a shared timestamp silently discards an entire run's snapshot. datetime.now()'s
    resolution is the system clock tick -- measured 0.015625 s on Windows, where 2000
    back-to-back calls return ONE distinct value -- and unified_ranker.run() finishes well
    inside that on a small universe.
    """
    import sys as _sys
    from pathlib import Path as _Path
    _sys.path.insert(0, str(_Path(__file__).resolve().parent.parent))
    import unified_ranker

    unified_ranker._last_generated_at = None            # fresh process state
    stamps = [unified_ranker._next_generated_at() for _ in range(50)]

    assert len(set(stamps)) == 50, (
        f"expected 50 distinct generated_at, got {len(set(stamps))} -- "
        "a shared timestamp silently drops a snapshot via ON CONFLICT DO NOTHING"
    )
    assert stamps == sorted(stamps), "generated_at must be monotonically increasing"


def test_generated_at_stays_real_wall_clock_time():
    """The collision bump must not drift generated_at away from real UTC -- the column is used
    to prove a run happened pre-market, so it has to stay a true wall-clock timestamp, not a
    counter that has wandered off."""
    import sys as _sys
    from datetime import datetime, timedelta, timezone
    from pathlib import Path as _Path
    _sys.path.insert(0, str(_Path(__file__).resolve().parent.parent))
    import unified_ranker

    unified_ranker._last_generated_at = None
    before = datetime.now(timezone.utc)
    stamps = [unified_ranker._next_generated_at() for _ in range(50)]
    after = datetime.now(timezone.utc)

    assert stamps[0] >= before, "first stamp precedes the call that produced it"
    # 50 collisions bump by at most 50 microseconds beyond the real clock reading.
    assert stamps[-1] <= after + timedelta(microseconds=50), (
        "generated_at drifted past real time by more than the collision bump can explain"
    )


# ─── pg_schema fixture isolation (2026-08-15) ────────────────────────────────
#
# Homed here rather than in a new file for the reason documented above. These guard the ONE
# property that makes Phase 2 of docs/SQLITE_DECOMMISSION_PLAN.md safe: a Postgres-backed test
# must be unable to touch a production table. Measured 2026-08-15, a Postgres-by-default change
# briefly aimed ~100 fixture-building test files at the live database; nothing was written, but
# only by luck. If these tests ever fail, STOP converting tests to Postgres.

def test_pg_schema_shadows_production_tables_not_writes_to_them(pg_schema):
    """An unqualified CREATE/INSERT must land in the throwaway schema, never in public."""
    conn, schema = pg_schema
    cur = conn.cursor()

    # unified_recommendations is a REAL production table. Creating it unqualified here must
    # shadow it inside the throwaway schema, not touch the live one.
    cur.execute("CREATE TABLE unified_recommendations (symbol TEXT, unified_score DOUBLE PRECISION)")
    cur.execute("INSERT INTO unified_recommendations VALUES ('ZZTESTSYM', 1.0)")

    cur.execute("SELECT count(*) FROM unified_recommendations")
    assert cur.fetchone()[0] == 1, "write did not land in the throwaway schema"

    # The production table must be untouched by that write. Resolve it first: it exists on a
    # developer instance (which IS production) but not on CI's empty service container, where a
    # bare SELECT is UndefinedTable rather than a clean 0 -- and this assertion matters most
    # exactly where the suite runs unattended.
    cur.execute("SELECT to_regclass('public.unified_recommendations')")
    if cur.fetchone()[0] is not None:
        cur.execute("SELECT count(*) FROM public.unified_recommendations WHERE symbol = 'ZZTESTSYM'")
        assert cur.fetchone()[0] == 0, (
            "TEST WROTE INTO PRODUCTION — the search_path isolation is broken; do not convert "
            "any further tests to Postgres until this passes"
        )

    cur.execute("SELECT to_regclass(%s)", (f"{schema}.unified_recommendations",))
    assert cur.fetchone()[0] is not None, "table was not created in the throwaway schema"


def test_pg_schema_is_empty_and_unique_per_test(pg_schema):
    """Each test gets a fresh schema -- a leftover from a killed run must never be reused as if
    it were empty, which a name derived from the test name would allow."""
    conn, schema = pg_schema
    cur = conn.cursor()
    cur.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = %s", (schema,)
    )
    assert cur.fetchone()[0] == 0, "throwaway schema was not empty at test start"
    assert schema.startswith("t_") and len(schema) == 14


def test_pg_schema_drops_on_teardown(pg_schema):
    """Recorded so the teardown contract is explicit; the drop itself is asserted by the
    fixture's own finally block running DROP ... CASCADE."""
    conn, schema = pg_schema
    cur = conn.cursor()
    cur.execute("SELECT current_schemas(false)")
    assert schema in cur.fetchone()[0], "search_path is not pinned to the throwaway schema"
