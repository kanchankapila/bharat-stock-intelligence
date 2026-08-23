"""AF-20260823-78 guard: fii_10d_net / dii_3d_net / sector_ret_5d / sector_ret_21d must be
NULL-when-absent, never fabricated-zero.

Same artifact class as AF-20260823-77 (options walls, migration 1787130000000): both writers
that cannot compute these values (backfill_technical_features.py's grid ensurer and its
outcome-driven BACKFILL path) used to OMIT them from their INSERT column lists, so the columns'
DEFAULT 0 silently stored "net FII flow was exactly zero for ten days" / "the sector moved
exactly 0%" on ~90% of all rows (measured live 2026-08-23: 76,525 of 84,533 rows zero on ALL
FOUR columns simultaneously, zero partial-zero rows -- the default's signature, not a market
state). ml_ensemble.build_features reads them through num(col, 0), whose neutral fill fires
only on NULL, so every stored 0 sailed straight into the flow/momentum factors as data.

Layers pinned here, matching how the bug actually lived:
  1. the DDL (schema.postgres.sql) declares no DEFAULT on these columns;
  2. the migration repairs existing rows by the all-four-zero signature and is reversible;
  3. both Python writers name the columns explicitly with NULL values;
  4. densify_feature_matrix.NEVER_FILL stops forward-fill resurrecting the fabrication.
"""
import os
import re
import sys

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
ROOT_DIR = os.path.join(SERVER_DIR, "..", "..")

SCHEMA_SQL = open(os.path.join(ROOT_DIR, "db", "schema.postgres.sql"), encoding="utf-8").read()
MIGRATION_SQL = open(
    os.path.join(ROOT_DIR, "migrations",
                 "20260823235900_fii-dii-sector-rets-null-not-zero.sql"),
    encoding="utf-8").read()

FOUR_COLS = ["fii_10d_net", "dii_3d_net", "sector_ret_5d", "sector_ret_21d"]


# ── 1. The DDL itself ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("col", FOUR_COLS)
def test_schema_declares_no_default_on_continuous_flow_columns(col):
    """A DEFAULT 0 re-creates the artifact even with the writer fixes in place: any future
    INSERT that omits the columns is born at a fabricated zero instead of an honest NULL."""
    assert f'"{col}" DOUBLE PRECISION,' in SCHEMA_SQL, (
        f'{col} must be declared without DEFAULT -- a stored 0 passes ml_ensemble\'s '
        f"num()-neutral fill (which only fires on NULL) and reads as real flow/return data")


@pytest.mark.parametrize("col", FOUR_COLS)
def test_migration_drops_the_default(col):
    up = MIGRATION_SQL.split("-- Down Migration")[0]
    assert re.search(rf"ALTER COLUMN {re.escape(col)}\s+DROP DEFAULT", up), (
        f"migration must DROP DEFAULT on {col}")


# ── 2. The migration's repair predicate is signature-based and reversible ────

def test_migration_repairs_only_all_four_zero_rows():
    """A genuine zero net-flow day or flat sector return would be a PARTIAL zero pattern
    (scanner-written rows show non-zero neighbours); all-four-simultaneously was measured to be
    exclusively the DEFAULT's signature (zero mixed states in 84,533 live rows). A predicate
    weaker than all-four would destroy genuine zeros; stronger would leave fabrication behind."""
    m = re.search(r"UPDATE technical_signals\s+SET.*?WHERE\s+(.*?);", MIGRATION_SQL, re.S)
    assert m, "could not locate the migration's UPDATE ... WHERE"
    where = m.group(1)
    for col in FOUR_COLS:
        assert re.search(rf"{re.escape(col)}\s*=\s*0\b", where), (
            f"repair predicate does not constrain {col}=0 -- not signature-complete")


def test_migration_down_restores_prior_state():
    down = MIGRATION_SQL.split("-- Down Migration")[1]
    assert re.search(r"UPDATE\s+technical_signals", down), "Down must restore stored values"
    assert re.search(r"\bWHERE\b.*\bIS NULL", down, re.S), (
        "Down must scope its restore to repaired rows")
    for col in FOUR_COLS:
        assert re.search(rf"ALTER COLUMN {re.escape(col)}\s+SET DEFAULT 0", down), (
            f"Down migration must restore {col}'s prior DEFAULT 0 (node-pg-migrate reversibility)"
        )
        assert re.search(rf"{re.escape(col)}\s*=\s*0", down), (
            f"Down migration must restore {col}'s stored values"
        )


