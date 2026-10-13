"""Regression coverage for the scheduled Yahoo sector/industry gap fallback."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import backfill_sector_industry as subject


def test_broad_gap_set_with_zero_classifications_is_a_failure(monkeypatch):
    monkeypatch.setattr(subject, "_targets", lambda _all, _limit: [f"GAP{i}" for i in range(10)])
    monkeypatch.setattr(subject, "_make_session", lambda: object())
    monkeypatch.setattr(subject, "_fetch_profile", lambda _session, _symbol: (None, None))
    monkeypatch.setattr(subject.time, "sleep", lambda _seconds: None)

    with pytest.raises(RuntimeError, match="no usable classifications"):
        subject.run(dry_run=True, base_delay=0)


def test_no_remaining_gaps_is_a_valid_noop(monkeypatch):
    monkeypatch.setattr(subject, "_targets", lambda _all, _limit: [])
    monkeypatch.setattr(
        subject,
        "_make_session",
        lambda: pytest.fail("no provider session should be opened for a zero-target run"),
    )

    assert subject.run() == (0, 0)
