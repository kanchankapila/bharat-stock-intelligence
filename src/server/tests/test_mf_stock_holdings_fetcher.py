import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mf_stock_holdings_fetcher as mf


def _fund(shares, change, asset_date="31-05-2026"):
    return {"numberOfSharesHeld": shares, "changeInNumberOfShares": change, "assetDate": asset_date}


class TestAggregate:
    def test_net_accumulation_and_breakdown(self):
        rows = [_fund(1000, 100), _fund(500, -50), _fund(300, 0), _fund(200, 25)]
        agg = mf.aggregate(rows, total_records=481)
        assert agg["num_funds"] == 481                 # breadth from pagesummary, not page len
        assert agg["total_shares_held"] == 2000.0
        assert agg["net_change_shares"] == 75.0        # 100-50+0+25
        assert agg["funds_adding"] == 2
        assert agg["funds_trimming"] == 1
        # net % vs prior holding (2000-75=1925)
        assert agg["net_share_chg_pct"] == round(75.0 / 1925.0 * 100, 4)
        assert agg["as_of_date"] == "2026-05-31"

    def test_empty_returns_none(self):
        assert mf.aggregate([], total_records=0) is None
        assert mf.aggregate(None, total_records=0) is None

    def test_na_fields_are_ignored_not_crash(self):
        rows = [_fund("NA", "NA"), _fund(1000, 100)]
        agg = mf.aggregate(rows, total_records=2)
        assert agg["total_shares_held"] == 1000.0
        assert agg["net_change_shares"] == 100.0

    def test_as_of_date_picks_latest(self):
        rows = [_fund(10, 1, "30-04-2026"), _fund(10, 1, "31-05-2026")]
        assert mf.aggregate(rows, 2)["as_of_date"] == "2026-05-31"


class TestFloor:
    def test_floor_is_disclosure_date_plus_lag(self):
        from datetime import date, timedelta
        expected = (date(2026, 5, 31) + timedelta(days=mf.MF_DISCLOSURE_LAG_DAYS)).isoformat()
        assert mf._floor("2026-05-31") == expected

    def test_floor_after_as_of(self):
        assert mf._floor("2026-05-31") > "2026-05-31"

    def test_unknown_falls_back_to_today(self):
        from datetime import date
        assert mf._floor(None) == date.today().isoformat()
