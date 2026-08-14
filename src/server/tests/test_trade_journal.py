"""Pure core of trade_journal.py: the benchmark subtraction, the NaN policy, and the
per-date (not pooled) aggregation.

These call the real functions rather than reimplementing their arithmetic -- a test that
mirrors the logic under test passes against the unfixed source, which recurring-bugs.md
records happening in this repo as recently as 2026-08-13.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from screener_combo_finder import COST_PCT
from trade_journal import (
    EXPECTED_EXCESS_PCT,
    MIN_DATES_FOR_VERDICT,
    excess_return_pct,
    per_date_stats,
    universe_mean_return,
    verdict,
    winsorize,
)


# ── excess_return_pct: the benchmark subtraction and the NaN policy ───────────────────

def test_excess_is_benchmark_relative_and_cost_adjusted():
    # +2% gross on a day the universe did +1%, minus the round-trip cost.
    got = excess_return_pct(entry=100.0, exit_=102.0, universe_ret=0.01)
    assert got == pytest.approx(2.0 - COST_PCT - 1.0)


def test_beating_the_market_on_a_down_day_is_positive_excess():
    # Lost 1% while the universe lost 3% -- that is a winning trade by this benchmark,
    # which is the whole point of grading against the universe rather than against zero.
    got = excess_return_pct(entry=100.0, exit_=99.0, universe_ret=-0.03)
    assert got == pytest.approx(-1.0 - COST_PCT + 3.0)
    assert got > 0


@pytest.mark.parametrize("entry,exit_,uni", [
    (float("nan"), 102.0, 0.01),
    (100.0, float("nan"), 0.01),
    (100.0, 102.0, float("nan")),
    (None, 102.0, 0.01),
    (100.0, None, 0.01),
    (0.0, 102.0, 0.01),
])
def test_non_finite_inputs_return_none_never_zero(entry, exit_, uni):
    """NaN is truthy, so `float(x or 0)` would coerce it to a flat trade -- fabricating a
    0.00% result that is indistinguishable from a genuinely unchanged one. Skip, don't
    coerce (recurring-bugs.md, NaN & null)."""
    assert excess_return_pct(entry, exit_, uni) is None


# ── universe_mean_return: winsorization, and refusing to invent a benchmark ───────────

def test_universe_mean_is_winsorized_against_a_corrupt_bar():
    """One RELIANCE-style bad bar must not drag the benchmark. Raw mean here is ~+25%;
    winsorized it stays near the +1% the other 99 names actually did."""
    normal = pd.DataFrame({"open": [100.0] * 99, "close": [101.0] * 99})
    corrupt = pd.DataFrame({"open": [100.0], "close": [250000.0]})
    bars = pd.concat([normal, corrupt], ignore_index=True)

    got = universe_mean_return(bars)
    raw = ((bars["close"] - bars["open"]) / bars["open"]).mean()

    assert raw > 20, "fixture is not exercising the corrupt-bar case"
    assert got == pytest.approx(0.01, abs=0.02)


def test_empty_universe_returns_none_not_zero():
    """A missing benchmark must block the date, not silently become 0.0 -- which would
    credit the entire day's market move to the trade as if it were edge."""
    assert universe_mean_return(pd.DataFrame(columns=["open", "close"])) is None
    assert universe_mean_return(
        pd.DataFrame({"open": [0.0, np.nan], "close": [10.0, 10.0]})
    ) is None


def test_winsorize_drops_non_finite_values():
    got = winsorize(pd.Series([1.0, 2.0, float("nan"), np.inf, 3.0]))
    assert len(got) == 3
    assert np.isfinite(got).all()


# ── per_date_stats: per-date, never pooled ───────────────────────────────────────────

def test_two_trades_on_one_date_are_one_observation():
    """measurement.md's panel spec: aggregate to one row per date BEFORE computing
    anything. Pooling has flipped or inflated a conclusion three separate times here."""
    rows = pd.DataFrame({
        "trade_date": ["2026-08-10", "2026-08-10", "2026-08-11"],
        "model_excess_pct": [1.0, 3.0, 2.0],
    })
    got = per_date_stats(rows, "model_excess_pct")

    assert got["n_dates"] == 2
    assert got["n_trades"] == 3
    # mean of the per-date means (2.0, 2.0), not the pooled mean of (1, 3, 2).
    assert got["mean_pct"] == pytest.approx(2.0)


