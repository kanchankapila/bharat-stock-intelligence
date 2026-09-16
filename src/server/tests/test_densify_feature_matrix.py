"""Regression test for the information_schema.columns schema-leak bug fixed 2026-08-18.

Live-caught: `densify-feature-matrix` (part of ml-daily-ops) crashed for 3 days with
`TypeError: arg must be a list, tuple, 1-d array, or Series` inside `pd.to_numeric()`.
Root cause: `sparse_columns()` queried `information_schema.columns WHERE table_name=...`
with no `table_schema` filter. Two leaked throwaway test schemas (`pytest_*`/`vitest_*`,
left behind by an interrupted run instead of being dropped on teardown) each also
contained a `technical_signals` table, so the query returned every column name three
times over. The resulting `cols` list fed a `pd.DataFrame(..., columns=[...])` with
duplicate labels, and `df[c]` for a duplicate label returns a DataFrame instead of a
Series -- which `pd.to_numeric()` rejects.
"""
import pandas as pd
import pytest

import densify_feature_matrix as densify


def test_sparse_columns_ignores_same_named_table_in_another_schema(pg_conn):
    conn = pg_conn
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date DATE, some_score DOUBLE PRECISION
        )
    """)
    # Sparse on purpose: 1 of 2 rows populated on the probe date, well under the 50% floor...
    # make it clearly sparse (0 of 2 populated) so the test doesn't depend on the exact threshold.
    conn.execute("INSERT INTO technical_signals VALUES ('AAA', '2026-08-14', NULL)")
    conn.execute("INSERT INTO technical_signals VALUES ('BBB', '2026-08-14', NULL)")
    conn.commit()

    # Simulate a leaked test schema that independently defines the identical table/column
    # name -- the exact condition that broke densify-feature-matrix live.
    conn.execute("CREATE SCHEMA IF NOT EXISTS leaked_test_schema")
    conn.execute("""
        CREATE TABLE leaked_test_schema.technical_signals (
            symbol TEXT, date DATE, some_score DOUBLE PRECISION
        )
    """)
    conn.commit()
    try:
        cols = densify.sparse_columns(conn, "2026-08-14")
        assert cols.count("some_score") == 1, (
            f"'some_score' should appear once, not once per schema: {cols}"
        )

        # The actual failure mode: duplicate-labeled columns break pd.to_numeric().
        df = pd.DataFrame([("AAA", "2026-08-14", None)], columns=["symbol", "date"] + cols)
        for c in cols:
            df[c] = pd.to_numeric(df[c], errors="coerce")  # must not raise
    finally:
        conn.execute("DROP SCHEMA IF EXISTS leaked_test_schema CASCADE")
        conn.commit()
