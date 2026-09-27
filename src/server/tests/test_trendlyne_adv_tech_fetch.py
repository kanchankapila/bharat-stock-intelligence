"""Regression tests for the Trendlyne TA request contract.

The endpoint registry and a live probe verify that advanced technical analysis is a GET.
A bare 405 is Trendlyne's WAF/allowance refusal, not a method mismatch; the fetcher must fail
fast and return the allowance sentinel rather than retrying the same blocked request three times.
"""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from fetch_utils import WAF_BLOCKED  # noqa: E402
from trendlyne_adv_tech_fetcher import fetch_adv_tech  # noqa: E402


class _BlockedResponse:
    status_code = 405
    headers: dict[str, str] = {}

    def raise_for_status(self):
        exc = requests.HTTPError("HTTP 405")
        exc.response = self
        raise exc


class _BlockedSession:
    def __init__(self):
        self.calls = 0

    def get(self, *_args, **_kwargs):
        self.calls += 1
        return _BlockedResponse()


def test_bare_405_is_terminal_and_not_retried():
    session = _BlockedSession()
    assert fetch_adv_tech("175", session) is WAF_BLOCKED
    assert session.calls == 1
