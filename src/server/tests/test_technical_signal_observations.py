"""Regression coverage for the immutable technical-signals observation stream.

The wide ``technical_signals`` row remains the compatibility projection used by existing
readers and writers.  Every mutation must be journalled atomically so two writers touching the
same feature can be reconstructed instead of silently overwriting each other.
"""


def test_technical_signal_writes_are_journalled_with_changed_columns(pg_db_conn):
    conn = pg_db_conn
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, rsi) VALUES (?, ?, ?)",
        ("OBSERVE", "2026-10-15", 42.0),
    )
    conn.execute(
        "UPDATE technical_signals SET rsi = ?, macd = ? WHERE symbol = ? AND date = ?",
        (55.0, 1.25, "OBSERVE", "2026-10-15"),
    )

    rows = conn.execute(
        "SELECT operation, changed_columns, values_json, previous_values_json "
        "FROM technical_signal_observations WHERE symbol = ? ORDER BY observation_id",
        ("OBSERVE",),
    ).fetchall()

    assert len(rows) == 2
    assert rows[0]["operation"] == "INSERT"
    assert "rsi" in rows[0]["changed_columns"]
    assert rows[0]["values_json"]["rsi"] == 42.0
    assert rows[1]["operation"] == "UPDATE"
    assert rows[1]["changed_columns"] == ["macd", "rsi"]
    assert rows[1]["values_json"] == {"macd": 1.25, "rsi": 55.0}
    assert rows[1]["previous_values_json"] == {"macd": None, "rsi": 42.0}


def test_technical_signal_observation_rows_are_immutable(pg_db_conn):
    conn = pg_db_conn
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, rsi) VALUES (?, ?, ?)",
        ("IMMUTABLE", "2026-10-15", 42.0),
    )
    observation_id = conn.execute(
        "SELECT observation_id FROM technical_signal_observations WHERE symbol = ?",
        ("IMMUTABLE",),
    ).fetchone()["observation_id"]

    try:
        conn.execute(
            "UPDATE technical_signal_observations SET values_json = '{}'::jsonb "
            "WHERE observation_id = ?",
            (observation_id,),
        )
    except Exception as exc:
        assert "append-only" in str(exc)
        conn.rollback()
    else:  # pragma: no cover - proves the guard, not merely the table shape
        raise AssertionError("technical_signal_observations accepted an in-place rewrite")


def test_compatibility_view_tracks_the_current_projection(pg_db_conn):
    conn = pg_db_conn
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, rsi) VALUES (?, ?, ?)",
        ("CURRENT", "2026-10-15", 42.0),
    )
    conn.execute(
        "UPDATE technical_signals SET rsi = ? WHERE symbol = ? AND date = ?",
        (61.0, "CURRENT", "2026-10-15"),
    )
    row = conn.execute(
        "SELECT rsi FROM v_technical_signals_current WHERE symbol = ? AND date = ?",
        ("CURRENT", "2026-10-15"),
    ).fetchone()
    assert row["rsi"] == 61.0
