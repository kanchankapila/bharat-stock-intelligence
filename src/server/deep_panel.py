"""Which feature_store columns are deep enough to replay a score over (derived, never hardcoded)."""

DEEP_COVERAGE_FLOOR = 0.60

# Named, not dtype-selected: a select_dtypes(np.number) transform once swept these into the
# feature set and scaled the target (ml-model-bugs.md).
LABEL_COLUMNS = (
    "target_ret_1d", "target_ret_5d", "target_ret_15d",
    "target_dir_1d", "target_dir_5d", "target_dir_15d",
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
    cand = [c for c in cand if c not in LABEL_COLUMNS and c not in _KEY_COLUMNS]
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
