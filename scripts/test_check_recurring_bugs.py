"""Regression tests for check_recurring_bugs.py's heuristics -- built against
synthetic fixtures (not the live repo) so they stay stable regardless of future edits
elsewhere in the codebase. Each check has both a positive case (must fire) and at least
one negative case drawn from a real false positive found while building this checker
against the actual repo -- documented inline so a future edit doesn't reintroduce it.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_recurring_bugs as crb  # noqa: E402


def _p(name: str = "some_fetcher.py") -> Path:
    return crb.REPO_ROOT / "src" / "server" / name


class TestDateAnchorGuard:
    def test_fires_on_the_real_bug_shape(self):
        text = (
            "def run(con):\n"
            "    today = date.today().isoformat()\n"
            "    con.execute(\n"
            "        \"UPDATE technical_signals SET x = CASE WHEN date >= ? THEN y ELSE NULL END\",\n"
            "        (today,),\n"
            "    )\n"
        )
        findings = crb.check_date_anchor(_p(), text)
        assert len(findings) == 1
        assert "ELSE NULL" in findings[0]

    def test_does_not_fire_on_a_plain_lookback_window(self):
        # A read-side "last 30 days" query is a different, lower-severity pattern -- not
        # the write-guard bug this check exists to catch.
        text = (
            "def load(conn):\n"
            "    cutoff = (date.today() - timedelta(days=30)).isoformat()\n"
            "    return conn.execute('SELECT * FROM technical_signals WHERE date >= ?', (cutoff,))\n"
        )
        assert crb.check_date_anchor(_p(), text) == []

    def test_does_not_fire_inside_a_comment(self):
        text = (
            "def run(con):\n"
            "    # fixed the date.today() anchor bug -- CASE WHEN date >= ? ELSE NULL was wrong\n"
            "    floor = logical_write_floor(con)\n"
            "    con.execute('UPDATE t SET x = CASE WHEN date >= ? THEN y ELSE NULL END', (floor,))\n"
        )
        assert crb.check_date_anchor(_p(), text) == []

    def test_does_not_fire_inside_a_docstring(self):
        text = (
            "def run(con):\n"
            "    \"\"\"Guard was date.today()-anchored; CASE WHEN date >= ? ELSE NULL nulled\n"
            "    history on any mismatched day.\"\"\"\n"
            "    floor = logical_write_floor(con)\n"
            "    con.execute('UPDATE t SET x = CASE WHEN date >= ? THEN y ELSE NULL END', (floor,))\n"
        )
        assert crb.check_date_anchor(_p(), text) == []

    def test_does_not_fire_on_the_documented_fallback_escape_hatch(self):
        text = (
            "def run(cur):\n"
            "    floor = logical_write_floor(cur, fallback=date.today().isoformat())\n"
            "    cur.execute('UPDATE t SET x = CASE WHEN date >= ? THEN y ELSE NULL END', (floor,))\n"
        )
        assert crb.check_date_anchor(_p(), text) == []

    def test_allowlisted_files_are_skipped(self):
        text = "def f():\n    x = date.today()\n    # CASE WHEN date >= ? ELSE NULL\n"
        assert crb.check_date_anchor(_p("as_of.py"), text) == []

    def test_test_directory_files_are_skipped(self):
        text = (
            "def test_x():\n"
            "    today = date.today()\n"
            "    assert 'CASE WHEN date >= ? THEN y ELSE NULL' in sql\n"
        )
        assert crb.check_date_anchor(_p("tests/test_something.py"), text) == []


class TestRawPercentS:
    def test_fires_on_a_bare_placeholder(self):
        text = (
            "def run(conn):\n"
            "    conn.execute('UPDATE t SET x=%s WHERE symbol=%s', (val, sym))\n"
        )
        findings = crb.check_raw_percent_s(_p(), text)
        assert len(findings) == 1

    def test_does_not_fire_when_percent_is_python_string_formatting(self):
        # data_integrity_repair.py's real shape: %s resolved by Python's own % operator
        # before the string ever reaches execute() -- not a SQL placeholder bug.
        text = (
            "def run(conn):\n"
            "    conn.execute(\n"
            "        \"UPDATE t SET x=1 WHERE h IN (%s) AND y IS NULL\"\n"
            "        % \",\".join(str(h) for h in HORIZONS))\n"
        )
        assert crb.check_raw_percent_s(_p(), text) == []

    def test_does_not_fire_on_sql_like_wildcards_ending_in_s(self):
        # insider_transactions_fetcher.py's real shape: '%sale%'/'%sell%' are LIKE
        # wildcards, not placeholders -- the 's' right after '%' is coincidental.
        text = (
            "def run(cur):\n"
            "    cur.execute(\"SELECT * FROM t WHERE mode LIKE '%sale%' OR mode LIKE '%sell%'\")\n"
        )
        assert crb.check_raw_percent_s(_p(), text) == []

    def test_does_not_fire_on_an_unrelated_nearby_log_statement(self):
        # early_hours_predictor.py's real shape: a log.info("...%s...", x) call a few
        # lines after an unrelated, %s-free execute() call.
        text = (
            "def run(cur):\n"
            "    cur.execute(translate('SELECT MAX(d) FROM t'))\n"
            "    target = cur.fetchone()[0]\n"
            "    if not target:\n"
            "        target = date.today().isoformat()\n"
            "    log.info('Running for date: %s', target)\n"
        )
        assert crb.check_raw_percent_s(_p(), text) == []

    def test_test_directory_files_are_skipped(self):
        text = "conn.execute('UPDATE t SET x=%s', (v,))\n"
        assert crb.check_raw_percent_s(_p("tests/test_something.py"), text) == []


class TestRawPercentSFalsePositives:
    def test_triple_quoted_query_with_python_interpolation_is_not_flagged(self):
        """feature_coverage_gate.py:64 -- the `%` is a Python string operator applied to the
        closing triple quote, so the `%s` is already resolved before execute() sees it. The
        line-start-only guard missed this shape and reported it as a placeholder bug."""
        text = (
            "def full_row_count_date(conn, lookback_days=14):\n"
            "    rows = conn.execute(\n"
            "        \"\"\"\n"
            "        SELECT date::text, COUNT(*) AS n\n"
            "        FROM technical_signals\n"
            "        WHERE date::text >= (CURRENT_DATE - %s)::text\n"
            "        \"\"\" % int(lookback_days)\n"
            "    ).fetchall()\n"
        )
        assert crb.check_raw_percent_s(_p(), text) == []

    def test_the_real_placeholder_bug_still_fires(self):
        """Negative control for the fix above: without a `%` operator the same query IS the
        documented bug, and must still be reported."""
        text = (
            "def run(conn, sym):\n"
            "    rows = conn.execute(\n"
            "        \"\"\"\n"
            "        SELECT n FROM technical_signals WHERE symbol = %s\n"
            "        \"\"\",\n"
            "        (sym,),\n"
            "    ).fetchall()\n"
        )
        assert len(crb.check_raw_percent_s(_p(), text)) == 1


class TestNanSelfInequality:
    def test_fires_on_a_nan_test_inside_sql(self):
        text = (
            "def purge(con):\n"
            "    con.execute(\n"
            "        \"DELETE FROM unified_recommendations WHERE unified_score != unified_score\"\n"
            "    )\n"
        )
        findings = crb.check_nan_self_inequality(_p(), text)
        assert len(findings) == 1
        assert "NaN = NaN as TRUE" in findings[0]

    def test_fires_across_a_multiline_query(self):
        text = (
            "QUERY = (\n"
            "    \"SELECT symbol, score\\n\"\n"
            "    \"FROM stock_scores\\n\"\n"
            "    \"WHERE 1=1\\n\"\n"
            "    \"  AND score <> score\\n\"\n"
            ")\n"
        )
        assert len(crb.check_nan_self_inequality(_p(), text)) == 1

    def test_plain_python_nan_check_is_not_flagged(self):
        """~10 fetchers here use `f != f` as a Python-level NaN test, which is correct --
        the bug is only the SQL form. Flagging these would make the check unusable."""
        text = "def _num(f):\n    return None if f != f else f\n"
        assert crb.check_nan_self_inequality(_p(), text) == []

    def test_prose_describing_the_bug_is_not_the_bug(self):
        """The only repo-wide matches for this pattern today are comments and a docstring
        warning against it (data_integrity_repair.py, test_nan_recommendation_purge.py)."""
        comment = "    # NaN detection: `x != x` is FALSE for NaN in a Postgres WHERE clause.\n"
        docstring = '"""Pins why we do not use `x != x` in a SELECT here."""\n'
        assert crb.check_nan_self_inequality(_p(), comment) == []
        assert crb.check_nan_self_inequality(_p(), docstring) == []

    def test_different_operands_are_not_flagged(self):
        text = "    con.execute(\"SELECT * FROM t WHERE a != b\")\n"
        assert crb.check_nan_self_inequality(_p(), text) == []


class TestMultiwordPgCast:
    def test_fires_on_double_precision(self):
        text = "    con.execute(\"SELECT score::double precision FROM stock_scores\")\n"
        findings = crb.check_multiword_pg_cast(_p(), text)
        assert len(findings) == 1
        assert "::float8" in findings[0]

    def test_fires_on_timestamptz_spelling(self):
        text = "    q = \"SELECT computed_at::timestamp with time zone FROM t\"\n"
        findings = crb.check_multiword_pg_cast(_p(), text)
        assert len(findings) == 1
        assert "::timestamptz" in findings[0]

    def test_single_token_casts_are_fine(self):
        text = "    q = \"SELECT score::float8, computed_at::timestamptz, s::varchar FROM t\"\n"
        assert crb.check_multiword_pg_cast(_p(), text) == []

    def test_prose_warning_against_the_cast_is_not_flagged(self):
        """risk.router.ts:42 is a comment recommending ::float8 *over* the two-word form --
        the sole repo-wide match when this check was written, and a false positive if the
        comment/docstring skip regresses."""
        text = "# `::float8` (not the two-word `::double precision`, which stripPgCasts misses)\n"
        assert crb.check_multiword_pg_cast(_p(), text) == []


class TestMissingLiveDatasourceTest:
    # The mandate applies to fetchers that actually call an external endpoint, so every
    # fixture here must carry an HTTP client import — without one the file is a derived-feature
    # engine and is correctly exempt (see test_a_fetcher_with_no_http_client_is_exempt).
    FETCHER_SRC = "import requests\n\ndef run(): pass\n"

    def test_flags_a_fetcher_with_no_matching_test(self, tmp_path, monkeypatch):
        server_dir = tmp_path / "src" / "server"
        (server_dir / "tests").mkdir(parents=True)
        fetcher = server_dir / "brand_new_fetcher.py"
        fetcher.write_text(self.FETCHER_SRC)
        monkeypatch.setattr(crb, "SERVER_DIR", server_dir)
        findings = crb.check_missing_live_datasource_test([fetcher])
        assert len(findings) == 1
        assert "brand_new_fetcher.py" in findings[0]

    def test_does_not_flag_a_fetcher_with_a_matching_test(self, tmp_path, monkeypatch):
        server_dir = tmp_path / "src" / "server"
        (server_dir / "tests").mkdir(parents=True)
        fetcher = server_dir / "covered_fetcher.py"
        fetcher.write_text(self.FETCHER_SRC)
        (server_dir / "tests" / "test_live_datasource_covered.py").write_text("def test_x(): pass\n")
        monkeypatch.setattr(crb, "SERVER_DIR", server_dir)
        assert crb.check_missing_live_datasource_test([fetcher]) == []

    def test_a_fetcher_with_no_http_client_is_exempt(self, tmp_path, monkeypatch):
        """screener_features_fetcher.py reads screener_appearances out of the DB and computes
        features — it is a derived-feature engine with a misleading filename, not a data
        source, so the live_datasource mandate does not apply. Checking for the client import
        (rather than keeping an allowlist) means a genuine fetcher can't be exempted by rename."""
        server_dir = tmp_path / "src" / "server"
        (server_dir / "tests").mkdir(parents=True)
        fetcher = server_dir / "derived_features_fetcher.py"
        fetcher.write_text("from db_compat import connect\n\ndef run(): pass\n")
        monkeypatch.setattr(crb, "SERVER_DIR", server_dir)
        assert crb.check_missing_live_datasource_test([fetcher]) == []

    def test_non_fetcher_files_are_ignored(self, tmp_path, monkeypatch):
        server_dir = tmp_path / "src" / "server"
        (server_dir / "tests").mkdir(parents=True)
        other = server_dir / "some_helper.py"
        other.write_text("def run(): pass\n")
        monkeypatch.setattr(crb, "SERVER_DIR", server_dir)
        assert crb.check_missing_live_datasource_test([other]) == []

    def test_test_directory_fetcher_named_files_are_not_treated_as_fetchers(self, tmp_path, monkeypatch):
        server_dir = tmp_path / "src" / "server"
        (server_dir / "tests").mkdir(parents=True)
        test_file = server_dir / "tests" / "test_some_fetcher.py"
        test_file.write_text("def test_x(): pass\n")
        monkeypatch.setattr(crb, "SERVER_DIR", server_dir)
        assert crb.check_missing_live_datasource_test([test_file]) == []
