"""Coverage rotation for so_option_chain_fetcher's symbol order.

Measured live 2026-09-05 (a full 210-symbol pass, timed): the pass costs 115 SECONDS against a
30-minute budget, so it is not timing out. Requests succeed for the first ~160 and then fail in
a block -- 41 of the last 50 -- which is Trendlyne's cumulative REQUEST ALLOWANCE, the same
behaviour already recorded for the screener crawlers: the allowance is a count, not a rate, so
no pacing completes a full pass and parallelising only spends it faster.

`_get_fno_symbols()` returns `ORDER BY symbol`, and the run always restarts at 360ONE, so the
allowance always runs out in the same place. Consequence, measured: 34 F&O names -- every one
of them alphabetically after ~SRF, including TCS, TITAN, TATASTEEL, TRENT, VEDL, WIPRO -- had
NOT ONE row in so_option_chain in 30 days, while the fetcher exited 0 every day.

Rotating by staleness makes each run start where coverage is worst, so the universe converges
over ~2 runs instead of truncating at the same point forever.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from so_option_chain_fetcher import resume_order


def test_never_covered_symbols_come_first():
    order = resume_order(["AAA", "BBB", "CCC"], {"AAA": "2026-09-04", "CCC": "2026-09-04"})
    assert order[0] == "BBB"


def test_oldest_covered_comes_before_most_recently_covered():
    order = resume_order(
        ["AAA", "BBB", "CCC"],
        {"AAA": "2026-09-04", "BBB": "2026-08-01", "CCC": "2026-09-01"},
    )
    assert order == ["BBB", "CCC", "AAA"]


def test_symbol_absent_from_the_coverage_map_is_treated_as_never_covered():
    order = resume_order(["AAA", "ZZZ"], {"AAA": "2026-09-04"})
    assert order[0] == "ZZZ"


def test_ties_break_alphabetically_so_the_order_is_deterministic():
    order = resume_order(["CCC", "AAA", "BBB"], {})
    assert order == ["AAA", "BBB", "CCC"]


def test_output_is_a_permutation_of_the_input():
    """The control that matters: the defect being fixed is symbols silently going missing.

    A reordering that drops or duplicates a name would reproduce that defect in the fix.
    """
    syms = [f"SYM{i:03d}" for i in range(210)]
    cov = {s: "2026-09-04" for s in syms[:160]}
    order = resume_order(syms, cov)
    assert sorted(order) == sorted(syms)
    assert len(order) == len(syms)


def test_the_previously_starved_tail_is_served_first_on_the_next_run():
    """Reproduces the live shape: 160 covered today, 50 never covered."""
    syms = [f"SYM{i:03d}" for i in range(210)]
    cov = {s: "2026-09-05" for s in syms[:160]}
    order = resume_order(syms, cov)
    assert order[:50] == syms[160:], "the starved tail must lead the next pass"
