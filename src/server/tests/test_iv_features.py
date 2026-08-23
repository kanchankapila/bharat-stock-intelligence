"""
Tests for the implied-volatility feature pipeline:
  - iv_features.compute_iv_rank / build_iv_features (rank math + as-of grouping)
  - pcr_fetcher.compute_atm_iv_skew (chain → ATM IV + 25-delta-proxy skew)
"""

import os
import pathlib
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import iv_features as ivf
from iv_features import compute_iv_rank, build_iv_features
from pcr_fetcher import compute_atm_iv_skew


class TestComputeIVRank:
    def test_neutral_until_min_observations(self):
        iv = pd.Series([20.0] * 10)
        r = compute_iv_rank(iv, window=252, min_periods=20)
        assert (r == 0.5).all()                       # too few obs → neutral

    def test_flat_series_is_neutral(self):
        iv = pd.Series([18.0] * 30)
        r = compute_iv_rank(iv, window=252, min_periods=20)
        assert (r == 0.5).all()                       # max==min → neutral, not divide-by-zero

    def test_rank_positions_within_range(self):
        # Once the trailing window spans [0,100], a value of 50 sits at rank 0.5; a new high
        # ranks 1.0. (A monotonic ramp instead ranks 1.0 throughout — every point is a new high.)
        iv = pd.Series([0.0, 100.0, 50.0, 100.0])
        r = compute_iv_rank(iv, window=252, min_periods=2)
        assert r.iloc[1] == pytest.approx(1.0)        # 100 is the max so far
        assert r.iloc[2] == pytest.approx(0.5)        # 50 sits mid the [0,100] range
        assert r.iloc[3] == pytest.approx(1.0)        # back to the high

    def test_rank_is_trailing_not_lookahead(self):
        # A late spike must not raise the rank of earlier rows (only past+current used).
        iv = pd.Series([10, 11, 12, 13, 100.0])
        r = compute_iv_rank(iv, window=252, min_periods=2)
        assert r.iloc[1] == pytest.approx(1.0)        # 11 was the max *so far* at index 1
        assert r.iloc[3] == pytest.approx(1.0)        # 13 was the max so far at index 3
        assert r.iloc[4] == pytest.approx(1.0)        # 100 is the new max

    def test_output_clipped_to_unit_interval(self):
        iv = pd.Series(np.linspace(5, 50, 40))
        r = compute_iv_rank(iv, min_periods=5)
        assert r.min() >= 0.0 and r.max() <= 1.0


