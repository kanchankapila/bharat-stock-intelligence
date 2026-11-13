"""extra_endpoints_fetcher: Tapetide is one page request per stock, split into three stored payloads.

AF-20261107-09: the three api.tapetide.com routes 404/401, so tapetide_score / analyst_ratings /
forecasts now come from https://tapetide.com/stocks/{symbol}/__data.json. These tests pin the
fetch plan (one request per stock, not three), which scope stores what, how the page is split and
saved, and the request pacing.
"""
import json
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import extra_endpoints_fetcher as eef  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "tapetide_stocks_BEL__data.json")
PAGE = "https://tapetide.com/stocks/{symbol}/__data.json"


def ep(name, template):
    return SimpleNamespace(name=name, url_template=template)


class FakeCursor:
    def __init__(self):
        self.rows = []

    def execute(self, sql, params=()):
        if sql.strip().upper().startswith("INSERT"):
            self.rows.append(params)


def render(endpoint, stock):
    return endpoint.url_template.format(symbol=stock["symbol"])


TAPETIDE = [ep("tapetide_score", PAGE), ep("tapetide_analyst_ratings", PAGE), ep("tapetide_forecasts", PAGE)]
OTHER = ep("investsights_score", "https://investsights.in/api/v2/stocks/{symbol}/score?")


def test_one_page_request_per_stock_not_three():
    stocks = [{"symbol": "BEL"}, {"symbol": "TCS"}]
    tasks = eef.build_tasks(stocks, TAPETIDE + [OTHER], render=render)
    page_tasks = [t for t in tasks if t[1] == eef.TAPETIDE_PAGE_TASK]
    assert [(t[0], t[2]) for t in page_tasks] == [("BEL", PAGE.format(symbol="BEL")), ("TCS", PAGE.format(symbol="TCS"))]
    assert [t[0] for t in tasks if t[1] == "investsights_score"] == ["BEL", "TCS"]
    assert len(tasks) == 4


def test_no_tapetide_endpoint_selected_means_no_page_request():
    tasks = eef.build_tasks([{"symbol": "BEL"}], [OTHER], render=render)
    assert [t[1] for t in tasks] == ["investsights_score"]


def test_daily_fetches_the_page_and_weekly_does_not_fetch_it_again():
    parsed = {"tapetide_score", "investsights_score"}
    allep = TAPETIDE + [OTHER, ep("tickertape_financials_income", "https://x/{symbol}")]
    daily = [e.name for e in eef.apply_scope(allep, "daily", parsed)]
    weekly = [e.name for e in eef.apply_scope(allep, "weekly", parsed)]
    assert "tapetide_score" in daily and "tapetide_analyst_ratings" not in daily
    # the daily page fetch already stored analyst ratings and forecasts, so weekly must not re-fetch
    assert weekly == ["tickertape_financials_income"]
    assert [e.name for e in eef.apply_scope(allep, "all", parsed)] == [e.name for e in allep]


def test_saving_a_page_stores_the_three_payloads_under_their_old_endpoint_names():
    text = open(FIXTURE, encoding="utf-8").read()
    cur = FakeCursor()
    saved = eef.save_tapetide_page(cur, "BEL", text)
    assert sorted(saved) == ["tapetide_analyst_ratings", "tapetide_forecasts", "tapetide_score"]
    by_name = {params[1]: json.loads(params[2]) for params in cur.rows}
    assert by_name["tapetide_score"]["data"]["score"] == 53
    assert by_name["tapetide_score"]["meta"]["score_date"] == "2026-11-06"  # the score's own as-of date is kept
    assert by_name["tapetide_analyst_ratings"]["data"]["total_ratings"] == 30
    assert all(params[0] == "BEL" for params in cur.rows)


def test_a_page_for_another_stock_or_a_redirect_saves_nothing():
    text = open(FIXTURE, encoding="utf-8").read()
    cur = FakeCursor()
    with pytest.raises(ValueError):
        eef.save_tapetide_page(cur, "RELIANCE", text)
    with pytest.raises(Exception):
        eef.save_tapetide_page(cur, "BEL", '{"type":"redirect","location":"/stocks/XYZ"}')
    assert cur.rows == []


def test_tapetide_requests_are_spaced_but_other_hosts_are_not():
    clock = {"t": 100.0}
    slept = []

    def now():
        return clock["t"]

    def sleep(s):
        slept.append(round(s, 3))
        clock["t"] += s

    pacer = eef.HostPacer({"tapetide.com": 0.25}, now=now, sleep=sleep)
    pacer.wait("https://tapetide.com/stocks/BEL/__data.json")          # first: no wait
    pacer.wait("https://tapetide.com/stocks/TCS/__data.json")          # immediately after: waits the interval
    pacer.wait("https://investsights.in/api/v2/stocks/BEL/score?")     # other host: never waits
    clock["t"] += 1.0
    pacer.wait("https://tapetide.com/stocks/INFY/__data.json")         # long enough ago: no wait
    assert slept == [0.25]
