"""Which feature_store columns are deep enough to replay a score over (derived, never hardcoded)."""

DEEP_COVERAGE_FLOOR = 0.60

# Named, not dtype-selected: a select_dtypes(np.number) transform once swept these into the
# feature set and scaled the target (ml-model-bugs.md).
LABEL_COLUMNS = (
    "target_ret_1d", "target_ret_5d", "target_ret_15d",
    "target_dir_1d", "target_dir_5d", "target_dir_15d",
)
# Default-filled, not measured: 100%-ish non-null, but the zeros coincide with a NULL in the column
# they derive from (warm-up rows with no history), so 0 means "no data" stored as a reading.
# Evidence: feature_store 2021 window, coincidence = share of the column's zeros where the companion
# is NULL (companion is NULL on only ~8% of all rows; sma200 on ~82%). Measured 2026-10-20.
# Explicit list on purpose: a zero-share threshold would be an unmeasured constant.
# column_zero_shares() prints the rest, so a newly default-filled column is visible.
FAKE_ZERO_COLUMNS = (
    "above_sma200",  # 86.6% zeros; 94.2% of them have sma200 NULL (337,493 zeros vs 52,095 ones)
    "atr_14",        # 5.6% zeros; 100.0% of them have sma20 NULL
    "atr_pct",       # 5.6% zeros; 100.0% of them have sma20 NULL
    "di_plus",       # 6.5% zeros; 99.9% of them have sma20 NULL
    "di_minus",      # 6.6% zeros; 99.6% of them have sma20 NULL
    "adx",           # 11.7% zeros; 100.0% have sma50 NULL (45,487 zeros) vs 10.57% of nonzero rows; di_plus also 0 on 55.8%
    # Companion choice matters: ADX needs ~27 bars (14 for DI, 14 more to smooth), so test it against
    # sma50, not sma20. A companion whose warm-up is SHORTER than the column's under-detects (vs sma20: 70.5%).
)
_KEY_COLUMNS = ("symbol", "date", "timeframe")
_NUMERIC = ("double precision", "real", "numeric", "integer", "bigint", "smallint")


def deep_feature_columns(conn, *, start: str = "2021-01-01", end: str = "2022-01-01",
                         floor: float = DEEP_COVERAGE_FLOOR) -> list[str]:
    """Numeric feature_store columns non-null in >= `floor` of rows over [start, end)."""
    placeholders = ",".join("?" * len(_NUMERIC))
    cand = [
        r[0] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'feature_store' "
            f"AND data_type IN ({placeholders}) ORDER BY ordinal_position",
            _NUMERIC,
        ).fetchall()
    ]
    cand = [c for c in cand if c not in LABEL_COLUMNS and c not in FAKE_ZERO_COLUMNS and c not in _KEY_COLUMNS]
    if not cand:
        return []
    aggs = ", ".join(f'COUNT("{c}")' for c in cand)
    row = conn.execute(
        f"SELECT COUNT(*), {aggs} FROM feature_store WHERE date >= ? AND date < ?", (start, end)
    ).fetchone()
    total, *counts = list(row)
    if not total:
        return []
    return [c for c, n in zip(cand, counts) if n / total >= floor]


def column_zero_shares(conn, columns, *, start: str, end: str) -> dict[str, float]:
    """Share of each column's NON-NULL values that are exactly 0 over [start, end); NaN if none."""
    cols = list(columns)
    if not all(c.isidentifier() for c in cols):
        raise ValueError(f"not a plain column name: {cols}")
    aggs = ", ".join(f'COUNT("{c}"), COUNT(*) FILTER (WHERE "{c}" = 0)' for c in cols)
    row = list(conn.execute(
        f"SELECT {aggs} FROM feature_store WHERE date >= ? AND date < ?", (start, end)
    ).fetchone())
    return {c: (row[2 * i + 1] / row[2 * i] if row[2 * i] else float("nan")) for i, c in enumerate(cols)}
