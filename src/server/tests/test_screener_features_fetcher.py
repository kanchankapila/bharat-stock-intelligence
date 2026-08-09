"""
Regression tests for screener_features_fetcher.py's write-target date (2026-08-01).

Context: stamp_features() already had a `date = ?` guard (added 2026-07-19) specifically to
avoid overwriting a stale historical row -- but it anchored that guard to a raw
datetime.date.today(), which silently writes into a calendar day with no technical_signals
grid row whenever ml-daily-ops's step chain crosses midnight IST (confirmed happening live via
job_heartbeat). Same fix as insider_features.py/bse_event_classifier.py: anchor to
as_of.logical_trading_date() instead. This feature is the largest single engine weight in
most unified_ranker REGIME_WEIGHTS regimes (screener_momentum_score), so a silent 0-row write
here is high blast-radius.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import screener_features_fetcher as sff


class _FakeConn:
    def __init__(self):
        self.executed = []
        self.committed = False
        self.closed = False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


def _feats(**overrides):
    base = {
        "screener_bull_count": 3.0, "screener_bear_count": 0.0,
        "screener_cat_breadth": 2.0, "screener_tier1_count": 1.0,
        "screener_momentum_score": 1.5, "screener_name_signal": 2.0,
        "screener_alpha_score": 0.5,
    }
    base.update(overrides)
    return base


class TestStampFeaturesUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date_not_raw_today(self, monkeypatch):
        monkeypatch.setattr(sff, "logical_trading_date", lambda: "2026-07-31")
        conn = _FakeConn()

        n = sff.stamp_features(conn, {"INFY": _feats()}, {"INFY": 3})

        assert n == 1
        assert len(conn.executed) == 1
        sql, params = conn.executed[0]
        assert "UPDATE technical_signals" in sql
        assert params[-2] == "INFY"
        assert params[-1] == "2026-07-31", (
            "stamp_features() must write against logical_trading_date()'s value, "
            "not datetime.date.today()"
        )

    def test_wrong_calendar_date_would_match_nothing_silently(self, monkeypatch):
        """Negative control: documents the original failure mode. A raw wall-clock date that
        drifts to a day with no grid row yet produces a `date = ?` UPDATE that silently
        matches 0 rows -- no error, no write."""
        monkeypatch.setattr(sff, "logical_trading_date", lambda: "2026-08-01")
        conn = _FakeConn()

        sff.stamp_features(conn, {"INFY": _feats()}, {})

        _, params = conn.executed[0]
        assert params[-1] == "2026-08-01"  # would NOT match a grid row dated 2026-07-31


class TestRunWiresLogicalTradingDateIntoAsOf:
    """run()'s `as_of` (membership snapshot / screener-meta / appearances window) must be the
    same logical trading date as stamp_features()'s write target -- previously each was computed
    independently, so a fix to one without the other could still desynchronize the pipeline."""

    def test_run_uses_one_consistent_logical_trading_date(self, monkeypatch):
        seen: dict = {}

        def _fake_load_meta(con, as_of):
            seen["meta_as_of"] = as_of
            return {}

        def _fake_load_appearances(con, as_of):
            seen["appearances_as_of"] = as_of
            return {}

        def _fake_snapshot(con, as_of, appearances):
            seen["snapshot_as_of"] = as_of
            return 0

        monkeypatch.setattr(sff, "connect", lambda: _FakeConn())
        monkeypatch.setattr(sff, "ensure_schema", lambda con: None)
        monkeypatch.setattr(sff, "logical_trading_date", lambda: "2099-01-01")
        monkeypatch.setattr(sff, "load_screener_meta", _fake_load_meta)
        monkeypatch.setattr(sff, "load_today_appearances", _fake_load_appearances)
        monkeypatch.setattr(sff, "snapshot_membership", _fake_snapshot)
        monkeypatch.setattr(sff, "load_streaks", lambda con: {})
        monkeypatch.setattr(sff, "stamp_features", lambda con, f, s: 0)

        sff.run()

        assert seen["meta_as_of"] == "2099-01-01"
        assert seen["appearances_as_of"] == "2099-01-01"
        assert seen["snapshot_as_of"] == "2099-01-01"


class TestComputeFeaturesSourceDisambiguation:
    """screener_master's PK is (source, scan_id), not scan_id alone -- MoneyControl and ETnow
    independently hand out overlapping small-integer scan_ids (2026-08-04 screener_master
    memory, e.g. scan_id 173 is MC's "Double Dhamaka" AND ETnow's "Warren Buffet Screener").
    compute_features() must key its meta lookup by (source, scan_id), or a stock appearing in
    one provider's colliding screener would silently score using the OTHER provider's
    sentiment/category/bayesian weight."""

    def test_colliding_scan_id_resolves_to_the_correct_provider(self):
        meta = {
            ("moneycontrol", "173"): {
                "sentiment": "bullish", "category": "technical", "bayesian": 0.60,
                "alpha_20d": 0.02, "tier": "A", "name": "Double Dhamaka",
            },
            ("etnow", "173"): {
                "sentiment": "bearish", "category": "fundamental", "bayesian": 0.30,
                "alpha_20d": -0.01, "tier": "C", "name": "Warren Buffet Screener",
            },
        }
        mc_only = sff.compute_features("INFY", [("moneycontrol", "173")], meta)
        et_only = sff.compute_features("INFY", [("etnow", "173")], meta)

        assert mc_only["screener_bull_count"] == 1.0
        assert mc_only["screener_bear_count"] == 0.0
        assert et_only["screener_bull_count"] == 0.0
        assert et_only["screener_bear_count"] == 1.0
        # Same bare scan_id, opposite sentiment -- proves the lookup is source-scoped, not
        # coincidentally correct because only one row happened to exist.
        assert mc_only["screener_momentum_score"] != et_only["screener_momentum_score"]

    def test_unmatched_source_scan_id_pair_is_skipped_not_misattributed(self):
        meta = {("moneycontrol", "173"): {
            "sentiment": "bullish", "category": "technical", "bayesian": 0.60,
            "alpha_20d": 0.02, "tier": "A", "name": "Double Dhamaka",
        }}
        # A source not present in meta must never fall back to some other source's row.
        result = sff.compute_features("INFY", [("trendlyne", "173")], meta)
        assert result["screener_bull_count"] == 0.0
        assert result["screener_bear_count"] == 0.0
