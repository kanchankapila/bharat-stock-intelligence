"""Trendlyne sends a section key present-but-null, not absent.

`params.get("volume_analysis", {})` returns the {} default only when the key is MISSING. When
the key is present with an explicit JSON null it returns None, and the next `.get`/iteration
raises. Live-caught 2026-08-17: trendlyne_adv_tech_fetcher.py died mid-run with
`AttributeError: 'NoneType' object has no attribute 'get'` at extract_features, which killed the
whole trendlyne-midweek job -- it had been failing every Tuesday since 2026-08-04 while the
heartbeat's truncated error text pointed at unrelated upstream 405s.

Seven sibling keys in that file had the identical shape, so these tests cover the shape (every
section null, one at a time) rather than only the key that happened to crash first.

Negative control: revert any `.get(k) or {}` back to `.get(k, {})` and the matching case fails.
"""
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

adv_tech = importlib.import_module("trendlyne_adv_tech_fetcher")
price_analysis = importlib.import_module("trendlyne_price_analysis_fetcher")

# Every section extract_features() reads with a container default.
NULLABLE_SECTIONS = [
    "ma_signal",
    "oscillator_signal",
    "pivot_level",
    "price_analysis",
    "volume_analysis",
    "beta_analysis",
]


def _params(**overrides):
    """A minimally realistic `body.parameters`, with every section populated by default."""
    params = {
        "ma_signal": {"bullish": 8, "bearish": 8},
        "oscillator_signal": {"bullish": 5, "bearish": 4},
        "pivot_level": {"pivot": 100.0},
        "price_analysis": [{"name": "1 Week", "changePercent": "1.5"}],
        "volume_analysis": {"tableData": [["Day", 1000, 45.0, 450]]},
        "beta_analysis": [{"name": "1 Month", "value": "1.1"}],
    }
    params.update(overrides)
    return params


@pytest.mark.parametrize("section", NULLABLE_SECTIONS)
def test_extract_features_survives_an_explicitly_null_section(section):
    """A single null section must not raise -- it must just leave those features unset."""
    feat = adv_tech.extract_features(_params(**{section: None}))
    assert isinstance(feat, dict)


def test_extract_features_survives_every_section_null_at_once():
    feat = adv_tech.extract_features({s: None for s in NULLABLE_SECTIONS})
    assert isinstance(feat, dict)


def test_extract_features_still_reads_a_populated_volume_analysis():
    """Control: the fix must not silently swallow real data -- the happy path still parses.

    Without this, replacing the body with `return {}` would pass every test above.
    """
    feat = adv_tech.extract_features(_params())
    assert feat.get("vol_avg_day") == 1000
    assert feat.get("delivery_pct_day") == 45.0


def test_price_analysis_parse_survives_null_head_and_body(monkeypatch):
    """Same shape in the sibling fetcher: `data.get("head", {}).get("status")`."""
    class _Resp:
        @staticmethod
        def json():
            return {"head": None, "body": None}

    monkeypatch.setattr(price_analysis, "retry_get", lambda *a, **k: _Resp())
    # _fetch swallows exceptions into `return None`, so an AttributeError here would look
    # identical to a legitimately-empty response. Assert the exception never happens at all by
    # checking nothing was printed to the error path.
    printed: list[str] = []
    monkeypatch.setattr("builtins.print", lambda *a, **k: printed.append(" ".join(map(str, a))))
    result = price_analysis._fetch("123", session=None)
    assert not any("NoneType" in p for p in printed), printed
    assert not result  # head.status != "0" -> legitimately empty, not a crash
