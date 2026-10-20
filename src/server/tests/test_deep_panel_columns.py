from deep_panel import LABEL_COLUMNS, deep_feature_columns


def _seed(conn):
    """20 in-window rows: rsi_14 + targets always, ret_1d half the time, iv_rank once.
    ema8 is populated only OUTSIDE the window."""
    for i in range(20):
        conn.execute(
            "INSERT INTO feature_store (symbol, date, timeframe, rsi_14, target_ret_5d, target_dir_5d, ret_1d, iv_rank) "
            "VALUES (?, ?, 'D', ?, ?, ?, ?, ?)",
            (f"S{i}", "2021-03-01", 50.0, 0.01, 1, 0.5 if i % 2 else None, 30.0 if i == 0 else None),
        )
    conn.execute(
        "INSERT INTO feature_store (symbol, date, timeframe, ema8) VALUES ('S0', '2023-03-01', 'D', 9.0)"
    )
    conn.commit()


def test_excludes_label_columns(pg_db_conn):
    _seed(pg_db_conn)
    cols = deep_feature_columns(pg_db_conn)
    assert not set(cols) & set(LABEL_COLUMNS)
    assert "ret_1d" in cols or "rsi_14" in cols  # labels were 100% populated; only the name filter removes them


def test_excludes_keys_and_respects_the_floor(pg_db_conn):
    _seed(pg_db_conn)
    cols = deep_feature_columns(pg_db_conn, floor=0.60)
    assert "symbol" not in cols and "date" not in cols
    assert "iv_rank" not in cols  # 5% populated
    assert "ret_1d" not in cols  # 50% < 60%
    assert "rsi_14" in cols


def test_floor_is_applied_not_ignored(pg_db_conn):
    _seed(pg_db_conn)
    assert len(deep_feature_columns(pg_db_conn, floor=0.99)) < len(deep_feature_columns(pg_db_conn, floor=0.10))


def test_only_the_window_counts(pg_db_conn):
    _seed(pg_db_conn)
    assert "ema8" not in deep_feature_columns(pg_db_conn, floor=0.01)
    assert "ema8" in deep_feature_columns(pg_db_conn, start="2023-01-01", end="2024-01-01", floor=0.9)


def test_empty_window_returns_nothing(pg_db_conn):
    assert deep_feature_columns(pg_db_conn) == []