def test_pooling_would_give_a_different_answer_than_per_date():
    """Negative control for the test above: on an unbalanced panel the pooled mean and the
    per-date mean genuinely differ, so the assertion there is not vacuous."""
    rows = pd.DataFrame({
        "trade_date": ["2026-08-10"] * 9 + ["2026-08-11"],
        "model_excess_pct": [10.0] * 9 + [0.0],
    })
    got = per_date_stats(rows, "model_excess_pct")
    pooled = rows["model_excess_pct"].mean()

    assert got["mean_pct"] == pytest.approx(5.0)
    assert pooled == pytest.approx(9.0)
    assert got["mean_pct"] != pytest.approx(pooled)


def test_ungraded_rows_are_excluded_not_counted_as_zero():
    rows = pd.DataFrame({
        "trade_date": ["2026-08-10", "2026-08-11", "2026-08-12"],
        "model_excess_pct": [2.0, None, float("nan")],
    })
    got = per_date_stats(rows, "model_excess_pct")
    assert got["n_dates"] == 1
    assert got["mean_pct"] == pytest.approx(2.0)


def test_all_ungraded_returns_none():
    rows = pd.DataFrame({"trade_date": ["2026-08-10"], "model_excess_pct": [None]})
    assert per_date_stats(rows, "model_excess_pct") is None


# ── verdict: refuses to conclude anything on a thin sample ───────────────────────────

def _stats(n_dates, mean_pct, p_value=0.01, ci=None):
    return {"n_dates": n_dates, "n_trades": n_dates, "mean_pct": mean_pct,
            "t_stat": 3.0, "p_value": p_value, "ci95": ci or (mean_pct - 0.2, mean_pct + 0.2),
            "win_rate": 0.6}


def test_a_handful_of_good_trades_does_not_get_a_verdict():
    """Five profitable trades is what makes people size up. It is also indistinguishable
    from noise against a 425-date backtest, so the verdict must say so explicitly."""
    got = verdict(_stats(5, 4.0), _stats(5, 3.8))
    assert got.startswith("TOO EARLY")
    assert "do not resize" in got.lower()


def test_significantly_negative_realized_excess_says_stop():
    got = verdict(_stats(MIN_DATES_FOR_VERDICT, 0.5),
                  _stats(MIN_DATES_FOR_VERDICT, -1.0, ci=(-1.5, -0.5)))
    assert got.startswith("STOP")


def test_slippage_larger_than_the_edge_is_called_out_before_the_signal_is_blamed():
    """The model made money and the fills gave it all back. The failure is execution, and
    the verdict must not let that be read as the setup being dead."""
    got = verdict(_stats(MIN_DATES_FOR_VERDICT, 1.0),
                  _stats(MIN_DATES_FOR_VERDICT, 0.0, ci=(-0.3, 0.3)))
    assert "EXECUTION IS EATING THE EDGE" in got
    assert f"{EXPECTED_EXCESS_PCT:.2f}" in got


def test_no_data_is_reported_as_no_data():
    assert verdict(None, None).startswith("NO DATA")


# ── storage routing: Postgres first, offline JSONL fallback, idempotent sync ──────────
#
# These fake read_df/execute rather than driving a real DB: the logic being tested is the
# ROUTING (which store a row lands in, and what happens when it comes back), not the SQL.
# The SQL itself is exercised end to end against a throwaway SQLite fixture -- see the
# session-log entry for the verification run.

import json

import trade_journal as tj


