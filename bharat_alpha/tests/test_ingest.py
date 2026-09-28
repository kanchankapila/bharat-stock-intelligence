import datetime as dt

import pytest

from bharat_alpha.db import read_df
from bharat_alpha.ingest.base import NotPublished, run_connector
from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy, parse_bhavcopy
from bharat_alpha.ingest.sources.nse_corporate import (
    NseSymbolChange, parse_board_meetings, parse_pit, parse_symbol_changes,
)
from bharat_alpha.ingest.sources.nse_fo import parse_fo_csv
from bharat_alpha.ingest.sources.nse_market import NseFiiDii, NseIndexClose, parse_fii_dii, parse_index_close
from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars, load_panel
from bharat_alpha.sim import simulate

# Real NSE header + rows including the space padding NSE emits.
SAMPLE = (
    "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, "
    "CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\n"
    "RELIANCE, EQ, 29-Jul-2026, 1400.00, 1405.00, 1420.00, 1398.00, 1415.00, 1416.50, "
    "1410.25, 5000000, 70512.50, 120000, 2500000, 50.00\n"
    "1018GS2026, GS, 29-Jul-2026, 104.05, 104.35, 104.40, 103.35, 103.40, 103.40, 104.36, "
    "3223, 3.36, 9, 3223, 100.00\n"
    "NEWCO, BE, 29-Jul-2026, 10.00, 10.10, 10.50, 9.90, 10.20, 10.30, 10.15, 1000, 0.10, 5, -, -\n"
)


def test_parse_bhavcopy_strips_padding_filters_series_and_keeps_nulls_null():
    rows = {r["symbol"]: r for r in parse_bhavcopy(SAMPLE)}
    assert set(rows) == {"RELIANCE", "NEWCO"}
    assert rows["RELIANCE"]["trade_date"] == dt.date(2026, 7, 29)
    assert rows["RELIANCE"]["close"] == 1416.5 and isinstance(rows["RELIANCE"]["volume"], float)
    assert rows["NEWCO"]["deliv_pct"] is None          # '-' is unknown, not 0


def test_bhavcopy_rejects_file_for_wrong_date():
    with pytest.raises(ValueError):
        NseBhavcopy().parse(SAMPLE, dt.date(2026, 7, 30))


def test_run_ledger_records_success_empty_and_not_published(conn):
    d = dt.date(2026, 7, 29)
    status, n = run_connector(conn, NseBhavcopy(), d, raw=SAMPLE)
    assert (status, n) == ("success", 2)
    header_only = SAMPLE.splitlines()[0] + "\n"
    assert run_connector(conn, NseBhavcopy(), d, raw=header_only)[0] == "empty"

    class Holiday(NseBhavcopy):
        def fetch(self, client, on):
            raise NotPublished("holiday")

    assert run_connector(conn, Holiday(), dt.date(2026, 8, 15), client=object())[0] == "not_published"
    runs = read_df(conn, "SELECT status FROM alpha.ingest_run ORDER BY run_id")
    assert list(runs.status) == ["success", "empty", "not_published"]
    bar = read_df(conn, "SELECT turnover_inr, deliv_pct FROM alpha.daily_bar b JOIN alpha.symbol_history s "
                        "USING (instrument_id) WHERE s.symbol='RELIANCE'")
    assert bar.turnover_inr[0] == pytest.approx(70512.50 * 1e5)


