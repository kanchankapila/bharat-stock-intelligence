import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from fii_dii_backfill import parse_tradebrains_rows


def test_maps_and_merges_fii_dii_by_date():
    fii = [{"date": "18-06-2026", "equity_gross_purchase": 13328.7, "equity_gross_sales": 15135.29,
            "equity_net_investment": -1806.59}]
    dii = [{"date": "18-06-2026", "buy_value": 16163.18, "sell_value": 12646.37, "net_value": 3516.81}]
    rows = parse_tradebrains_rows(fii, dii)
    assert len(rows) == 1
    r = rows[0]
    assert r["date"] == "2026-06-18"          # DD-MM-YYYY -> YYYY-MM-DD
    assert r["fii_net"] == -1806.59 and r["fii_buy"] == 13328.7 and r["fii_sell"] == 15135.29
    assert r["dii_net"] == 3516.81 and r["dii_buy"] == 16163.18 and r["dii_sell"] == 12646.37


def test_dii_only_date_still_emitted_with_null_fii():
    rows = parse_tradebrains_rows([], [{"date": "01-11-2023", "buy_value": 100.0, "sell_value": 90.0, "net_value": 10.0}])
    assert len(rows) == 1
    assert rows[0]["date"] == "2023-11-01" and rows[0]["dii_net"] == 10.0 and rows[0]["fii_net"] is None
