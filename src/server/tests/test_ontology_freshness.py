from datetime import datetime, timedelta, timezone

from ontology.introspect import _freshness_probe


class _Result:
    def __init__(self, value):
        self.value = value

    def fetchone(self):
        return {"v": self.value}


class _Conn:
    def __init__(self, value):
        self.value = value

    def execute(self, _sql):
        return _Result(self.value)


def test_current_date_freshness_age_is_zero_not_negative_future_time():
    today = datetime.now(timezone.utc).date().isoformat()
    result = _freshness_probe(_Conn(today), "stock_ohlcv", "date", 48, "date")
    assert result["age_hours"] == 0
    assert result["verdict"] == "fresh"


def test_future_timestamp_is_flagged_as_clock_skew_not_negative_age():
    future = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
    result = _freshness_probe(_Conn(future), "market_breadth", "computed_at", None, "text")
    assert result["age_hours"] == 0
    assert result["verdict"] == "future"
    assert result["clock_skew_hours"] >= 2.9
