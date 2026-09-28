import datetime as dt

import numpy as np
import pytest

from bharat_alpha.options import black76, implied_vol, summarise, year_fraction

HEADER = ("TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,"
          "OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,"
          "ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n")


def smile(K, F, level=0.30):
    return level + 0.5 * (1 - K / F)          # linear in strike: put wing richer, as in Indian single stocks


def chain(sym, td, xp, F, spot, strikes, poison_itm=True, stale=None, level=0.30):
    """Option rows priced off `smile`. ITM closes are poisoned and an untraded strike carries a
    stale price: a correct summary must ignore both."""
    T = year_fraction(td, xp)
    rows = []
    for K in strikes:
        for call in (True, False):
            px = black76(F, K, T, smile(K, F, level), call)
            itm = (K < F) if call else (K > F)
            vol = 100.0
            if itm and poison_itm:
                px *= 1.5
            if stale is not None and K == stale:
                px, vol = px * 3, 0.0
            rows.append({"symbol": sym, "trade_date": td, "expiry": xp, "strike": float(K), "call": call,
                         "close": px, "underlying": spot, "open_interest": 1000.0 if call else 1500.0,
                         "volume": vol})
    return rows


def test_implied_vol_round_trips_and_rejects_impossible_prices():
    for F, K, T, s, call in [(100, 100, 0.08, 0.25, True), (100, 90, 0.2, 0.45, False),
                             (2500, 2700, 0.05, 0.18, True), (50, 40, 0.5, 0.9, False)]:
        assert implied_vol(black76(F, K, T, s, call), F, K, T, call) == pytest.approx(s, abs=1e-5)
    assert implied_vol(5.0, 100, 90, 0.1, True) is None            # below the call's intrinsic value
    assert implied_vol(0.0, 100, 100, 0.1, True) is None


def test_summary_uses_traded_otm_options_off_the_forward():
    td, xp = dt.date(2026, 7, 29), dt.date(2026, 8, 27)
    F, spot = 1012.0, 1005.0
    strikes = np.arange(900, 1130, 20)
    rows = chain("ABC", td, xp, F, spot, strikes, stale=1040)
    (s,) = summarise(rows, {("ABC", xp): F})
    assert s["forward"] == F
    assert s["atm_iv"] == pytest.approx(smile(F, F), abs=2e-4)                       # interpolated to F
    assert s["skew"] == pytest.approx(smile(960, F) - smile(1060, F), abs=2e-4)      # nearest 0.95F / 1.05F
    assert s["put_oi"] == 1500 * len(strikes) and s["call_oi"] == 1000 * len(strikes)
    assert s["n_traded"] == len(strikes) - 1                  # one OTM side per strike, minus the stale one

    # without a future, the forward comes from the underlying at the risk-free rate
    (s2,) = summarise(rows, {})
    assert s2["forward"] == pytest.approx(spot * np.exp(0.065 * year_fraction(td, xp)))


def test_fo_bhavcopy_writes_option_summary_and_features_roll_past_expiry_week(conn):
    import pandas as pd

    from bharat_alpha.db import read_df
    from bharat_alpha.features import option_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_fo import NseFoBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=30, seed=3)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    td = sim.dates[-1]
    near, far = td + dt.timedelta(days=3), td + dt.timedelta(days=31)
    lines = [HEADER]
    for xp, F, lvl in ((near, 1001.0, 0.60), (far, 1006.0, 0.30)):
        lines.append(f"{td},{td},FO,NSE,STF,1,,SIM002,,{xp},{xp},,,X,1,1,1,{F},{F},1,1000,{F},5000,1,10,0,0,F1,500,,,,,\n")
        for r in chain("SIM002", td, xp, F, 1000.0, np.arange(900, 1110, 20), level=lvl):
            lines.append(f"{td},{td},FO,NSE,STO,2,,SIM002,,{xp},{xp},{r['strike']},{'CE' if r['call'] else 'PE'},X,"
                         f"1,1,1,{r['close']:.4f},1,1,1000,{r['close']:.4f},{r['open_interest']},0,{r['volume']},0,0,F1,500,,,,,\n")
    status, n = run_connector(conn, NseFoBhavcopy(), td, raw="".join(lines))
    assert status == "success" and n == 4                             # 2 futures + 2 option summaries
    od = read_df(conn, "SELECT expiry, atm_iv FROM alpha.option_daily ORDER BY expiry")
    assert list(od.expiry) == [near, far]

    p = load_panel(conn, sim.dates[0], td)
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM002'").iloc[0, 0])
    f = option_features(conn, p)
    t = pd.Timestamp(td)
    assert f["opt_iv_atm"].loc[t, iid] == pytest.approx(smile(1006.0, 1006.0), abs=2e-4)   # 3-day expiry skipped
    assert np.isnan(f["opt_iv_term"].loc[t, iid])                                            # no second live expiry
    assert f["opt_pcr_oi"].loc[t, iid] == pytest.approx(np.log(1.5))
