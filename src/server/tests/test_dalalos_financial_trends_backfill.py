"""
Tests parse_financial_trends() and write_financial_trends_rows() in
dalalos_financial_trends_backfill.py against real Postgres (pg_conn: empty schema, DDL
applied here to mirror migrations/20260831143000_dalalos-financial-trends-history.sql).

This is NOT a live_datasource test -- there is no HTTP endpoint for this module to hit
(DalalOS is MCP-only, see the module's own docstring), so the mandatory-live-test rule in
data-sources.md doesn't apply the usual way. What IS tested here is the part that can
regress silently: a canned, DalalOS-shaped sample dict parses into the right row shape and
survives a real Postgres upsert (including the ON CONFLICT re-run path), which is exactly
what the actual seed-file backfill exercises live.

Negative control (run by hand 2026-08-31): reverting parse_financial_trends() to read
`entry["nse_symbol"]` without `.strip().upper()` and re-running test_parse_lowercases_and_
trims_symbol confirms it fails against the un-normalized input -- the assertion is not
vacuous.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from conftest import pg_available  # noqa: E402
from dalalos_financial_trends_backfill import (  # noqa: E402
    parse_financial_trends,
    write_financial_trends_rows,
)

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")

SAMPLE_ENTRY = {
    "nse_symbol": "  reliance  ",  # deliberately lowercase + padded, to exercise normalization
    "isin": "INE002A01018",
    "statement_type": "consolidated",
    "revenue_cagr": 0.1084,
    "net_income_cagr": 0.0577,
    "periods": [
        {
            "period_end": "2026-06-30", "fiscal_label": "Q1 FY27",
            "revenue": 3118500000000.0, "revenue_basis": "revenue_from_operations",
            "net_income": 231960000000.0, "eps": 15.48, "ebitda_margin": 0.1734,
            "net_margin": 0.0744, "net_margin_delta": 0.0055,
            "qoq_revenue_growth": 0.0443, "qoq_net_income_growth": 0.1266,
            "yoy_revenue_growth": 0.2541, "source": "bse-xbrl",
        },
        {
            "period_end": "2026-03-31", "fiscal_label": "Q4 FY26",
            "revenue": 2986210000000.0, "revenue_basis": "revenue_from_operations",
            "net_income": 205890000000.0, "eps": 12.54, "ebitda_margin": 0.1627,
            "net_margin": 0.0689, "net_margin_delta": -0.0138,
            "qoq_revenue_growth": 0.1081, "qoq_net_income_growth": -0.0763,
            "yoy_revenue_growth": 0.1287, "source": "bse-xbrl",
        },
    ],
}


@pytest.fixture
def dalalos_table(pg_conn):
    pg_conn.execute("""
        CREATE TABLE dalalos_financial_trends_history (
          symbol TEXT NOT NULL, period_end DATE NOT NULL, period_type TEXT NOT NULL DEFAULT 'quarterly',
          fiscal_label TEXT, isin TEXT, statement_type TEXT, revenue NUMERIC, revenue_basis TEXT,
          net_income NUMERIC, eps NUMERIC, ebitda_margin NUMERIC, net_margin NUMERIC,
          net_margin_delta NUMERIC, qoq_revenue_growth NUMERIC, qoq_net_income_growth NUMERIC,
          yoy_revenue_growth NUMERIC, revenue_cagr NUMERIC, net_income_cagr NUMERIC,
          source TEXT NOT NULL DEFAULT 'dalalos-mcp', fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (symbol, period_end, period_type)
        )
    """)
    pg_conn.commit()
    return pg_conn


def test_parse_lowercases_and_trims_symbol():
    rows = parse_financial_trends(SAMPLE_ENTRY)
    assert len(rows) == 2
    assert all(r["symbol"] == "RELIANCE" for r in rows)


def test_parse_carries_company_level_fields_onto_every_row():
    rows = parse_financial_trends(SAMPLE_ENTRY)
    for r in rows:
        assert r["isin"] == "INE002A01018"
        assert r["revenue_cagr"] == pytest.approx(0.1084)
        assert r["net_income_cagr"] == pytest.approx(0.0577)


def test_parse_skips_periods_with_no_period_end():
    entry = {**SAMPLE_ENTRY, "periods": [{"fiscal_label": "no date"}] + SAMPLE_ENTRY["periods"]}
    rows = parse_financial_trends(entry)
    assert len(rows) == 2  # the dateless period is dropped, not written as garbage


def test_parse_empty_symbol_returns_nothing():
    assert parse_financial_trends({**SAMPLE_ENTRY, "nse_symbol": ""}) == []
    assert parse_financial_trends({**SAMPLE_ENTRY, "nse_symbol": None}) == []


def test_write_roundtrip_and_upsert_idempotent(dalalos_table):
    rows = parse_financial_trends(SAMPLE_ENTRY)
    n = write_financial_trends_rows(dalalos_table, rows)
    assert n == 2

    stored = dalalos_table.execute(
        "SELECT symbol, period_end, net_margin FROM dalalos_financial_trends_history "
        "WHERE symbol = 'RELIANCE' ORDER BY period_end"
    ).fetchall()
    assert len(stored) == 2
    # NUMERIC columns come back as decimal.Decimal from psycopg2 -- cast before comparing
    # against a float, or pytest.approx's subtraction raises TypeError (caught live here).
    assert float(stored[0][2]) == pytest.approx(0.0689)  # 2026-03-31
    assert float(stored[1][2]) == pytest.approx(0.0744)  # 2026-06-30

    # Re-running with a changed value upserts rather than duplicating the row (ON CONFLICT).
    rows[0]["net_margin"] = 0.5
    write_financial_trends_rows(dalalos_table, rows)
    stored_again = dalalos_table.execute(
        "SELECT count(*), max(net_margin) FROM dalalos_financial_trends_history WHERE symbol = 'RELIANCE'"
    ).fetchone()
    assert stored_again[0] == 2  # still 2 rows, not 4
    assert float(stored_again[1]) == pytest.approx(0.5)


def test_write_empty_rows_is_a_noop(dalalos_table):
    assert write_financial_trends_rows(dalalos_table, []) == 0
