"""nse_corporate_announcements_fetcher against filings captured live 2026-11-20 (18-19 Nov 2026; AF-20261120-01)."""
import datetime as dt
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import nse_corporate_announcements_fetcher as na  # noqa: E402
from nse_filings_common import NseFetchError  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "nse_announcements", "corporate_announcements_18_19112026.json")


def _payload():
    with open(FIX, encoding="utf-8") as f:
        return json.load(f)


def test_filings_parse_with_exchange_category_and_ist_dissemination_time():
    rows = na.parse(_payload())
    assert len(rows) == len({r["seq_id"] for r in rows}) == len(_payload())
    assert all(r["disseminated_at"].utcoffset() == dt.timedelta(hours=5, minutes=30) for r in rows)
    assert all(r["symbol"] and r["symbol"] == r["symbol"].upper() for r in rows)
    cats = {r["category"] for r in rows}
    assert "Bagging/Receiving of orders/contracts" in cats and "Acquisition" in cats
    urbanco = next(r for r in rows if r["seq_id"] == "106866870")
    assert urbanco["symbol"] == "URBANCO" and urbanco["category"] == "Allotment of Securities"
    assert urbanco["disseminated_at"] == dt.datetime(2026, 11, 19, 23, 50, 6, tzinfo=na.IST)


def test_a_filing_without_an_id_or_time_is_refused_not_stored():
    bad = _payload()[:1]
    bad[0] = dict(bad[0], seq_id="")
    with pytest.raises(NseFetchError):
        na.parse(bad)
    with pytest.raises(NseFetchError):
        na.parse({"unexpected": "shape"})


def test_upsert_is_keyed_on_seq_id(pg_conn):
    na.ensure_schema(pg_conn)
    rows = na.parse(_payload())
    na.upsert(pg_conn, rows)
    na.upsert(pg_conn, rows)
    assert pg_conn.execute(f"SELECT count(*) FROM {na.TABLE}").fetchone()[0] == len(rows)
    got = pg_conn.execute(f"SELECT symbol, category FROM {na.TABLE} WHERE seq_id = '106866870'").fetchone()
    assert tuple(got) == ("URBANCO", "Allotment of Securities")
