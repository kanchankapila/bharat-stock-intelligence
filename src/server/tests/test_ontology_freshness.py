from datetime import datetime, timezone

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