# ── 3. The writers name the columns explicitly ────────────────────────────────

def _insert_blocks(src_path):
    src = open(os.path.join(SERVER_DIR, src_path), encoding="utf-8").read()
    blocks = re.findall(r"(INSERT INTO technical_signals.*?)ON CONFLICT", src, re.S | re.I)
    assert len(blocks) == 2, (
        f"expected the two known INSERT sites in {src_path} "
        f"(run() BACKFILL path + run_full_universe_today() grid ensurer); found {len(blocks)} -- "
        "a new writer was added and must also list the four flow/sector columns explicitly")
    return blocks


@pytest.mark.parametrize("block", _insert_blocks("backfill_technical_features.py"),
                         ids=["backfill-run", "grid-ensurer"])
def test_backfill_inserts_list_all_four_columns_with_explicit_nulls(block):
    """These two writers cannot compute the four values; omitting the columns from the INSERT
    list is what let DEFAULT 0 fabricate ~90% of the table. They must spell out the columns and
    bind NULL so the omission can never silently return."""
    for col in FOUR_COLS:
        assert re.search(rf"\b{col}\b", block.split("VALUES")[0]), (
            f"INSERT column list omits {col}")
    # All four values arrive as literal NULLs, positioned after the bound parameters.
    vals = block.split("VALUES")[1]
    assert len(re.findall(r"\bNULL\b", vals)) >= 4, (
        "VALUES must carry explicit NULLs for the four flow/sector columns")


def test_strategy_skeleton_writer_never_touches_feature_columns():
    """persistStrategySignal seeds bare skeleton rows (symbol/date/score/json only) that
    legitimately carry no feature values; if it ever grows these columns it must write real
    values or explicit NULLs -- never lean on a DEFAULT again."""
    src = open(os.path.join(SERVER_DIR, "strategySignalsService.ts"), encoding="utf-8").read()
    inserts = re.findall(r"INSERT INTO technical_signals\s*\(([^)]*)\)", src, re.S)
    assert inserts, "could not locate any strategySignalsService.ts INSERT"
    for n, cols in enumerate(inserts):
        for col in FOUR_COLS:
            assert col not in cols, (
                f"strategySignalsService.ts INSERT #{n + 1} lists {col}; skeleton rows must "
                "leave it NULL (or compute it properly), not inherit a default")


# ── 4. Forward-fill must not resurrect the fabrication ────────────────────────

@pytest.mark.parametrize("col", FOUR_COLS)
def test_flow_and_sector_columns_are_never_forward_filled(col):
    """After the repair these columns sit far under SPARSE_COVERAGE_THRESHOLD=0.50, becoming
    fill candidates for the first time -- exactly the second-order trap AF-77 caught for the
    walls. Carrying a daily flow reading or cross-sectional return across MAX_FILL_AGE_DAYS=120
    would fabricate the same stale value this migration removes."""
    sys.path.insert(0, SERVER_DIR)
    from densify_feature_matrix import NEVER_FILL
    assert col in NEVER_FILL


# ── 5. Behavioural: a fresh grid row really is born NULL ──────────────────────

@pytest.mark.postgres
def test_grid_shaped_insert_defaults_to_null(pg_db_conn):
    """End-to-end against the schema the fixtures build from db/schema.postgres.sql: a row
    written exactly like run_full_universe_today() writes it must store NULLs, which
    ml_ensemble's num() neutral fill then treats honestly."""
    conn = pg_db_conn
    conn.execute("""
        INSERT INTO technical_signals (symbol, date, signal_score, signal_type,
             rsi, sma50, sma200, macd, macd_signal, bb_width, volume_ratio,
             above_sma200, adx, cmp, change_pct, nifty_regime, computed_at)
        VALUES ('TESTGRID', '2026-08-21', 0, 'GRID',
             55.0, 100.0, 98.0, 1.0, 0.5, 0.04, 1.2,
             1, 22.0, 101.0, 0.5, 'RISK_ON', CURRENT_TIMESTAMP)
        ON CONFLICT (symbol, date) DO NOTHING
    """)
    row = conn.execute(
        "SELECT {} FROM technical_signals WHERE symbol='TESTGRID'".format(
            ", ".join(FOUR_COLS))).fetchone()
    for i, col in enumerate(FOUR_COLS):
        assert row[i] is None, (
            f"{col} stored {row[i]!r} -- DEFAULT 0 is back, or an INSERT stopped being "
            "column-explicit; this is how ~90% of the table got fabricated")

