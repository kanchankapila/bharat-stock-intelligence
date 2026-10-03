"""trendlyne_overview_fetcher analyst parsing -- AF-20260930-47.

Trendlyne's overview-second-part returns each broker rating under `recoType` ("Buy"). The parser
read a key named `rec`, which never exists, so every report counted as "not a buy":
analyst_buy_pct was 0.0 for every covered stock (781/781 technical_signals rows) and
trendlyne_analyst_targets.rating was '' on all 529 rows. Row shape captured live 2026-10-02.
"""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import trendlyne_overview_fetcher as t


def _row(rec_type, days_ago=30, broker="BOB Capital Markets Ltd."):
    row = {
        "recoDate": (date.today() - timedelta(days=days_ago)).isoformat(), "postAuthor": broker,
        "targetPrice": 30839.0, "recoPrice": 25945.0, "upside": 18.86, "changeSinceReco": 3.45,
        "pdfUrl": "https://trendlyne.com/get-document/report/pdf/100102/", "insights": [],
    }
    if rec_type is not None:
        row["recoType"] = rec_type
    return row


def _body(*rows):
    return {"researchReports": {"tableHeader": [], "tableData": list(rows)}}


def test_buy_ratings_are_read_from_recoType():
    out = t.extract_analyst_data(_body(_row("Buy"), _row("Buy"), _row("Hold"), _row("Sell"), _row("Sell")), "X", "d")
    assert out["analyst_buy_pct"] == 40.0
    assert out["analyst_count"] == 5


def test_all_buy_is_100_not_0():
    out = t.extract_analyst_data(_body(_row("Buy"), _row("Strong Buy")), "X", "d")
    assert out["analyst_buy_pct"] == 100.0


def test_no_rating_at_all_is_null_never_zero():
    # A report without a rating says nothing about buy vs not-buy; 0.0 would claim "0% buy".
    out = t.extract_analyst_data(_body(_row(None), _row(None)), "X", "d")
    assert out["analyst_buy_pct"] is None
    assert out["analyst_count"] == 2


def test_an_unrated_report_does_not_dilute_the_rated_ones():
    out = t.extract_analyst_data(_body(_row("Buy"), _row(None)), "X", "d")
    assert out["analyst_buy_pct"] == 100.0


def test_unrecognised_label_counts_as_not_buy_and_is_reported_once(capsys):
    t._WARNED_RATINGS.clear()
    out = t.extract_analyst_data(_body(_row("Buy"), _row("Zzz Rating"), _row("Zzz Rating")), "X", "d")
    assert out["analyst_buy_pct"] == round(100 / 3, 1)
    assert capsys.readouterr().err.count("ZZZ RATING") == 1  # labels are normalised to upper case


def test_persisted_rating_is_recoType():
    calls = []

    class Cur:
        def execute(self, sql, params):
            calls.append(params)

    class Con:
        def cursor(self):
            return Cur()

        def commit(self):
            pass

    t.write_analyst_targets("X", [_row("Buy"), _row("Hold", broker="Other")], "2026-10-02", Con())
    assert [c[5] for c in calls] == ["Buy", "Hold"]
