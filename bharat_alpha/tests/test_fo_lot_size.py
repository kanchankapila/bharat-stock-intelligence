import datetime as dt

import numpy as np
import pytest

from bharat_alpha.ingest.sources.nse_fo import parse_fo_csv

HEADER = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,"
          "OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,"
          "ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n")


def fut(day: dt.date, expiry: dt.date, sym: str, px: float, oi: float, lot) -> str:
    return (f"{day},{day},FO,NSE,STF,1,,{sym},,{expiry},{expiry},,,{sym}FUT,{px},{px},{px},{px},{px},{px},"
            f"{px},{px},{oi},0,1000,1,0,F1,{'' if lot is None else lot},,,,,\n")


def test_parse_reads_the_contract_lot():
    rows = parse_fo_csv(HEADER + fut(dt.date(2026, 7, 29), dt.date(2026, 8, 28), "RELIANCE", 1400, 25_000, 500))
    assert rows[0]["lot_size"] == 500 and rows[0]["open_interest"] == 25_000
    blank = parse_fo_csv(HEADER + fut(dt.date(2026, 7, 29), dt.date(2026, 8, 28), "RELIANCE", 1400, 25_000, None))
    assert blank[0]["lot_size"] is None


def test_a_lot_revision_is_not_an_open_interest_change(conn):
    """NSE halves the lot, so the contract count doubles with the same shares open. On contracts
    that reads as +100%; the feature must read ~0 and the days-of-ADT level must not move."""
    from bharat_alpha.db import read_df
    from bharat_alpha.features import _rolling_mean, fo_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_fo import NseFoBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=60, seed=11)
    sym, other = "SIM005", "SIM006"          # SIM000-4 carry the sim's planted events; SIM007 is the illiquid one
    revision = 40                                     # the session the lot halves
    expiry = sim.dates[-1] + dt.timedelta(days=20)
    for i, d in enumerate(sim.dates):
        assert run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])[0] == "success"
        lot, contracts = (1000, 300) if i < revision else (500, 600)      # 300_000 shares open throughout
        raw = HEADER + fut(d, expiry, sym, 100.0, contracts, lot) + fut(d, expiry, other, 50.0, 200, None)
        assert run_connector(conn, NseFoBhavcopy(), d, raw=raw)[0] == "success"
    conn.commit()
    assert set(read_df(conn, "SELECT DISTINCT lot_size FROM alpha.fo_daily").lot_size.dropna()) == {1000.0, 500.0}

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    f = fo_features(conn, p)
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (sym,)).iloc[0, 0])
    oid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (other,)).iloc[0, 0])
    chg = f["fo_oi_chg_5"][iid]
    assert chg.loc[str(sim.dates[revision + 1])] == pytest.approx(0.0)      # the revision itself
    assert chg.loc[str(sim.dates[revision + 4])] == pytest.approx(0.0)      # still inside the 5-session window
    assert chg.dropna().abs().max() == pytest.approx(0.0)

    # days-of-ADT moves with ADT day to day; what it must NOT do is step by the lot factor
    days_adt = f["fo_oi_days_adt"][iid]
    adt = _rolling_mean(p.volume, 20)[iid]
    for i in (revision - 1, revision, revision + 1):
        d = str(sim.dates[i])
        assert days_adt.loc[d] == pytest.approx(np.log1p(300_000 / adt.loc[d]))
    step = days_adt.diff().loc[str(sim.dates[revision])]
    assert abs(step) < 0.1 and abs(step) < abs(np.log(2)) / 2     # a doubling would show as ~log(2)

    # a contract whose lot the exchange did not publish has UNKNOWN exposure, never a contract count
    assert f["fo_oi_days_adt"][oid].isna().all() and f["fo_oi_chg_5"][oid].isna().all()
    assert f["fo_listed"][oid].loc[str(sim.dates[revision])] == 1.0       # but it is still listed
