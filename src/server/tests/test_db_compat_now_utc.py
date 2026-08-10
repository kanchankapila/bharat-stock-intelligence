"""Regression test for db_compat.now_utc_iso() (2026-08-09 live data audit).

Root cause: multiple engines wrote naive `datetime.datetime.now().isoformat()` (local system
clock, no tz offset) into TIMESTAMPTZ columns. Postgres's session TimeZone is UTC, so an
offset-less string is taken to already BE UTC -- on a box whose local clock is IST (UTC+5:30),
that silently stored wall-clock IST ~5.5h ahead of true UTC. Confirmed live:
model_registry.trained_at for a freshly-trained ensemble read as being in the future relative
to Postgres now(). now_utc_iso() must always emit an explicit UTC offset so this can't recur.
"""
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db_compat import now_utc_iso


def test_now_utc_iso_carries_explicit_utc_offset():
    result = now_utc_iso()
    parsed = datetime.datetime.fromisoformat(result)
    assert parsed.tzinfo is not None, "must be tz-aware, not naive"
    assert parsed.utcoffset() == datetime.timedelta(0), f"expected UTC offset, got {parsed.utcoffset()}"


def test_now_utc_iso_is_the_real_current_instant():
    result = now_utc_iso()
    parsed = datetime.datetime.fromisoformat(result)
    real_now = datetime.datetime.now(datetime.timezone.utc)
    drift = abs((real_now - parsed).total_seconds())
    assert drift < 5, f"expected near-zero drift from true UTC now, got {drift}s"


if __name__ == "__main__":
    test_now_utc_iso_carries_explicit_utc_offset()
    test_now_utc_iso_is_the_real_current_instant()
    print("OK")
