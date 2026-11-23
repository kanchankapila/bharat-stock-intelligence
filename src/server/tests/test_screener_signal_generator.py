import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn

import screener_signal_generator as generator


def test_qualifying_screeners_keep_provider_collisions_separate():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE screener_master (
            scan_id TEXT, source TEXT, inferred_sentiment TEXT,
            inferred_category TEXT, name TEXT
        );
        CREATE TABLE screener_performance_v2 (
            screener_id TEXT, source TEXT, bayesian_score REAL, tier TEXT
        );
        CREATE TABLE screener_catalog (
            screener_id TEXT, source TEXT, signal_bias TEXT, category TEXT
        );
        CREATE TABLE trendlyne_screeners (screener_id TEXT, screener_name TEXT);
    """)
    conn.executemany(
        "INSERT INTO screener_master VALUES (?, ?, 'bullish', 'technical', ?)",
        [('shared-id', 'Trendlyne', 'Trendlyne'), ('shared-id', 'MoneyControl', 'MoneyControl')],
    )
    conn.executemany(
        "INSERT INTO screener_performance_v2 VALUES (?, ?, 0.8, 'A')",
        [('shared-id', 'Trendlyne'), ('shared-id', 'MoneyControl')],
    )
    conn.executemany(
        "INSERT INTO screener_catalog VALUES (?, ?, 'bullish', 'technical')",
        [('shared-id', 'trendlyne'), ('shared-id', 'moneycontrol')],
    )

    qualifying = generator.load_high_performing_screeners(conn)

    assert set(qualifying) == {('trendlyne', 'shared-id'), ('moneycontrol', 'shared-id')}


def test_first_appearance_cooldown_is_scoped_to_provider():
    conn = pg_memory_conn()
    conn.execute("""
        CREATE TABLE screener_appearances (
            symbol TEXT, screener_id TEXT, source TEXT,
            appeared_date TEXT, exited_date TEXT
        )
    """)
    today = datetime.date.today()
    conn.executemany(
        "INSERT INTO screener_appearances VALUES (?, ?, ?, ?, NULL)",
        [
            ('AAA', 'shared-id', 'trendlyne', (today - datetime.timedelta(days=5)).isoformat()),
            ('AAA', 'shared-id', 'moneycontrol', today.isoformat()),
        ],
    )

    entries = generator.load_first_appearances_today(conn, {('moneycontrol', 'shared-id')})

    assert entries == {'AAA': [('moneycontrol', 'shared-id')]}
