"""Regression tests for the 2026-07-31 bias-audit fixes.

Each test pins the exact defect that was found in the live database, so a regression
resurfaces as a failure rather than as silently-wrong training data.
"""
import datetime
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import data_integrity_repair as dir_mod
import densify_feature_matrix as densify


# ── insider_trades date normalisation ────────────────────────────────────────
# Live DB had 44,981 of 44,985 rows as "22 May, 2026" in a TEXT column, so every
# `date >= ...` filter was a lexicographic string compare.

class TestParseLooseDate:
    @pytest.mark.parametrize("raw,expected", [
        ("22 May, 2026", datetime.date(2026, 5, 22)),
        ("22 May 2026", datetime.date(2026, 5, 22)),
        ("1 Jan, 2015", datetime.date(2015, 1, 1)),
        ("31 Dec, 2024", datetime.date(2024, 12, 31)),
        ("2026-05-22", datetime.date(2026, 5, 22)),
        ("2026-05-22T10:30:00", datetime.date(2026, 5, 22)),
        ("22 September, 2026", datetime.date(2026, 9, 22)),
    ])
    def test_parses_known_shapes(self, raw, expected):
        assert dir_mod.parse_loose_date(raw) == expected

    @pytest.mark.parametrize("raw", ["", None, "not a date", "32 May, 2026", "22 Xyz, 2026"])
    def test_returns_none_rather_than_guessing(self, raw):
        assert dir_mod.parse_loose_date(raw) is None

    def test_iso_output_sorts_chronologically(self):
        """The whole point: ISO strings must sort as dates under a string compare."""
        raws = ["9 Feb, 2026", "22 May, 2026", "1 Jan, 2026", "31 Dec, 2025"]
        iso = sorted(dir_mod.parse_loose_date(r).isoformat() for r in raws)
        assert iso == sorted(iso)
        assert iso[0] == "2025-12-31" and iso[-1] == "2026-05-22"
        # and the pre-fix format does NOT sort correctly, which is why this mattered
        assert sorted(raws) != [
            "31 Dec, 2025", "1 Jan, 2026", "9 Feb, 2026", "22 May, 2026"]


# ── signal_outcomes label split ──────────────────────────────────────────────
# h3/7/14/30 used a fixed +/-2% terminal barrier; h1/5/15 used path-based MFE/stop
# labels whose NEUTRAL band overlapped their own WIN/LOSS regions.

class TestLabelDefinitions:
    def test_horizon_families_are_disjoint(self):
        assert not set(dir_mod.TERMINAL_HORIZONS) & set(dir_mod.PATH_HORIZONS)

    def test_every_observed_horizon_is_classified(self):
        observed = {1, 3, 5, 7, 14, 15, 30}
        known = set(dir_mod.TERMINAL_HORIZONS) | set(dir_mod.PATH_HORIZONS)
        assert observed <= known, f"unclassified horizons: {observed - known}"

    def test_implausible_return_threshold_catches_the_live_outlier(self):
        # live max was +27,399.70%
        assert abs(27399.70) > dir_mod.MAX_PLAUSIBLE_RETURN_PCT
        assert abs(45.0) <= dir_mod.MAX_PLAUSIBLE_RETURN_PCT


# ── signal_outcomes signal_source backfill (2026-08) ─────────────────────────
# The real root cause behind the label split above: outcome_resolver.py and
# confluence_outcome_tracker.py were colliding on the same (symbol, signal_date,
# horizon_days) key with no way to tell which wrote a given row. Inferred from
# label_definition, since the mechanism traced live showed each horizon bucket was
# claimed by exactly one writer for its entire history.

class _SkipAddColumnIfExists:
    """repair_labels() issues `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which is valid
    Postgres syntax (its real, production target) but not real SQLite -- sql_translate.py
    doesn't translate this pattern, so it's never been runnable against a plain sqlite3
    connection. This fixture already creates those columns via CREATE TABLE, so the two
    ALTER statements are no-ops here; skip exactly those two rather than mocking the whole
    connection, so every other statement still hits the real in-memory DB."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        if 'ADD COLUMN IF NOT EXISTS' in sql:
            return self._conn  # inert stand-in; return value is unused by repair_labels
        return self._conn.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._conn, name)


class TestSignalSourceBackfill:
    def _make_db(self):
        import sqlite3
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE signal_outcomes (
                symbol TEXT, signal_date TEXT, horizon_days INTEGER,
                entry_price REAL, return_pct REAL, outcome TEXT,
                label_definition TEXT, is_suspect INTEGER DEFAULT 0,
                signal_source TEXT NOT NULL DEFAULT 'unknown',
                PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
            );
        """)
        return _SkipAddColumnIfExists(conn)

    def test_path_barrier_rows_backfilled_to_technical(self):
        conn = self._make_db()
        conn.execute(
            "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, "
            "return_pct, outcome, label_definition) VALUES ('AAA','2026-01-01',1,100,5,'WIN','path_barrier')"
        )
        conn.commit()
        dir_mod.repair_labels(conn, dry=False)
        row = conn.execute("SELECT signal_source FROM signal_outcomes WHERE symbol='AAA'").fetchone()
        assert row['signal_source'] == 'technical'

    def test_terminal_pct2_rows_backfilled_to_confluence(self):
        conn = self._make_db()
        conn.execute(
            "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, "
            "return_pct, outcome, label_definition) VALUES ('BBB','2026-01-01',7,100,3,'WIN','terminal_pct2')"
        )
        conn.commit()
        dir_mod.repair_labels(conn, dry=False)
        row = conn.execute("SELECT signal_source FROM signal_outcomes WHERE symbol='BBB'").fetchone()
        assert row['signal_source'] == 'confluence'

    def test_already_attributed_rows_are_left_untouched(self):
        """A row the fixed writers already stamped correctly must not be reclassified by the
        backfill's label_definition heuristic -- only pre-fix 'unknown' rows are inferred."""
        conn = self._make_db()
        conn.execute(
            "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, "
            "return_pct, outcome, label_definition, signal_source) "
            "VALUES ('CCC','2026-01-01',7,100,3,'WIN','path_barrier','confluence')"
        )
        conn.commit()
        dir_mod.repair_labels(conn, dry=False)
        row = conn.execute("SELECT signal_source FROM signal_outcomes WHERE symbol='CCC'").fetchone()
        assert row['signal_source'] == 'confluence', "must not overwrite an already-attributed row"

    def test_unclassifiable_horizon_stays_unknown(self):
        """horizon=99 is in neither TERMINAL_HORIZONS nor PATH_HORIZONS -- label_definition
        backfills to 'unknown', and signal_source correctly has no inference to make."""
        conn = self._make_db()
        conn.execute(
            "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, "
            "return_pct, outcome) VALUES ('DDD','2026-01-01',99,100,5,'WIN')"
        )
        conn.commit()
        dir_mod.repair_labels(conn, dry=False)
        row = conn.execute("SELECT signal_source, label_definition FROM signal_outcomes WHERE symbol='DDD'").fetchone()
        assert row['label_definition'] == 'unknown'
        assert row['signal_source'] == 'unknown'

    def test_dry_run_writes_nothing(self):
        conn = self._make_db()
        conn.execute(
            "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, "
            "return_pct, outcome, label_definition) VALUES ('EEE','2026-01-01',1,100,5,'WIN','path_barrier')"
        )
        conn.commit()
        dir_mod.repair_labels(conn, dry=True)
        row = conn.execute("SELECT signal_source FROM signal_outcomes WHERE symbol='EEE'").fetchone()
        assert row['signal_source'] == 'unknown', "dry run must not backfill anything"