class TestBuildIVFeatures:
    def test_empty_input(self):
        out = build_iv_features(pd.DataFrame(columns=["symbol", "date", "atm_iv", "iv_skew"]))
        assert out.empty
        assert list(out.columns) == ["symbol", "date", "iv_rank", "iv_skew"]

    def test_per_symbol_independent_ranks(self):
        # ≥20 obs/symbol so the production min_periods is satisfied (else every row is neutral).
        n = 25
        dates = [f"2024-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]
        df = pd.DataFrame({
            "symbol":  ["A"] * n + ["B"] * n,
            "date":    dates * 2,
            "atm_iv":  list(range(1, n + 1)) + list(range(n, 0, -1)),  # A rising, B falling
            "iv_skew": [1.0] * (2 * n),
        })
        out = build_iv_features(df)
        a = out[out.symbol == "A"].sort_values("date")
        b = out[out.symbol == "B"].sort_values("date")
        assert a["iv_rank"].iloc[-1] == pytest.approx(1.0)   # A ends at its trailing high
        assert b["iv_rank"].iloc[-1] == pytest.approx(0.0)   # B ends at its trailing low
        assert (out["iv_skew"] == 1.0).all()


class TestComputeATMIVSkew:
    def test_picks_strike_nearest_spot(self):
        strikes = [(90, 22, 25), (100, 18, 20), (110, 19, 21)]
        atm_iv, _ = compute_atm_iv_skew(strikes, underlying=101)
        assert atm_iv == pytest.approx((18 + 20) / 2)        # 100 strike is nearest 101

    def test_skew_is_otm_put_minus_otm_call(self):
        # spot 100 → OTM put ≈ 95, OTM call ≈ 105.
        strikes = [(95, 17, 24), (100, 18, 20), (105, 15, 19)]
        _, skew = compute_atm_iv_skew(strikes, underlying=100)
        assert skew == pytest.approx(24 - 15)                # put_iv@95 − call_iv@105

    def test_no_underlying_returns_none(self):
        assert compute_atm_iv_skew([(100, 18, 20)], underlying=0) == (None, None)

    def test_zero_ivs_ignored(self):
        assert compute_atm_iv_skew([(100, 0, 0)], underlying=100) == (None, None)


# ── Regression: run(only_date="today") write-target date (2026-08-01) ────────────────────
#
# ml-daily-ops calls `iv_features.py --date today`, which set `only_date="today"` and computed
# `target = datetime.date.today().isoformat()`, then filtered feats down to rows matching
# `target` (`feats = feats[feats["date"] == target]`). Whenever ml-daily-ops's step chain
# crossed midnight IST, target became a day with no options data at all, so feats went empty
# and the write silently became a no-op. Must use as_of.logical_trading_date() instead.

class _FakeConn:
    def execute(self, sql, params=None):
        return self

    def fetchall(self):
        return []

    def close(self):
        pass


class TestRunDateTodayUsesLogicalTradingDate:
    def _mock_common(self, monkeypatch, feats):
        monkeypatch.setattr(ivf, "read_df",
                             lambda *a, **k: pd.DataFrame(columns=["symbol", "date", "atm_iv", "iv_skew"]))
        monkeypatch.setattr(ivf, "build_iv_features", lambda options: feats)
        monkeypatch.setattr(ivf, "connect", lambda: _FakeConn())
        monkeypatch.setattr(ivf, "safe_alter", lambda *a, **k: None)
        monkeypatch.setattr(ivf, "compute_options_walls",
                             lambda conn, symbol, spot, as_of_date, rows=None: {
                                 "call_wall_dist_pct": 0.0, "put_wall_dist_pct": 0.0,
                                 "near_expiry_gamma": 0.0,
                             })

    def test_only_date_today_filters_by_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(ivf, "logical_trading_date", lambda: "2026-07-31")
        feats = pd.DataFrame({
            "symbol": ["INFY", "INFY"],
            "date":   ["2026-07-31", "2026-08-01"],  # only the mocked "today" should survive
            "iv_rank": [0.5, 0.9],
            "iv_skew": [1.0, 1.0],
        })
        self._mock_common(monkeypatch, feats)
        captured = {}

        def _fake_executemany(sql, params):
            captured["params"] = params
            return len(params)

        monkeypatch.setattr(ivf, "executemany", _fake_executemany)

        n = ivf.run(only_date="today")

        assert n == 1
        assert captured["params"][0][-1] == "2026-07-31", (
            "run(only_date='today') must filter by logical_trading_date()'s value, "
            "not datetime.date.today()"
        )

    def test_wrong_calendar_date_would_starve_the_write_silently(self, monkeypatch):
        """Negative control: documents the original failure mode. If the filter target drifts
        to a day with no options data, feats goes empty and the write silently becomes a
        no-op (no error, no rows written)."""
        monkeypatch.setattr(ivf, "logical_trading_date", lambda: "2026-08-01")
        feats = pd.DataFrame({
            "symbol": ["INFY"], "date": ["2026-07-31"],
            "iv_rank": [0.5], "iv_skew": [1.0],
        })
        self._mock_common(monkeypatch, feats)
        monkeypatch.setattr(ivf, "executemany", lambda sql, params: (_ for _ in ()).throw(
            AssertionError("executemany should not be called when feats end up empty")))

        n = ivf.run(only_date="today")

        assert n == 0


# ── Options walls: absent chain must be NULL, never 0.0 ──────────────────────────────
# technical_signals.call_wall_dist_pct/put_wall_dist_pct were REAL DEFAULT 0, and
# compute_options_walls returned 0.0 whenever it had nothing to compute from. Measured live
# 2026-08-23: 79,694 of 84,533 rows sat at zero on BOTH columns with ZERO NULLs, and on the
# latest date all 154 non-zero rows had an option chain while only 25 of the 2,042 zeros ever
# did. So the column read 100% populated and was ~93% fabricated.
#
# ml_ensemble.build_features is the consumer that makes it matter:
#     feat['call_wall_dist_pct'] = num('call_wall_dist_pct', 5.0).clip(0, 20)
#     feat['near_call_wall']     = (feat['call_wall_dist_pct'] < 2.0)
# num()'s 5.0 neutral fill only fires on NULL; a stored 0 passes straight through and makes
# near_call_wall TRUE for ~93% of the training matrix -- flagging "not an F&O name" while
# claiming to flag "spot pinned against a heavy OI strike".
#
# near_expiry_gamma is deliberately excluded: 0.0 is its true value ("not within 7 days").

class TestOptionsWallsAbsentChainIsNull:
    def test_no_chain_rows_yields_none_not_zero(self):
        out = ivf.compute_options_walls(_FakeConn(), "INFY", 1500.0, "2026-08-21", rows=[])
        assert out["call_wall_dist_pct"] is None
        assert out["put_wall_dist_pct"] is None
        # 0 genuinely means "not near expiry" here, so this one stays numeric.
        assert out["near_expiry_gamma"] == 0.0

    def test_no_spot_yields_none_not_zero(self):
        out = ivf.compute_options_walls(_FakeConn(), "INFY", 0.0, "2026-08-21", rows=None)
        assert out["call_wall_dist_pct"] is None
        assert out["put_wall_dist_pct"] is None

    def test_real_chain_still_computes_a_number(self):
        # Control: the fix must not stop a genuine chain from producing a real distance.
        # Peak call OI at 1600, peak put OI at 1400, spot 1500 -> +6.67% / +6.67%.
        rows = [
            (1400.0, 10.0, 900.0, "2026-08-28"),
            (1500.0, 50.0, 50.0,  "2026-08-28"),
            (1600.0, 800.0, 10.0, "2026-08-28"),
        ]
        out = ivf.compute_options_walls(_FakeConn(), "INFY", 1500.0, "2026-08-21", rows=rows)
        assert out["call_wall_dist_pct"] == pytest.approx(6.6667, abs=1e-3)
        assert out["put_wall_dist_pct"] == pytest.approx(6.6667, abs=1e-3)

    def test_ddl_declares_no_default_on_wall_distance_columns(self):
        # A DEFAULT 0 on the column re-creates the artifact even with the fix above, because
        # every newly-inserted grid row is born at 0 without compute_options_walls running.
        src = pathlib.Path(ivf.__file__).read_text(encoding="utf-8")
        assert '("call_wall_dist_pct", "REAL")' in src
        assert '("put_wall_dist_pct",  "REAL")' in src
        assert "call_wall_dist_pct\", \"REAL DEFAULT 0" not in src
        assert "put_wall_dist_pct\",  \"REAL DEFAULT 0" not in src
