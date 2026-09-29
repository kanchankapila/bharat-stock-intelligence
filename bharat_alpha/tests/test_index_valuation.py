import datetime as dt

import numpy as np
import pytest

IDX_HEADER = "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n"


def index_csv(on: dt.date, close: float, pe: float, vix: float) -> str:
    d = on.strftime("%d-%m-%Y")
    return (IDX_HEADER
            + f"NIFTY 500,{d},{close},{close},{close},{close},0,0,0,0,{pe},3.5,1.2\n"
            + f"INDIA VIX,{d},{vix},{vix},{vix},{vix},0,0,0,0,-,-,-\n")


def test_index_pe_percentile_uses_only_the_history_available_at_the_time(conn):
    """NSE publishes the index P/E daily and it was stored but never read. Its level is not
    comparable across regimes, so the feature is its own trailing percentile — which must never
    see a later valuation."""
    from bharat_alpha.db import read_df
    from bharat_alpha.features import PE_MIN_OBS, market_context
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_market import NseIndexClose
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    n = PE_MIN_OBS + 60
    sim = simulate(n_stocks=6, n_days=n, seed=37)
    # P/E climbs steadily, then spikes on the last session: the spike must rank top, and the
    # sessions before it must not know about it
    pes = [15.0 + 0.01 * i for i in range(n)]
    pes[-1] = 40.0
    for i, d in enumerate(sim.dates):
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
        assert run_connector(conn, NseIndexClose(), d, raw=index_csv(d, 20000 + i, pes[i], 13.0))[0] == "success"
    conn.commit()
    stored = read_df(conn, "SELECT pe FROM alpha.index_daily WHERE index_name='NIFTY 500' ORDER BY trade_date")
    assert stored.pe.iloc[-1] == pytest.approx(40.0) and stored.pe.notna().all()

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    ctx = market_context(conn, p)
    pct = ctx["n500_pe_pctile"]
    assert np.isnan(pct.iloc[PE_MIN_OBS - 2])                          # too little history to rank
    assert not np.isnan(pct.iloc[PE_MIN_OBS - 1])
    assert pct.iloc[-1] == pytest.approx(1.0)                          # the spike is the highest yet
    # the session before the spike is near the top of ITS OWN history, not demoted by what follows
    assert pct.iloc[-2] == pytest.approx(1.0)
    assert "n500_pe" not in ctx and "n500_pe_chg_63" not in ctx   # the level is the thing that is not comparable


def test_a_missing_or_zero_pe_is_unknown_not_a_valuation(conn):
    """NSE prints '-' for an index with no P/E; a 0 would rank as the cheapest market on record."""
    from bharat_alpha.db import read_df
    from bharat_alpha.features import PE_MIN_OBS, market_context
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.nse_market import NseIndexClose
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    n = PE_MIN_OBS + 30
    sim = simulate(n_stocks=6, n_days=n, seed=41)
    for i, d in enumerate(sim.dates):
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
        pe = "0" if i == n - 3 else ("-" if i == n - 2 else "18.0")
        raw = index_csv(d, 20000 + i, 18.0, 13.0).replace(",18.0,3.5,1.2", f",{pe},3.5,1.2")
        run_connector(conn, NseIndexClose(), d, raw=raw)
    conn.commit()
    pes = read_df(conn, "SELECT trade_date, pe FROM alpha.index_daily WHERE index_name='NIFTY 500' ORDER BY trade_date")
    assert pes.pe.iloc[-2] is None or np.isnan(pes.pe.iloc[-2])        # '-' stored as unknown

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    ctx = market_context(conn, p)
    # a session whose P/E is 0 or '-' has no rank at all; a 0 must never read as the cheapest ever
    assert np.isnan(ctx["n500_pe_pctile"].iloc[-3]) and np.isnan(ctx["n500_pe_pctile"].iloc[-2])
    assert ctx["n500_pe_pctile"].iloc[-1] > 0