def test_parse_fo_index_flows_and_corporate_payloads():
    fo = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,"
          "OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,"
          "ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n"
          "2026-07-29,2026-07-29,FO,NSE,STF,1,,RELIANCE,,2026-08-28,2026-08-28,,,RELIANCE26AUGFUT,1410,1425,1402,"
          "1421.5,1421,1405,1416.5,1421.5,25000000,500000,12000,0,0,F1,500,,,,,\n"
          "2026-07-29,2026-07-29,FO,NSE,STO,2,,RELIANCE,,2026-08-28,2026-08-28,1500,CE,X,1,1,1,1,1,1,1416.5,1,10,1,1,0,0,F1,500,,,,,\n")
    rows = parse_fo_csv(fo)
    assert len(rows) == 1 and rows[0]["open_interest"] == 25_000_000 and rows[0]["underlying"] == 1416.5

    idx = parse_index_close(
        "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,"
        "Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n"
        "Nifty 50,29-07-2026,24800,24950,24700,24900.5,100,0.4,1,1,22.5,3.6,1.3\n"
        "India VIX,29-07-2026,13.1,13.9,12.8,13.4,0.2,1.5,-,-,-,-,-\n")
    assert {r["index_name"] for r in idx} == {"NIFTY 50", "INDIA VIX"}
    assert next(r for r in idx if r["index_name"] == "INDIA VIX")["pe"] is None

    fl = parse_fii_dii([{"category": "FII/FPI *", "date": "29-Jul-2026", "buyValue": "1,234.5", "sellValue": "1000",
                         "netValue": "234.5"}, {"category": "DII **", "date": "29-Jul-2026", "buyValue": 1,
                                                "sellValue": 2, "netValue": -1}])
    assert [(r["category"], r["net_cr"]) for r in fl] == [("FII", 234.5), ("DII", -1.0)]

    sc = parse_symbol_changes("SM_NAME,SM_KEY_SYMBOL,SM_NEW_SYMBOL,SM_APPLICABLE_FROM\nTata Motors,TATAMOTORS,TMPV,14-Oct-2025\n")
    assert sc == [{"old": "TATAMOTORS", "new": "TMPV", "effective": dt.date(2025, 10, 14)}]

    bm = parse_board_meetings([{"bm_symbol": "INFY", "bm_purpose": "Financial Results", "bm_date": "16-Oct-2026",
                                "bm_timestamp": "01-Oct-2026 17:02:11", "bm_desc": "x"}])
    assert bm[0]["event_type"] == "results" and bm[0]["knowable_at"].date() == dt.date(2026, 10, 1)

    pit = parse_pit({"data": [{"symbol": "ABC", "tdpTransactionType": "Buy", "date": "09-Sep-2026 18:00",
                               "acqfromDt": "03-Sep-2026", "secAcq": "1,000", "secVal": "50000",
                               "personCategory": "Promoters", "acqName": "X"}]})
    # knowable at DISCLOSURE (9th), traded on the 3rd
    assert pit[0]["trade_date"] == dt.date(2026, 9, 3) and pit[0]["knowable_at"].date() == dt.date(2026, 9, 9)
    assert pit[0]["price"] == 50.0


def _load_sim(conn, sim, days=None):
    for d in (days or sim.dates):
        assert run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])[0] == "success"
        run_connector(conn, NseIndexClose(), d, raw=sim.index_files[d])
        run_connector(conn, NseFiiDii(), d, raw=sim.fii_dii[d])
    run_connector(conn, NseSymbolChange(), sim.dates[-1], raw=sim.symbol_changes_csv)
    flag_suspect_bars(conn)
    derive_adjustments(conn)
    conn.commit()


def test_sim_ingest_split_rename_badprint_delist(conn):
    sim = simulate(n_stocks=12, n_days=320, seed=3)
    _load_sim(conn, sim)
    # split: exactly one adjustment, factor 0.5, on the ex-date
    adj = read_df(conn, "SELECT s.symbol, a.ex_date, a.factor FROM alpha.adjustment a JOIN alpha.symbol_history s "
                        "USING (instrument_id)")
    split_sym, split_day = sim.events["split"]
    assert list(adj.symbol) == [split_sym] and adj.factor[0] == pytest.approx(0.5, rel=1e-3)
    assert adj.ex_date[0] == split_day
    # bad print flagged, not deleted, and NOT misread as a corporate action
    bad = read_df(conn, "SELECT is_suspect, suspect_reason FROM alpha.daily_bar b JOIN alpha.symbol_history s "
                        "USING (instrument_id) WHERE s.symbol=%s AND trade_date=%s", sim.events["bad_print"])
    assert bool(bad.is_suspect[0]) and bad.suspect_reason[0] in ("close_outside_range", "implausible_move")
    # rename: one instrument spans both symbols
    old, new, eff = sim.events["rename"]
    ids = read_df(conn, "SELECT DISTINCT instrument_id FROM alpha.symbol_history WHERE symbol IN (%s,%s)", (old, new))
    assert len(ids) == 1
    n_bars = read_df(conn, "SELECT count(*) n FROM alpha.daily_bar WHERE instrument_id=%s", (int(ids.instrument_id[0]),))
    assert n_bars.n[0] == 320
    # adjusted panel: no artificial -50% return on the split day
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    sid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (split_sym,)).iloc[0, 0])
    r = p.close[sid].pct_change()
    assert abs(r.loc[str(split_day)]) < 0.2
    # delisted name is present before and absent after (survivorship-free universe)
    dsym, dday = sim.events["delist"]
    did = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (dsym,)).iloc[0, 0])
    assert p.traded[did].loc[: str(dday)].iloc[:-1].all() and not p.traded[did].loc[str(dday):].any()
