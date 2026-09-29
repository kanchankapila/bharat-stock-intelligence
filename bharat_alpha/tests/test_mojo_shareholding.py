import datetime as dt

import pytest

from bharat_alpha.ingest.sources.mojo_shareholding import parse_shareholding, quarter_end, slug


def payload(blocks: list) -> dict:
    return {"code": "200", "data": {"shareholding_graphs": {"data": blocks}}}


def series(points: list[tuple[int, float]]) -> list[dict]:
    return [{"name": ym, "y": v} for ym, v in points]


def test_quarter_end_and_slug():
    assert quarter_end(202506) == dt.date(2025, 6, 30) and quarter_end(202512) == dt.date(2025, 12, 31)
    assert quarter_end(202513) is None and quarter_end("x") is None and quarter_end(None) is None
    assert slug("Shareholding - FII Holdings") == "fii_holdings"


def test_the_promoter_block_nests_two_series_every_other_block_is_flat():
    """The live shape (verified 2026-08-11): Promoter carries holding % then pledged % as nested
    series; FII and the rest carry a flat list of points."""
    p = payload([
        {"title": "Shareholding - Promoter Holding", "data": [series([(202503, 50.0), (202506, 51.0)]),
                                                              series([(202503, 5.0), (202506, 4.0)])]},
        {"title": "Shareholding - FII Holdings", "data": series([(202503, 12.0), (202506, 13.5)])},
    ])
    got = {(r["field"], r["period_end"]): r["value"] for r in parse_shareholding(p)}
    assert got == {
        ("own_promoter_holding_pct", dt.date(2025, 3, 31)): 50.0,
        ("own_promoter_holding_pct", dt.date(2025, 6, 30)): 51.0,
        ("own_promoter_pledged_pct", dt.date(2025, 3, 31)): 5.0,
        ("own_promoter_pledged_pct", dt.date(2025, 6, 30)): 4.0,
        ("own_fii_holdings_pct", dt.date(2025, 3, 31)): 12.0,
        ("own_fii_holdings_pct", dt.date(2025, 6, 30)): 13.5,
    }


@pytest.mark.parametrize("bad", [
    {"code": "500", "data": {}},
    {"code": "200", "data": {}},
    payload([{"title": "", "data": series([(202506, 10.0)])}]),
    payload([{"title": "Shareholding - FII Holdings", "data": series([(202506, 140.0)])}]),   # not a percentage
    payload([{"title": "Shareholding - FII Holdings", "data": series([(199012, None)])}]),
])
def test_unusable_payloads_yield_nothing_rather_than_a_guess(bad):
    assert parse_shareholding(bad) == []


def test_a_quarter_the_legacy_import_already_knows_is_never_restamped(conn):
    """The legacy table supplies history and this connector carries it forward. The first sighting
    of a (stock, field, quarter) wins across BOTH, so a re-run adds quarters and rewrites none."""
    from bharat_alpha.db import read_df, upsert
    from bharat_alpha.features import ownership_features
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.mojo_shareholding import SOURCE, MojoShareholding
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.ingest.sources.ownership import SOURCE as LEGACY, knowable_for
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=400, seed=23)
    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    conn.commit()
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM005'").iloc[0, 0])
    with conn.cursor() as cur:
        cur.execute("INSERT INTO alpha.provider_id(provider, provider_key, instrument_id, resolution) "
                    "VALUES ('marketsmojo', '229993', %s, 'manual')", (iid,))
    old_q, new_q = dt.date(2023, 3, 31), dt.date(2023, 6, 30)   # inside the simulated range
    # the legacy import already holds the March quarter, stamped by its own rule
    legacy_known = knowable_for(old_q, dt.date(2023, 4, 3))          # seen BEFORE the 21-day deadline
    assert upsert(conn, "alpha.fundamental", [{"source": LEGACY, "instrument_id": iid,
                                               "field": "own_promoter_holding_pct", "period_end": old_q,
                                               "value": 50.0, "knowable_at": legacy_known}],
                  key=("source", "instrument_id", "field", "knowable_at"), update=()) == 1
    conn.commit()

    raw = {iid: payload([{"title": "Shareholding - Promoter Holding",
                          "data": [series([(202303, 99.0), (202306, 51.0)]),      # March value differs on purpose
                                   series([(202303, 5.0), (202306, 4.0)])]}])}
    c = MojoShareholding()
    on = sim.dates[-1]
    n = c.write(conn, c.parse(raw, on), on)
    conn.commit()
    assert n == 3                                                     # June holding + both pledge quarters

    rows = read_df(conn, """SELECT source, field, period_end, value, knowable_at FROM alpha.fundamental
                            WHERE instrument_id = %s AND field = 'own_promoter_holding_pct'
                            ORDER BY period_end""", (iid,))
    assert list(rows.source) == [LEGACY, SOURCE]                      # March stays legacy's, June is new
    assert list(rows.value) == [50.0, 51.0]                           # the 99.0 rewrite never happened
    assert rows.knowable_at[0] == legacy_known                        # and its stamp is untouched
    assert rows.knowable_at[1] == knowable_for(new_q, on)             # the new quarter uses the SEBI deadline

    # a second run adds nothing at all
    assert c.write(conn, c.parse(raw, on), on) == 0
    conn.commit()

    # both sources feed one ownership series, so the forward quarter reaches the features
    p = load_panel(conn, sim.dates[0], sim.dates[-1])
    f = ownership_features(conn, p)
    held = f["own_promoter_holding_pct"][iid]
    assert held.loc[str(sim.dates[-1])] == pytest.approx(51.0)
    assert f["own_promoter_holding_pct_qoq"][iid].loc[str(sim.dates[-1])] == pytest.approx(1.0)