class FakeDB:
    """Minimal stand-in for the trade_journal table: a dict keyed on id.

    On a conflicting id it updates ONLY the columns named in the SQL's own `DO UPDATE SET`
    clause, parsed out of the statement `_upsert_db` actually emits. That parsing is the
    point: hardcoding "synced_at is preserved" here would make the fake agree with the
    intent no matter what the real update list says, and the idempotency test below would
    pass against a version that walks synced_at forward -- the reimplements-the-logic-under-
    test trap in recurring-bugs.md. Confirmed by negative control: widening _upsert_db's
    update list to include synced_at now fails that test."""

    def __init__(self, available=True):
        self.rows, self.available, self.upserts = {}, available, 0

    @staticmethod
    def _updated_columns(sql):
        clause = sql.split("DO UPDATE SET", 1)[1]
        return [assign.split("=", 1)[0].strip() for assign in clause.split(",")]

    def read_df(self, sql, params=()):
        if not self.available:
            raise RuntimeError("connection refused")
        if "WHERE 1 = 0" in sql:
            return pd.DataFrame(columns=["ok"])
        return pd.DataFrame(list(self.rows.values())) if self.rows \
            else pd.DataFrame(columns=tj.COLUMNS)

    def execute(self, sql, params=()):
        if not self.available:
            raise RuntimeError("connection refused")
        self.upserts += 1
        rec = dict(zip(tj.COLUMNS, params))
        existing = self.rows.get(rec["id"])
        if existing is None:
            self.rows[rec["id"]] = rec
            return
        merged = dict(existing)
        for col in self._updated_columns(sql):
            merged[col] = rec[col]
        self.rows[rec["id"]] = merged


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Pins TRADE_JOURNAL_PATH and resets the cached db probe. Env a shared facade reads is
    shared state -- leaking it between tests is a documented recurring bug here."""
    monkeypatch.setenv("TRADE_JOURNAL_PATH", str(tmp_path / "journal.jsonl"))
    monkeypatch.setattr(tj, "_db_ok", None)

    def _make(available=True):
        db = FakeDB(available=available)
        monkeypatch.setattr(tj, "read_df", db.read_df)
        monkeypatch.setattr(tj, "execute", db.execute)
        monkeypatch.setattr(tj, "_db_ok", None)
        return db

    return _make


def _rec(id_="a1", symbol="MOREPENLAB", trade_date="2026-08-13", **kw):
    base = {c: None for c in tj.COLUMNS}
    base.update(id=id_, setup="capitulation_triple", symbol=symbol,
                trade_date=trade_date, side="LONG", qty=100.0)
    base.update(kw)
    return base


def test_trade_goes_to_the_database_when_it_is_reachable(store):
    db = store(available=True)
    assert tj.append_trade(_rec()) == "database"
    assert len(db.rows) == 1
    assert not tj.journal_path().exists(), "should not have touched the offline file"


def test_trade_falls_back_to_the_offline_file_when_the_db_is_down(store):
    db = store(available=False)
    assert tj.append_trade(_rec()) == "offline journal"
    assert db.rows == {}
    lines = tj.journal_path().read_text().strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["symbol"] == "MOREPENLAB"


def test_offline_rows_are_visible_in_the_journal_before_they_are_synced(store):
    """The fallback is worthless if `report` cannot see what was logged offline."""
    store(available=False)
    tj.append_trade(_rec(id_="offline1"))

    store(available=True)
    loaded = tj.load_journal()
    assert set(loaded["id"]) == {"offline1"}
    assert loaded.loc[0, "_source"] == "file"


def test_sync_moves_offline_rows_into_the_db_and_is_idempotent(store):
    store(available=False)
    tj.append_trade(_rec(id_="offline1"))

    db = store(available=True)
    assert tj.sync() == 1
    assert set(db.rows) == {"offline1"}
    assert db.rows["offline1"]["synced_at"] is not None

    tj.sync()
    assert len(db.rows) == 1, "second sync must upsert, not duplicate"


def test_first_sync_wins_when_the_two_stores_disagree_on_synced_at(store):
    """synced_at records when a row FIRST reconciled into the DB, so a later file copy must
    not move it forward -- that is exactly how unified_signals.signal_generated_at stopped
    being a generation time and became a last-seen time (migration 1786920000000).

    Set up deliberately, because the ordinary sync path can't reach it: after a normal sync
    both stores hold the same stamp, so re-writing it is a no-op whether or not the column
    is excluded from the update list. The stores only disagree when the same journal is
    synced from a second machine, which is the case this pins."""
    db = store(available=True)
    tj.append_trade(_rec(id_="shared1"))
    first = db.rows["shared1"]["synced_at"]

    # A file copy of the same trade carrying a later stamp, as a second machine would have.
    later = "2099-01-01T00:00:00+00:00"
    tj._write_file(pd.DataFrame([_rec(id_="shared1", synced_at=later)]))
    tj.sync()

    assert db.rows["shared1"]["synced_at"] == first
    assert db.rows["shared1"]["synced_at"] != later


def test_a_synced_row_is_not_counted_twice(store):
    store(available=False)
    tj.append_trade(_rec(id_="offline1"))
    store(available=True)
    tj.sync()

    loaded = tj.load_journal()
    assert len(loaded) == 1, "row present in both stores must appear once"
    assert loaded.loc[0, "_source"] == "db"


def test_grades_written_offline_survive_the_sync(store):
    """A trade logged AND graded offline must carry its grading columns into the DB, not
    arrive as a bare row that looks ungraded."""
    store(available=False)
    tj.append_trade(_rec(id_="offline1", model_excess_pct=1.21, real_excess_pct=0.39,
                         slippage_pct=0.82))

    db = store(available=True)
    tj.sync()
    assert db.rows["offline1"]["model_excess_pct"] == pytest.approx(1.21)
    assert db.rows["offline1"]["slippage_pct"] == pytest.approx(0.82)


def test_sync_while_still_offline_changes_nothing(store):
    db = store(available=False)
    tj.append_trade(_rec(id_="offline1"))
    assert tj.sync() == 0
    assert db.rows == {}
