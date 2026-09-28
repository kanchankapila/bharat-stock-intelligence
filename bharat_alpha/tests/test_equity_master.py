import datetime as dt

import pytest

from bharat_alpha.ingest.sources.nse_equity_master import parse_equity_list

D0, D1, D2 = dt.date(2026, 1, 5), dt.date(2026, 3, 2), dt.date(2026, 6, 1)
HEADER = "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n"


def master(rows: list[tuple[str, str, str]]) -> str:
    return HEADER + "".join(f"{s},{n},EQ,05-JAN-2010,10,1,{i},10\n" for s, n, i in rows)


def _iid(conn, sym):
    from bharat_alpha.db import read_df
    return int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (sym,)).iloc[0, 0])


def test_parse_strips_padded_headers_and_requires_symbol_and_isin():
    rows = parse_equity_list(master([("ABC", "Abc Ltd", "INE000A01011")]))
    assert rows == [{"symbol": "ABC", "name": "Abc Ltd", "series": "EQ", "listing_date": dt.date(2010, 1, 5),
                     "isin": "INE000A01011", "face_value": 10.0}]
    with pytest.raises(ValueError):
        parse_equity_list("SYMBOL,NAME OF COMPANY\nABC,Abc Ltd\n")


def test_rename_merge_repoints_every_table_that_references_the_instrument(conn):
    """A merge used to repoint a hand-kept list of 6 tables; a row in any later table (external_fact,
    option_daily, fo_ban, ...) on the duplicate id made the DELETE fail its foreign key."""
    from bharat_alpha.db import read_df
    from bharat_alpha.reference import SymbolResolver, apply_symbol_change

    res = SymbolResolver(conn)
    old, new = res.resolve("OLDCO", D0), res.resolve("NEWCO", D1)
    with conn.cursor() as cur:
        cur.execute("""INSERT INTO alpha.external_fact(source, instrument_id, field, value, observed_date, knowable_at)
                       VALUES ('legacy:x', %s, 'f', 1.0, %s, now())""", (new, D1))
        cur.execute("INSERT INTO alpha.fo_ban_day VALUES (%s, 1, 'nse_fo_secban', now())", (D1,))
        cur.execute("INSERT INTO alpha.fo_ban VALUES (%s, %s)", (D1, new))
    assert apply_symbol_change(conn, "OLDCO", "NEWCO", D1) == old
    assert read_df(conn, "SELECT instrument_id FROM alpha.external_fact").instrument_id.tolist() == [old]
    assert read_df(conn, "SELECT instrument_id FROM alpha.fo_ban").instrument_id.tolist() == [old]
    assert read_df(conn, "SELECT count(*) n FROM alpha.instrument WHERE instrument_id=%s", (new,)).n[0] == 0


def test_master_attaches_isins_and_merges_a_rename_the_symbol_change_file_missed(conn):
    from bharat_alpha.db import read_df
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_equity_master import NseEquityMaster
    from bharat_alpha.reference import SymbolResolver

    res = SymbolResolver(conn)
    res.resolve("OLDCO", D0)
    res.resolve("OLDCO", D1 - dt.timedelta(days=1))
    res.resolve("NEWCO", D1)                                  # rename not in symbolchange.csv: a second id
    res.resolve("LIVE1", D0)
    res.resolve("LIVE2", D0)
    res.resolve("LIVE2", D2)
    conn.commit()
    # day 1: OLDCO still listed under its old symbol -> ISINs attach, nothing merges
    assert run_connector(conn, NseEquityMaster(), D1 - dt.timedelta(days=1),
                         raw=master([("OLDCO", "Old Co", "INE111A01011"), ("LIVE1", "Live One", "INE222A01011")]))[0] == "success"
    assert read_df(conn, "SELECT isin FROM alpha.instrument WHERE instrument_id=%s", (_iid(conn, "OLDCO"),))["isin"][0] == "INE111A01011"
    # later: the same ISIN now listed as NEWCO -> the two ids are one company, merged into the older
    st = run_connector(conn, NseEquityMaster(), D2,
                       raw=master([("NEWCO", "New Co", "INE111A01011"), ("LIVE1", "Live One", "INE222A01011"),
                                   ("LIVE2", "Live Two", "INE222A01011")]))
    assert st[0] == "success"
    ids = read_df(conn, "SELECT DISTINCT instrument_id FROM alpha.symbol_history WHERE symbol IN ('OLDCO','NEWCO')")
    assert len(ids) == 1
    hist = read_df(conn, "SELECT symbol, valid_from, valid_to FROM alpha.symbol_history WHERE instrument_id=%s ORDER BY valid_from",
                   (int(ids.instrument_id[0]),))
    assert hist.symbol.tolist() == ["OLDCO", "NEWCO"] and hist.valid_to[0] == D1 - dt.timedelta(days=1)
    # an ISIN claimed by two instruments that traded at the SAME time is a conflict: nothing is merged or moved
    assert _iid(conn, "LIVE1") != _iid(conn, "LIVE2")
    assert read_df(conn, "SELECT isin FROM alpha.instrument WHERE instrument_id=%s", (_iid(conn, "LIVE2"),))["isin"][0] is None


def test_constituents_never_steals_an_isin_another_instrument_holds(conn):
    from bharat_alpha.db import read_df
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_constituents import NseConstituents
    from bharat_alpha.reference import SymbolResolver

    res = SymbolResolver(conn)
    a = res.resolve("AAA", D0, isin="INE333A01011")
    b = res.resolve("BBB", D0)
    conn.commit()
    csv = "Company Name,Industry,Symbol,Series,ISIN Code\nB Ltd,Banks,BBB,EQ,INE333A01011\n"
    st = run_connector(conn, NseConstituents(), D0, raw=csv)
    assert st[0] == "success", read_df(conn, "SELECT detail FROM alpha.ingest_run ORDER BY run_id DESC LIMIT 1").detail[0]
    isins = read_df(conn, "SELECT instrument_id, isin, sector FROM alpha.instrument ORDER BY instrument_id")
    assert isins.set_index("instrument_id")["isin"].to_dict() == {a: "INE333A01011", b: None}
    assert isins.set_index("instrument_id").sector[b] == "Banks"
