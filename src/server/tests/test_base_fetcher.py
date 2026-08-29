"""
Unit tests for BaseFetcher, DomainGovernor, CircuitBreakerOpen, and DLQ recording.
"""

import pytest
from pydantic import BaseModel
from base_fetcher import BaseFetcher, CircuitBreakerOpen, DomainGovernor, record_dlq


class StockItemSchema(BaseModel):
    symbol: str
    price: float
    grade: str | None = None


class SampleFetcher(BaseFetcher[StockItemSchema]):
    fetcher_name = "SampleFetcher"
    domain = "testdomain.com"
    schema = StockItemSchema


def test_base_fetcher_validation():
    fetcher = SampleFetcher()

    valid_dict = {"symbol": "INFY", "price": 1420.0, "grade": "Bullish"}
    validated = fetcher.validate_item(valid_dict)
    assert validated is not None
    assert validated.symbol == "INFY"

    invalid_dict = {"symbol": "INFY", "price": "not_a_number"}
    failed = fetcher.validate_item(invalid_dict)
    assert failed is None

from base_fetcher import governed_fetcher

def test_governed_fetcher_decorator():
    calls = 0

    @governed_fetcher(domain="decoratortest.com", fetcher_name="TestFetcher", min_interval_sec=0.01)
    def sample_fetch(sym: str):
        nonlocal calls
        calls += 1
        return {"symbol": sym, "status": "ok"}

    res = sample_fetch("TATA")
    assert res["symbol"] == "TATA"
    assert calls == 1


def test_circuit_breaker_tripping():
    gov = DomainGovernor.get("blockeddomain.com", min_interval_sec=0.01)
    gov.circuit_open_until = 0.0  # reset

    # Record 5 errors
    for _ in range(5):
        gov.record_error(status_code=429)

    with pytest.raises(CircuitBreakerOpen):
        gov.acquire()
