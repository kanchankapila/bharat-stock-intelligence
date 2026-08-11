"""Pins that a name dropping below the liquidity floor is EXITED, not written off at -100%.

The bug: exits were priced from the eligible-only slice (`index_by_date`), but `eligible` is
`adt20 >= min_adt AND next_open exists` -- a liquidity screen, not a survival test. Any name
whose 20-day turnover dipped under the floor for one session looked unexitable and took
MISSING_EXIT_PCT = -100%, in the portfolio AND the benchmark.

Measured live 2026-08-11: 0.618% of the eligible universe drops out per session, so the
benchmark carried a -0.618%/day phantom drag -- the harness printed a -99.9% universe over
1,391 sessions for a market that roughly tripled (+344% equal-weighted, open-to-open).
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import factor_backtest as fb  # noqa: E402


def panel(illiquid_day2_next_open=121.0, drop_from_panel=False):
    """3 sessions x 4 symbols. LIQ* stay eligible; DIPPY loses eligibility on d2 but still trades.

    Every symbol rises 10% per session, so a correct backtest sees +10% everywhere and the
    factor cannot matter -- which is exactly what makes the write-off visible.
    """
    rows = []
    for sym, adts in [("LIQA", [1e9, 1e9, 1e9]),
                      ("LIQB", [1e9, 1e9, 1e9]),
                      ("LIQC", [1e9, 1e9, 1e9]),
                      ("DIPPY", [1e9, 1e3, 1e9])]:      # <- under the floor on d2 only
        for i, (d, adt) in enumerate(zip(["2026-01-01", "2026-01-02", "2026-01-03"], adts)):
            nxt = 100.0 * (1.1 ** (i + 1))
            if sym == "DIPPY" and i == 1:
                nxt = illiquid_day2_next_open
            rows.append(dict(symbol=sym, date=d, adt20=adt, next_open=nxt,
                             r21=1.0, deliv_pct=50.0))
    px = pd.DataFrame(rows)
    if drop_from_panel:                                   # genuinely delisted on d2
        px = px[~((px.symbol == "DIPPY") & (px.date == "2026-01-02"))]
    px["signal_eligible"] = px["adt20"] >= fb.DEFAULT_MIN_ADT
    px["eligible"] = px["signal_eligible"] & px["next_open"].notna() & (px["next_open"] > 0)
    return px


def test_illiquid_name_is_priced_out_not_written_off():
    p = panel()
    ex = fb.index_exit_prices(p)
    assert "DIPPY" in ex["2026-01-02"].index, "a name under the ADT floor must still be exitable"
    assert ex["2026-01-02"]["DIPPY"] == pytest.approx(121.0)


def test_eligible_index_still_excludes_it_for_SELECTION():
    """The liquidity floor must keep gating NEW positions -- the fix is about exits only."""
    p = panel()
    sel = fb.index_by_date(p)
    assert "DIPPY" not in set(sel["2026-01-02"].symbol)


def test_genuinely_delisted_name_still_takes_the_write_off():
    """Negative control for over-correcting: absent from the panel entirely is a real
    write-off, and MISSING_EXIT_PCT must still apply to it."""
    p = panel(drop_from_panel=True)
    ex = fb.index_exit_prices(p)
    assert "DIPPY" not in ex["2026-01-02"].index


def test_benchmark_is_not_dragged_by_a_liquidity_dip():
    """The reported bug, end to end: every name rises 10%/session, so the universe return
    must be ~+10% and not be dragged toward -100% by DIPPY's one-day ineligibility."""
    p = panel()
    r = fb.run_backtest(p, "delivery_pct", rebalance_days=1, top_k=2, cost_bps_per_side=0.0)
    assert r["universe_per_period_pct"] == pytest.approx(10.0, abs=0.5), (
        f"universe should be ~+10%/period, got {r['universe_per_period_pct']}")
    assert r["gross_per_period_pct"] == pytest.approx(10.0, abs=0.5)


def test_exit_prices_are_a_superset_of_eligible():
    p = panel()
    sel, ex = fb.index_by_date(p), fb.index_exit_prices(p)
    for d, g in sel.items():
        assert set(g.symbol) <= set(ex[d].index)


def test_zero_and_nan_next_open_are_excluded_from_exits():
    """A non-positive or missing open is not a price -- those must still fall through to the
    write-off path rather than being 'exited' at 0."""
    p = panel()
    p.loc[(p.symbol == "LIQC") & (p.date == "2026-01-02"), "next_open"] = 0.0
    p.loc[(p.symbol == "LIQB") & (p.date == "2026-01-02"), "next_open"] = np.nan
    ex = fb.index_exit_prices(p)
    assert "LIQC" not in ex["2026-01-02"].index
    assert "LIQB" not in ex["2026-01-02"].index


class TestBenchmarkSanityGuard:
    """Every figure the harness reports is an excess over the benchmark, so an implausible
    benchmark voids all of them. The exit-pricing bug printed a universe of -4.66%/month
    (-99.9% over 5.5 years) next to authoritative-looking t-stats and went unchallenged for a
    day. This guard is what makes that loud instead of quiet."""

    def summarize(self, universe_pct_per_period, rebalance_days=21):
        df = pd.DataFrame({
            "date": pd.date_range("2024-01-01", periods=40, freq="ME").astype(str),
            "gross_pct": [1.0] * 40,
            "cost_pct": [0.1] * 40,
            "net_pct": [0.9] * 40,
            "universe_pct": [universe_pct_per_period] * 40,
            "turnover": [0.3] * 40,
            "n_names": [50] * 40,
            "missing_exits": [0] * 40,
        })
        return fb._summarize(df, "delivery_pct", rebalance_days, 50, 25.0, False, 0)

    def test_the_real_broken_value_is_flagged(self):
        # -4.66%/month is what the harness actually printed before the fix.
        r = self.summarize(-4.66)
        assert r["benchmark_sane"] is False
        assert r["universe_annualised_pct"] < -40

    def test_the_real_fixed_value_passes(self):
        # +1.29%/month is what it reports after the fix; ~16.6%/yr, entirely ordinary.
        r = self.summarize(1.29)
        assert r["benchmark_sane"] is True

    def test_an_implausibly_good_benchmark_is_also_flagged(self):
        """Symmetric on purpose: a benchmark that is too GOOD is equally a broken harness,
        and would inflate nothing while hiding that the universe is wrong."""
        assert self.summarize(6.0)["benchmark_sane"] is False

    def test_print_refuses_a_verdict_on_an_insane_benchmark(self, capsys):
        fb._print(self.summarize(-4.66))
        out = capsys.readouterr().out
        assert "BENCHMARK IMPLAUSIBLE" in out
        assert "VERDICT" not in out, "a verdict on a void benchmark is worse than no verdict"

    def test_print_still_gives_a_verdict_when_the_benchmark_is_fine(self, capsys):
        fb._print(self.summarize(1.29))
        out = capsys.readouterr().out
        assert "BENCHMARK IMPLAUSIBLE" not in out
        assert "VERDICT" in out
