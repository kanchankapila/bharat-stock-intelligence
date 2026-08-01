"""
Regression tests for the 2026-07-31 intraday-audit fixes in intraday_ranker.py:
the emission gate and the mean-reversion component.

Context: graded honestly (entry at the first 15m bar opening after the signal, exits only on
later bars) this engine's Buy/Strong-Buy signals returned -0.099% gross against a -0.003%
universe, t=-6.55. Both original score components are momentum-flavoured, and momentum has a
NEGATIVE cross-sectional IC intraday. Across 256 backtested configurations the best net return
at a generous 15bps round-trip was -0.004%, so a correctly-signed score is break-even, not
profitable -- which is why the load-bearing fix is a gate on realised edge rather than a sign
flip.
"""

import os
import sys
import types

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_ranker as ir


class _Row(dict):
    """dict that also supports row["k"] access the way db_compat rows do."""


class _FakeConn:
    """Minimal stand-in: routes each query by a substring match to a canned result."""

    def __init__(self, settings=None, outcome_row=None, bars=None):
        self._settings = settings or {}
        self._outcome_row = outcome_row
        self._bars = bars or []

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if "FROM app_settings" in s:
            key = params[0] if params else None
            val = self._settings.get(key)
            return types.SimpleNamespace(
                fetchone=lambda: (_Row(value=val) if val is not None else None),
                fetchall=lambda: [])
        if "intraday_recommendation_outcomes" in s:
            return types.SimpleNamespace(fetchone=lambda: self._outcome_row, fetchall=lambda: [])
        if "intraday_ohlcv" in s:
            return types.SimpleNamespace(fetchall=lambda: self._bars, fetchone=lambda: None)
        return types.SimpleNamespace(fetchall=lambda: [], fetchone=lambda: None)


def _ranker(**kw):
    r = ir.IntradayRanker.__new__(ir.IntradayRanker)
    r.conn = _FakeConn(**kw)
    return r


# ── Blend weights ─────────────────────────────────────────────────────────────

def test_blend_weights_sum_to_one():
    """The unified_ranker REGIME_WEIGHTS drift bug (2026-07-23) was exactly this going
    unchecked: components added over time without rebalancing the others down, silently
    diluting every documented weight."""
    assert ir.W_BREAKOUT + ir.W_SCREENER + ir.W_REVERSAL == pytest.approx(1.0)


def test_reversal_carries_real_weight():
    assert ir.W_REVERSAL > 0, "the only correctly-signed intraday component must be used"


def test_breakout_no_longer_dominates():
    """breakout_probability's validated edge is on a ~10-day forward label, not this horizon."""
    assert ir.W_BREAKOUT < ir.W_REVERSAL


# ── Emission gate ─────────────────────────────────────────────────────────────

class TestEmissionGate:
    def test_closed_when_trailing_edge_is_negative(self):
        r = _ranker(outcome_row=_Row(avg_pnl=-0.456, n=3015))
        allowed, reason = r._emission_allowed()
        assert allowed is False
        assert "-0.456" in reason

    def test_closed_when_trailing_edge_is_exactly_zero(self):
        r = _ranker(outcome_row=_Row(avg_pnl=0.0, n=3015))
        assert r._emission_allowed()[0] is False

    def test_open_when_trailing_edge_is_positive_on_enough_trades(self):
        r = _ranker(outcome_row=_Row(avg_pnl=0.25, n=3015))
        allowed, reason = r._emission_allowed()
        assert allowed is True
        assert "+0.250" in reason

    def test_closed_on_thin_sample_even_if_positive(self):
        """A handful of lucky trades must not re-open the gate."""
        r = _ranker(outcome_row=_Row(avg_pnl=5.0, n=3))
        allowed, reason = r._emission_allowed()
        assert allowed is False
        assert "need" in reason

    def test_closed_when_no_outcomes_exist(self):
        r = _ranker(outcome_row=None)
        assert r._emission_allowed()[0] is False

    def test_manual_override_reopens_the_gate(self):
        """Deliberate escape hatch -- the gate must be overridable, but only explicitly."""
        r = _ranker(settings={ir.EMISSION_GATE_SETTING: "true"},
                    outcome_row=_Row(avg_pnl=-9.9, n=3015))
        allowed, reason = r._emission_allowed()
        assert allowed is True
        assert "manually disabled" in reason

    def test_override_is_off_by_default(self):
        r = _ranker(settings={ir.EMISSION_GATE_SETTING: "false"},
                    outcome_row=_Row(avg_pnl=-0.5, n=3015))
        assert r._emission_allowed()[0] is False

    def test_gate_never_raises_on_db_error(self):
        class _Boom(_FakeConn):
            def execute(self, sql, params=()):
                if "intraday_recommendation_outcomes" in sql:
                    raise RuntimeError("relation does not exist")
                return super().execute(sql, params)

        r = ir.IntradayRanker.__new__(ir.IntradayRanker)
        r.conn = _Boom()
        allowed, _reason = r._emission_allowed()
        assert allowed is False, "a failed edge lookup must fail CLOSED, not open"


