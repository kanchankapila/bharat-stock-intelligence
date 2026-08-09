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

