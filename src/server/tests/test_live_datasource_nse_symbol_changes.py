"""Opt-in live contract test for NSE's official symbol-change archive."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_symbol_mapping_audit as audit

pytestmark = pytest.mark.live_datasource


def test_live_symbol_change_archive_is_complete_and_has_recent_changes():
    import requests

    response = audit.retry_get(requests, audit.SYMBOL_CHANGE_URL, headers=audit.HEADERS, timeout=30)
    rows = audit.parse_symbol_changes(response.text)
    assert len(rows) >= audit.MIN_SYMBOL_CHANGES
    assert max(row["effective_date"] for row in rows).year >= 2026
    assert any(row["old_symbol"] == "SHUKRAPHAR" and row["new_symbol"] == "SHUKRAMED" for row in rows)
