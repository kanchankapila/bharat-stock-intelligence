import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ownership_relative as own


def _rows():
    return pd.DataFrame([
        {"symbol": "A", "date": "2026-06-30", "mf_flow": 10.0, "sector": "IT"},
        {"symbol": "B", "date": "2026-06-30", "mf_flow": -5.0, "sector": "IT"},
        {"symbol": "C", "date": "2026-06-30", "mf_flow": 2.0, "sector": "BANK"},
        {"symbol": "D", "date": "2026-06-30", "mf_flow": 0.0, "sector": "BANK"},
    ])


def test_ranks_and_sector_demeans(monkeypatch):
    monkeypatch.setattr(own, "MIN_UNIVERSE", 3)
    monkeypatch.setattr(own, "MIN_SECTOR_SIZE", 2)
    out = own.build_ownership_features(_rows()).set_index("symbol")

    assert out.loc["A", "mf_flow_rank"] == 1.0        # highest flow that day
    assert out.loc["B", "mf_flow_rank"] == 0.25       # lowest of 4
    assert out.loc["A", "mf_flow_vs_sector"] == 7.5   # 10 - mean(10,-5)=2.5
    assert out.loc["B", "mf_flow_vs_sector"] == -7.5
    assert out.loc["C", "mf_flow_vs_sector"] == 1.0   # 2 - mean(2,0)=1


def test_thin_day_and_small_sector_leave_features_na(monkeypatch):
    monkeypatch.setattr(own, "MIN_UNIVERSE", 5)     # only 4 names → rank NaN
    monkeypatch.setattr(own, "MIN_SECTOR_SIZE", 5)  # sectors of 2 → vs_sector NaN
    out = own.build_ownership_features(_rows())
    assert out.empty                                # nothing survives the how='all' dropna


def test_empty_input_returns_empty():
    assert own.build_ownership_features(pd.DataFrame()).empty
    assert own.build_ownership_features(pd.DataFrame(columns=["symbol", "date"])).empty
