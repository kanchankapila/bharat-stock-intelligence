import deep_panel
from deep_panel import FAKE_ZERO_COLUMNS, LABEL_COLUMNS, column_zero_shares, deep_feature_columns


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
    assert "rsi_14" in cols  # the labels were 100% populated too; only the name filter removes them


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


def _seed_zero_columns(conn):
    """20 rows. above_sma200: 100% non-null, all 0, while sma200 is NULL throughout (default-filled).
    mtf_alignment_score: 80% zeros but sma20 is always present (a genuinely mostly-false flag)."""
    for i in range(20):
        conn.execute(
            "INSERT INTO feature_store (symbol, date, timeframe, above_sma200, sma200, adx, sma50, mtf_alignment_score, sma20) "
            "VALUES (?, '2021-03-01', 'D', 0, NULL, 0, NULL, ?, 10.0)",
            (f"Z{i}", 0 if i < 16 else 3),
        )
    conn.commit()


def test_default_filled_column_is_excluded(pg_db_conn, monkeypatch):
    _seed_zero_columns(pg_db_conn)
    for c in ("above_sma200", "adx"):
        assert c in FAKE_ZERO_COLUMNS
    assert not {"above_sma200", "adx"} & set(deep_feature_columns(pg_db_conn))
    monkeypatch.setattr(deep_panel, "FAKE_ZERO_COLUMNS", ())
    assert {"above_sma200", "adx"} <= set(deep_feature_columns(pg_db_conn))  # only the explicit list removes them


def test_genuinely_mostly_zero_column_is_kept(pg_db_conn):
    _seed_zero_columns(pg_db_conn)
    assert "mtf_alignment_score" not in FAKE_ZERO_COLUMNS
    assert "mtf_alignment_score" in deep_feature_columns(pg_db_conn)


def test_column_zero_shares_fractions(pg_db_conn):
    for sym, rsi, ret in (("A", 0.0, 1.0), ("B", 0.0, None), ("C", 5.0, None), ("D", None, None)):
        pg_db_conn.execute(
            "INSERT INTO feature_store (symbol, date, timeframe, rsi_14, ret_1d) VALUES (?, '2021-03-01', 'D', ?, ?)",
            (sym, rsi, ret),
        )
    pg_db_conn.commit()
    got = column_zero_shares(pg_db_conn, ["rsi_14", "ret_1d", "ema8"], start="2021-01-01", end="2022-01-01")
    assert got["rsi_14"] == 2 / 3  # zeros over NON-NULL values: D is NULL and not counted
    assert got["ret_1d"] == 0.0
    assert got["ema8"] != got["ema8"]  # no non-null values at all -> NaN, not a fake 0


def test_fake_zero_columns_are_real_feature_columns(pg_db_conn):
    have = {r[0] for r in pg_db_conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = 'feature_store'").fetchall()}
    assert set(FAKE_ZERO_COLUMNS) <= have


def test_label_columns_are_every_target_column(pg_db_conn):
    rows = pg_db_conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = 'feature_store' AND column_name LIKE ?",
        ("target\_%",),
    ).fetchall()
    assert {r[0] for r in rows} == set(LABEL_COLUMNS)