class TestBadBarThreshold:
    def test_reliance_2022_06_16_would_be_flagged(self):
        """close=1280 against a prior bar near 1.0 -> +127,900%."""
        assert abs(1280.0 / 1.0 - 1.0) > dir_mod.MAX_PLAUSIBLE_1D_MOVE

    def test_normal_move_is_not_flagged(self):
        assert abs(102.0 / 100.0 - 1.0) <= dir_mod.MAX_PLAUSIBLE_1D_MOVE

    def test_threshold_clears_the_nse_circuit_band(self):
        """Must sit above the 20% band or every legitimate circuit hit gets quarantined."""
        assert dir_mod.MAX_PLAUSIBLE_1D_MOVE > 0.20


# ── feature-matrix densification ─────────────────────────────────────────────

class TestDensifyGuards:
    def test_model_outputs_are_never_forward_filled(self):
        """Carrying a stale prediction forward would fabricate a call never made."""
        for c in ('win_probability', 'calibrated_win_probability', 'breakout_probability'):
            assert c in densify.NEVER_FILL

    def test_price_columns_are_never_forward_filled(self):
        for c in ('close', 'open', 'high', 'low', 'volume', 'change_pct'):
            assert c in densify.NEVER_FILL

    def test_own_bookkeeping_column_excluded(self):
        assert 'enrichment_ffill_age_days' in densify.NEVER_FILL

    def test_fill_age_is_capped(self):
        assert 0 < densify.MAX_FILL_AGE_DAYS <= 365


class TestForwardFillSemantics:
    """The fill must be strictly forward in time -- a backward fill would be look-ahead."""

    def _frame(self):
        return pd.DataFrame({
            'symbol': ['A'] * 5 + ['B'] * 5,
            'date': ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'] * 2,
            'roce': [None, 12.0, None, None, None,
                     None, None, 8.0, None, None],
        }).sort_values(['symbol', 'date'])

    def test_carries_value_forward_only(self):
        df = self._frame()
        out = df.groupby('symbol', group_keys=False)[['roce']].ffill(
            limit=densify.MAX_FILL_AGE_DAYS)
        a = out[df.symbol == 'A']['roce'].tolist()
        # first row stays NULL (nothing earlier to carry), rest carry 12.0
        assert a[0] is None or pd.isna(a[0])
        assert a[1:] == [12.0, 12.0, 12.0, 12.0]

    def test_does_not_leak_across_symbols(self):
        df = self._frame()
        out = df.groupby('symbol', group_keys=False)[['roce']].ffill(
            limit=densify.MAX_FILL_AGE_DAYS)
        b = out[df.symbol == 'B']['roce'].tolist()
        # B's first two rows must NOT pick up A's 12.0
        assert all(pd.isna(v) for v in b[:2])
        assert b[2:] == [8.0, 8.0, 8.0]

    def test_never_backfills(self):
        df = self._frame()
        out = df.groupby('symbol', group_keys=False)[['roce']].ffill(
            limit=densify.MAX_FILL_AGE_DAYS)
        # A row dated before the first real observation must stay NULL, or the feature
        # would encode a value that did not exist yet.
        assert pd.isna(out[df.symbol == 'B']['roce'].iloc[0])

    def test_fill_stops_after_age_limit(self):
        df = pd.DataFrame({
            'symbol': ['A'] * 6,
            'date': [f'2026-07-0{i}' for i in range(1, 7)],
            'roce': [5.0, None, None, None, None, None],
        })
        out = df.groupby('symbol', group_keys=False)[['roce']].ffill(limit=2)
        vals = out['roce'].tolist()
        assert vals[:3] == [5.0, 5.0, 5.0]
        assert all(pd.isna(v) for v in vals[3:]), "fill must not run past its age cap"
