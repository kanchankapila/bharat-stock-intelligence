import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_symbol_mapping_audit as audit


def test_parse_symbol_changes_requires_complete_official_shape(monkeypatch):
    monkeypatch.setattr(audit, "MIN_SYMBOL_CHANGES", 1)
    rows = audit.parse_symbol_changes(
        "NAME OF THE COMPANY,OLD SYMBOL,NEW SYMBOL,EFFECTIVE DATE\n"
        "Example Ltd,OLDCO,NEWCO,01-NOV-2026\n"
    )
    assert rows[0]["old_symbol"] == "OLDCO"
    assert rows[0]["new_symbol"] == "NEWCO"
    assert rows[0]["effective_date"].isoformat() == "2026-11-01"
    with pytest.raises(ValueError, match="columns missing"):
        audit.parse_symbol_changes("name,old,new,date\n")


def test_resolves_rename_chains_only_to_current_nse_symbols():
    changes = [
        {"old_symbol": "OLDEST", "new_symbol": "OLDCO", "effective_date": audit.dt.date(2025, 1, 1)},
        {"old_symbol": "OLDCO", "new_symbol": "NEWCO", "effective_date": audit.dt.date(2026, 1, 1)},
    ]
    assert audit.resolve_current_symbol("OLDEST", changes, {"NEWCO"}) == "NEWCO"
    assert audit.resolve_current_symbol("OLDCO", changes, {"NEWCO"}) == "NEWCO"
    assert audit.resolve_current_symbol("UNRELATED", changes, {"NEWCO"}) is None


def test_audit_flags_old_static_ticker_and_provider_id_mismatch():
    equity = [{"symbol": "NEWCO", "name": "New Company Limited", "isin": "INE000A01001"}]
    changes = [{"old_symbol": "OLDCO", "new_symbol": "NEWCO", "effective_date": audit.dt.date(2026, 1, 1)}]
    master = [{"symbol": "NEWCO", "name": "New Company Limited", "isin": "INE000A01001",
               "status": "ACTIVE", "admission_reason": "official_nse_equity_master_and_60_sessions",
               "mcsymbol": "MCNEW", "tlid": "123", "stockid": None, "companyid": None,
               "tickertape_sid": None, "fincode": None, "scripcode": None}]
    static = {"stocklist.ts": [{"symbol": "OLDCO", "mcsymbol": "MCOLD"},
                               {"symbol": "NEWCO", "mcsymbol": "MCSTALE"}]}

    report = audit.build_audit(equity, changes, master, static)

    assert {row["kind"] for row in report["findings"]} == {"stale_ticker", "provider_id_mismatch"}
    assert report["status"] == "partial"
    assert report["provider_ids_live_verified"] is False
