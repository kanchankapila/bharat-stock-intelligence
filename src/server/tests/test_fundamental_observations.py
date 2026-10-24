"""Immutable vendor observations preserve revisions without inventing historical availability."""
from pathlib import Path

import pytest


MIGRATION = Path(__file__).resolve().parents[3] / 'migrations/20261024120000_fundamental-observations.sql'


@pytest.fixture
def archive(pg_schema):
    conn, _ = pg_schema
    with conn.cursor() as cur:
        cur.execute('CREATE TABLE mc_earnings_forecast (symbol text, date text, metric_type text, avg real, fetched_at text)')
        cur.execute('CREATE TABLE mc_estimates_hits_misses (symbol text, quarter text, actual real, fetched_at text)')
        cur.execute('CREATE TABLE mc_price_forecast (symbol text, mean real, fetched_at text)')
        cur.execute('CREATE TABLE tl_financial_quality (symbol text, as_of_date date, roce real, fetched_at text)')
        cur.execute("INSERT INTO mc_earnings_forecast VALUES ('SEED', 'Mar 2026', 'eps', 10, '2026-01-01')")
        cur.execute(MIGRATION.read_text(encoding='utf-8'))
    return conn


def test_forecast_revisions_survive_upstream_overwrite(archive):
    with archive.cursor() as cur:
        cur.execute("INSERT INTO mc_earnings_forecast VALUES ('REVISION', 'Mar 2027', 'eps', 20, '2020-01-01')")
        cur.execute("UPDATE mc_earnings_forecast SET avg = 25 WHERE symbol = 'REVISION'")
        cur.execute("SELECT values_json->>'avg', observation_kind, observed_at > '2026-10-01'::timestamptz "
                    "FROM fundamental_observations WHERE symbol = 'REVISION' ORDER BY observation_id")
        assert cur.fetchall() == [('20', 'INSERT', True), ('25', 'UPDATE', True)]


def test_seed_is_labelled_as_current_observation_not_historical_fact(archive):
    with archive.cursor() as cur:
        cur.execute("SELECT observation_kind, observed_at > '2026-10-01'::timestamptz "
                    "FROM fundamental_observations WHERE symbol = 'SEED'")
        assert cur.fetchone() == ('BASELINE', True)


def test_all_four_sources_archive_actual_payloads_and_cannot_be_rewritten(archive):
    with archive.cursor() as cur:
        cur.execute("INSERT INTO mc_estimates_hits_misses VALUES ('HIT', 'Sep 2026', 15, '2020-01-01')")
        cur.execute("INSERT INTO mc_price_forecast VALUES ('TARGET', 200, '2020-01-01')")
        cur.execute("INSERT INTO tl_financial_quality VALUES ('QUALITY', '2026-10-13', 18, '2020-01-01')")
        cur.execute("SELECT source_table, symbol FROM fundamental_observations ORDER BY source_table")
        assert cur.fetchall() == [('mc_earnings_forecast', 'SEED'), ('mc_estimates_hits_misses', 'HIT'),
                                  ('mc_price_forecast', 'TARGET'), ('tl_financial_quality', 'QUALITY')]
        with pytest.raises(Exception, match='append-only'):
            cur.execute("UPDATE fundamental_observations SET values_json = '{}'::jsonb")
        with pytest.raises(Exception, match='append-only'):
            cur.execute('DELETE FROM fundamental_observations')


def test_observation_and_source_write_rollback_together(archive):
    with archive.cursor() as cur:
        cur.execute('BEGIN')
        cur.execute("INSERT INTO mc_price_forecast VALUES ('ROLLBACK', 200, '2020-01-01')")
        cur.execute('ROLLBACK')
        cur.execute("SELECT count(*) FROM fundamental_observations WHERE symbol = 'ROLLBACK'")
        assert cur.fetchone()[0] == 0
