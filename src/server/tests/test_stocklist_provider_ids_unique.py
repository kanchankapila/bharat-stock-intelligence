"""AF-20261120-07: the static mapping carried another company's ids (KENNAMET held Dena Bank's
MoneyControl code, PREMIER held Premier Energies' ET companyid, DVR shares held the parent's
stockid), so fetchers booked one company's data under another. Each provider id names one
security; no two entries may share one."""
import json
import os
from collections import Counter

PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")
FIELDS = ("mcsymbol", "tlid", "stockid", "companyid", "tickertape_sid", "fincode", "scripcode", "isin")


def test_every_provider_id_names_one_entry():
    entries = json.load(open(PATH, encoding="utf-8-sig"))
    assert len(entries) > 2000
    symbols = Counter(e["symbol"] for e in entries)
    assert [s for s, n in symbols.items() if n > 1] == []
    for field in FIELDS:
        vals = Counter(str(e[field]).strip().upper() for e in entries if e.get(field) not in (None, "", 0))
        assert len(vals) > 1000, field
        assert sorted(v for v, n in vals.items() if n > 1) == [], field
