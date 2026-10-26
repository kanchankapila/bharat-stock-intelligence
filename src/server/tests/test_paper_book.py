"""paper_book: a frozen, forward-graded paper book on the published ranking (AF-20261026-73).
Each test pins one rule that would make the book's P&L dishonest if it broke."""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import paper_book as P

SESS = pd.bdate_range("2026-01-05", periods=8)
P1 = dict(book_size=1, enter_top_pct=0.5, keep_top_pct=0.5, max_hold_sessions=21, min_adt=1.0, cost_per_side=0.001)


def _world(opens: dict, scores_by_session: dict, adt=10.0):
    O = pd.DataFrame(opens, index=SESS[:len(next(iter(opens.values())))])
    ADT = pd.DataFrame(adt, index=O.index, columns=O.columns)
    calls = {SESS[i]: pd.Series(s) for i, s in scores_by_session.items()}
    return O, ADT, calls


def test_enters_at_the_next_open_and_charges_the_entry_cost():
    # A is top on session 0 -> bought at open[1]; A +10% open[1]->open[2], B flat; bench = +5%.
    O, ADT, calls = _world({"A": [100, 100, 110, 110], "B": [100, 100, 100, 100]}, {0: {"A": 2.0, "B": 1.0}})
    D = P.simulate(calls, O, ADT, P1)
    first = D.iloc[0]
    assert first.name == SESS[1]
    assert first.excess == pytest.approx(0.10 - 0.05 - 0.001)


def test_a_move_before_the_entry_open_is_not_captured():
    # A jumps between open[0] and open[1] -- the decision session -- then is flat: the book earns nothing from it.
    O, ADT, calls = _world({"A": [100, 120, 120, 120], "B": [100, 100, 100, 100]}, {0: {"A": 2.0, "B": 1.0}})
    D = P.simulate(calls, O, ADT, P1)
    assert D.iloc[0].net == pytest.approx(-0.001)


def test_exits_at_the_next_open_once_rank_falls_below_keep_and_pays_both_sides():
    O, ADT, calls = _world({"A": [100] * 5, "B": [100] * 5}, {0: {"A": 2.0, "B": 1.0}, 1: {"A": 0.0, "B": 1.0}})
    D = P.simulate(calls, O, ADT, P1)
    # session 1 decision: A exits and B enters at open[2] -> two sides charged that day
    assert D.loc[SESS[2], "trades"] == 2
    assert D["trades"].sum() == 3


def test_max_hold_releases_a_fading_name_but_keeps_one_that_still_qualifies():
    # 3 names: pct ranks 1.0 / 0.667 / 0.333; entry tier = top 20% (A only), keep band = top 50% (A, B)
    p = dict(P1, book_size=1, enter_top_pct=0.2, keep_top_pct=0.5, max_hold_sessions=2)
    syms = {"A": [100] * 8, "B": [100] * 8, "C": [100] * 8}
    still_top = {i: {"A": 3.0, "B": 2.0, "C": 1.0} for i in range(6)}
    O, ADT, calls = _world(syms, still_top)
    assert P.simulate(calls, O, ADT, p)["trades"].sum() == 1          # top every session: held, never churned
    fading = {0: {"A": 3.0, "B": 2.0, "C": 1.0}, 1: {"A": 2.0, "B": 3.0, "C": 1.0}, 2: {"A": 2.0, "B": 3.0, "C": 1.0}}
    O, ADT, calls = _world(syms, fading)
    D = P.simulate(calls, O, ADT, p)
    # A drops to the keep band (2nd of 3) on session 1, is held until max hold, then released for B
    assert D["trades"].sum() == 3


def test_an_illiquid_name_never_enters():
    O, ADT, calls = _world({"A": [100] * 4, "B": [100] * 4}, {0: {"A": 2.0, "B": 1.0}})
    ADT["A"] = 0.5
    D = P.simulate(calls, O, ADT, P1)
    assert D["trades"].sum() == 1 and D.iloc[0].names == 1
    assert D.iloc[0].net == pytest.approx(-0.001)   # it bought B (flat), not A


def test_holdings_are_the_book_for_the_next_open_including_tonights_decision():
    # the latest session has no next open yet: its decision still sets tomorrow's book, unmarked.
    O, ADT, calls = _world({"A": [100] * 3, "B": [100] * 3}, {0: {"A": 2.0, "B": 1.0}, 2: {"A": 0.0, "B": 2.0}})
    D = P.simulate(calls, O, ADT, P1)
    assert D.attrs["holdings"] == ["B"]
    assert len(D) == 1                       # only the interval open[1] -> open[2] can be marked


def test_null_books_are_reproducible_and_use_identical_mechanics():
    O, ADT, calls = _world({s: [100, 101, 102, 103, 104] for s in "ABCDEF"}, {i: {s: 1.0 for s in "ABCDEF"} for i in range(3)})
    a = P.null_books(calls, O, ADT, P1, n=5, seed=3)
    b = P.null_books(calls, O, ADT, P1, n=5, seed=3)
    assert np.allclose(a, b) and len(a) == 5


@pytest.mark.parametrize("sessions,excess,null_p95,halves,status", [
    (59, 0.20, 0.05, (0.1, 0.1), "LOW-DATA"),
    (60, 0.20, 0.05, (0.1, 0.1), "PROVEN"),
    (60, 0.04, 0.05, (0.02, 0.02), "NOT PROVEN"),
    (60, 0.20, 0.05, (0.25, -0.05), "NOT PROVEN"),
])
def test_verdict_requires_enough_sessions_beating_random_books_and_both_halves(sessions, excess, null_p95, halves, status):
    assert P.verdict(sessions, excess, null_p95, halves)["status"] == status
