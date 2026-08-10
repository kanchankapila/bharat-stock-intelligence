"""Regression tests for check_recurring_bugs.py's three heuristics -- built against
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