# ── Reversal component ────────────────────────────────────────────────────────

def _bar(sym, hhmm, hi, lo, close, vol=1000, ss="00"):
    return _Row(symbol=sym, datetime=f"2026-07-30T{hhmm}:{ss}+05:30",
                high=hi, low=lo, close=close, volume=vol)


class TestReversalScores:
    def test_weak_stock_ranks_above_strong_stock(self):
        """The measured effect: a name sitting at the bottom of its session range and below
        its VWAP outperforms one at the top of its range, over the rest of the session."""
        bars = [
            # WEAK: closes at the low of its range and below VWAP
            _bar("WEAK", "09:15", 110, 90, 108), _bar("WEAK", "09:30", 108, 90, 91),
            # STRONG: closes at the high of its range and above VWAP
            _bar("STRONG", "09:15", 110, 90, 92), _bar("STRONG", "09:30", 112, 92, 111),
        ]
        scores = _ranker(bars=bars)._reversal_scores()
        assert scores["WEAK"] > scores["STRONG"]

    def test_scores_are_bounded_0_100(self):
        bars = [_bar("A", "09:15", 110, 90, 108), _bar("A", "09:30", 108, 90, 91),
                _bar("B", "09:15", 110, 90, 92), _bar("B", "09:30", 112, 92, 111)]
        for v in _ranker(bars=bars)._reversal_scores().values():
            assert 0.0 <= v <= 100.0

    def test_off_grid_snapshot_bars_are_ignored(self):
        """Vendors append the current in-progress quote stamped at request time (zero volume,
        open==high==low==close). Letting one in would drag the session high/low and VWAP."""
        clean = [_bar("A", "09:15", 110, 90, 108), _bar("A", "09:30", 108, 90, 91)]
        polluted = clean + [_bar("A", "09:30", 500, 500, 500, vol=0, ss="20")]
        assert _ranker(bars=polluted)._reversal_scores() == _ranker(bars=clean)._reversal_scores()

    def test_missing_bars_yield_no_scores_rather_than_raising(self):
        assert _ranker(bars=[])._reversal_scores() == {}

    def test_null_prices_are_skipped(self):
        bars = [_Row(symbol="A", datetime="2026-07-30T09:15:00+05:30",
                     high=None, low=None, close=None, volume=100),
                _bar("A", "09:30", 110, 90, 100)]
        assert _ranker(bars=bars)._reversal_scores()  # does not raise, still scores A


class TestIndexSeriesExcluded:
    """Index series are not tradeable instruments. They reach the ranker by TWO routes --
    technical_signals already carries breakout_probability rows for NIFTY50/NIFTYBANK/NIFTYIT/
    NIFTYMIDCAP, and intraday_ohlcv carries their bars as of 2026-07-31 -- so the exclusion has
    to sit at the universe level, not inside one component.

    This was a live pre-existing bug: 522 index rows had accumulated in
    intraday_recommendations_history complete with entry/stop/target and position sizing,
    because the downstream liquidity filter only drops the ones that happen to have no ADTV
    (which let NIFTY50 and NIFTYMIDCAP through)."""

    def test_index_symbols_are_known(self):
        assert {"NIFTY50", "NIFTYBANK", "INDIAVIX"} <= set(ir._INDEX_SYMBOLS)

    def test_universe_subtraction_removes_every_index(self):
        universe = {"RELIANCE", "INFY"} | set(ir._INDEX_SYMBOLS)
        assert universe - set(ir._INDEX_SYMBOLS) == {"RELIANCE", "INFY"}

    def test_reversal_component_would_otherwise_score_indices(self):
        """Pins the reason the universe-level guard is required: the bars are genuinely there,
        so the component scores them and only the explicit exclusion keeps them out."""
        bars = [_bar("NIFTY50", "09:15", 110, 90, 108), _bar("NIFTY50", "09:30", 108, 90, 91),
                _bar("RELIANCE", "09:15", 110, 90, 92), _bar("RELIANCE", "09:30", 112, 92, 111)]
        scored = _ranker(bars=bars)._reversal_scores()
        assert "NIFTY50" in scored
        assert set(scored) - set(ir._INDEX_SYMBOLS) == {"RELIANCE"}
