"""
Tests for ingress_governor (retryable_fetcher and validate_payload).
"""

import pytest
from pydantic import BaseModel
import requests
from ingress_governor import retryable_fetcher, validate_payload


class SampleStockPayload(BaseModel):
    symbol: str
    price: float
    grade: str | None = None


def test_validate_payload_valid():
    raw = {"symbol": "RELIANCE", "price": 2850.5, "grade": "Bullish"}
    validated = validate_payload(raw, SampleStockPayload)
    assert validated is not None
    assert validated.symbol == "RELIANCE"
    assert validated.price == 2850.5
    assert validated.grade == "Bullish"


def test_validate_payload_invalid_returns_none():
    raw = {"symbol": "RELIANCE", "price": "invalid_number"}
    validated = validate_payload(raw, SampleStockPayload)
    assert validated is None


def test_retryable_fetcher_retries_on_network_error():
    attempts = 0

    @retryable_fetcher(max_attempts=3, min_wait_sec=0.01, max_wait_sec=0.05)
    def flaky_request():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise requests.RequestException("Temporary network timeout")
        return "success"

    result = flaky_request()
    assert result == "success"
    assert attempts == 3
