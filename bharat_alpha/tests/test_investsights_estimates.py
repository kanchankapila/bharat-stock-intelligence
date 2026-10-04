import datetime as dt
import json
from pathlib import Path

import numpy as np
import pytest

from bharat_alpha.ingest.sources.investsights_estimates import parse_is_estimates

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
PROBE = Path(__file__).resolve().parent / "fixtures" / "payload_probe.json"


def payload(sym: str, rows: list[tuple[str, float, float, int]]) -> dict:
    return {"success": True, "count": len(rows), "source": "fmp",
            "data": [{"symbol": f"{sym}.NS", "date": d, "epsAvg": e, "epsHigh": e, "epsLow": e, "revenueAvg": r,
                      "numAnalystsEps": n, "numAnalystsRevenue": n} for d, e, r, n in rows]}


def test_parse_matches_the_probed_payload_shape():
    """The probe captured the real response (truncated); its first row must parse as documented."""
    probe = json.loads(PROBE.read_text())
    items = probe if isinstance(probe, list) else next(v for v in probe.values() if isinstance(v, list))
    sample = next(i["sample"] for i in items if isinstance(i, dict)
                  and "WEBELSOLAR/analyst-estimates?period=annual" in i.get("url", ""))
    first = json.loads(sample[: sample.index("}, {") + 1] + "]}")          # the sample is cut mid-array
    rows = {r["field"]: r["value"] for r in parse_is_estimates("WEBELSOLAR", first)}
    assert rows == {"est_is_eps_fy2028": 11.4, "est_is_revenue_fy2028": 29166000000.0, "est_is_n_eps_fy2028": 1.0}


def test_parse_drops_rows_for_another_symbol_and_unavailable_payloads():
    p = payload("ABC", [("2027-03-31", 10.0, 1e9, 3)])
    p["data"].append({**p["data"][0], "symbol": "XYZ.NS", "date": "2028-03-31"})
    assert {r["field"] for r in parse_is_estimates("ABC", p)} == {"est_is_eps_fy2027", "est_is_revenue_fy2027",
                                                                   "est_is_n_eps_fy2027"}
    assert parse_is_estimates("ABC", {"success": True, "data": None, "available": False}) == []


def test_fy1_revision_compares_the_same_year_and_rolls_to_the_next_year(conn):
    from bharat_alpha.db import read_df
    from bharat_alpha.features import REVISION_WINDOW, fy_estimate_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.investsights_estimates import InvestsightsEstimates
    from bharat_alpha.ingest.sources.mc_estimates import write_estimates
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=260, seed=5)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    sym = "SIM005"                                            # untouched by the sim's planted events
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol=%s", (sym,)).iloc[0, 0])
    fy1_end = sim.dates[150]                                   # FY1 ends mid-sample, FY2 after it

    def at(i):
        return dt.datetime.combine(sim.dates[i], dt.time(18, 0), tzinfo=IST)

    def put(i, fy_end, eps):
        f = f"est_is_eps_fy{fy_end.year}"
        return {"instrument_id": iid, "field": f, "period_end": fy_end, "value": eps, "knowable_at": at(i)}

    fy2_end = dt.date(fy1_end.year + 1, fy1_end.month, fy1_end.day)
    rows = [put(0, fy1_end, 10.0), put(0, fy2_end, 20.0),     # FY1 10, FY2 20 (a rollover would read +100%)
            put(100, fy1_end, 11.0),                           # FY1 revised up 10%
            put(200, fy2_end, 19.0)]                           # FY2 revised down 5%
    assert write_estimates(conn, "investsights_estimates", rows) == 4
    conn.commit()
    # the connector's own writer stores only changes (same values again -> 0 rows)
    again = {sym: payload(sym, [(fy2_end.isoformat(), 19.0, 5e9, 2)])}
    conn.commit()
    assert InvestsightsEstimates(symbols=[sym]).write(conn, InvestsightsEstimates().parse(again, sim.dates[-1]), sim.dates[-1]) == 2
    assert InvestsightsEstimates(symbols=[sym]).write(conn, InvestsightsEstimates().parse(again, sim.dates[-1]), sim.dates[-1]) == 0
    conn.commit()

    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    rev = fy_estimate_features(conn, p)["est_is_eps_rev_fy1"][iid]
    ey = fy_estimate_features(conn, p)["est_is_fwd_ey_fy1"][iid]
    assert np.isnan(rev.loc[str(sim.dates[REVISION_WINDOW - 1])])          # no 63-session-old estimate yet
    assert rev.loc[str(sim.dates[99])] == 0.0                               # FY1 unrevised
    assert rev.loc[str(sim.dates[101])] == pytest.approx(0.10)              # FY1 10 -> 11
    # after FY1 ends, FY2 is FY1: its OWN history (20 -> 20), not a +100% jump from 11 to 20
    assert rev.loc[str(sim.dates[151])] == 0.0
    assert rev.loc[str(sim.dates[201])] == pytest.approx(-0.05)             # FY2 20 -> 19
    assert ey.loc[str(sim.dates[151])] == pytest.approx(20.0 / p.raw_close[iid].loc[str(sim.dates[151])])
