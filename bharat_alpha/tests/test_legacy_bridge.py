"""Ontology-driven legacy bridge: map safety, point-in-time import, evidence screen."""
import datetime as dt

import numpy as np
import pytest

from bharat_alpha.legacy import DEFAULT_ONTOLOGY_ROOT, SUPERSEDED, MapEntry, generate_map, load_ontology
from bharat_alpha.timeutil import IST

ONTOLOGY_PRESENT = (DEFAULT_ONTOLOGY_ROOT / "ontology" / "definitions").exists()


@pytest.mark.skipif(not ONTOLOGY_PRESENT, reason="legacy ontology lives in the parent repo")
def test_map_never_enables_labels_leaks_or_model_outputs():
    onto = load_ontology()
    entries = generate_map(onto)
    assert entries and any(e.enabled for e in entries)
    labels = {(c.table, col) for c in onto.cards for col in c.label_columns(onto)}
    for e in entries:
        card = next(c for c in onto.cards if c.table == e.table)
        prop = onto.property_by_name(next(b.property for b in onto.bindings_for_table(e.table) if b.column == e.column))
        assert prop.is_feature and not prop.is_label, e            # the ontology's own verdicts
        assert (e.table, e.column) not in labels
        assert card.training_use in ("allowed", "caution")
        assert e.column not in card.forbidden_columns
        if e.enabled:
            assert e.status == "ready" and e.derivation in ("raw", "vendor")
            assert e.table not in SUPERSEDED
            assert e.knowable.split(":")[0] in ("capture", "timestamp", "eod_plus")





def _ingest(conn, sim):
    from bharat_alpha.ingest.base import run_connector
    from bharat_alpha.ingest.sources.nse_bhavcopy import NseBhavcopy
    from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars

    for d in sim.dates:
        run_connector(conn, NseBhavcopy(), d, raw=sim.bhavcopies[d])
    flag_suspect_bars(conn)
    derive_adjustments(conn)
    conn.commit()


CAP = MapEntry("fake_capture", "val", "symbol", "date", "capture:captured_at", "raw", "allowed", "coincident",
               "ready", True, "")
EOD = MapEntry("fake_eod", "val", "symbol", "date", "eod_plus:5.0", "raw", "caution", "coincident", "ready", True, "")


def test_import_is_point_in_time_forward_only_and_change_only(conn, legacy_db):
    from bharat_alpha.db import read_df
    from bharat_alpha.legacy.importer import import_entries
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=6, n_days=12, seed=2)
    _ingest(conn, sim)
    d = sim.dates
    with legacy_db.cursor() as cur:
        cur.execute("CREATE TABLE fake_capture (symbol TEXT, date DATE, captured_at TIMESTAMPTZ, val DOUBLE PRECISION)")
        cur.execute("CREATE TABLE fake_eod (symbol TEXT, date DATE, val DOUBLE PRECISION)")
        for i, day in enumerate(d[:10]):
            # captured late in the evening -> usable from the NEXT session; same value repeats
            cur.execute("INSERT INTO fake_capture VALUES ('SIM005', %s, %s, %s)",
                        (day, dt.datetime.combine(day, dt.time(21, 0), tzinfo=IST), 1.0 if i < 5 else 2.0))
            cur.execute("INSERT INTO fake_eod VALUES ('SIM005', %s, %s)", (day, float(i)))
    legacy_db.commit()

    stats = import_entries(conn, legacy_db, [CAP, EOD])
    assert stats["fake_capture"]["facts_written"] == 2          # 1.0 then 2.0: change-only
    assert stats["fake_eod"]["facts_written"] == 0              # mutable table: forward-only by default
    facts = read_df(conn, "SELECT value, observed_date, knowable_at FROM alpha.external_fact WHERE source='legacy:fake_capture' "
                          "ORDER BY knowable_at")
    assert facts.knowable_at[0].astimezone(IST).hour == 21      # capture time, not the date
    hist = import_entries(conn, legacy_db, [EOD], allow_history=True)
    assert hist["fake_eod"]["facts_written"] == 10
    k = read_df(conn, "SELECT knowable_at FROM alpha.external_fact WHERE source='legacy:fake_eod' ORDER BY 1 LIMIT 1").knowable_at[0]
    assert k.astimezone(IST).time() == dt.time(20, 30)           # 15:30 close + 5h lag

    # as-of panel: a value captured at 21:00 on day i is first usable on day i+1
    from bharat_alpha.legacy.screen import external_panels
    from bharat_alpha.marketdata import load_panel

    p = load_panel(conn, d[0], d[-1])
    iid = int(read_df(conn, "SELECT instrument_id FROM alpha.symbol_history WHERE symbol='SIM005'").iloc[0, 0])
    col = external_panels(conn, p)["x_fake_capture__val"][iid]
    assert np.isnan(col.loc[str(d[0])]) and col.loc[str(d[1])] == 1.0 and col.loc[str(d[6])] == 2.0


@pytest.mark.slow
def test_screen_admits_evidence_and_only_admitted_reach_features(conn, legacy_db, monkeypatch):
    from bharat_alpha.features import build_features
    from bharat_alpha.legacy.importer import import_entries
    from bharat_alpha.legacy.screen import screen
    from bharat_alpha.marketdata import load_panel
    from bharat_alpha.sim import simulate

    monkeypatch.setenv("BQA_MIN_HISTORY_DAYS", "20")
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    sim = simulate(n_stocks=80, n_days=260, signal_strength=2.0, seed=31)
    _ingest(conn, sim)
    rng = np.random.default_rng(0)
    good = MapEntry("fake_signal", "val", "symbol", "date", "capture:captured_at", "raw", "allowed", "coincident",
                    "ready", True, "")
    noise = MapEntry("fake_noise", "val", "symbol", "date", "capture:captured_at", "raw", "allowed", "coincident",
                     "ready", True, "")
    with legacy_db.cursor() as cur:
        for t in ("fake_signal", "fake_noise"):
            cur.execute(f"CREATE TABLE {t} (symbol TEXT, date DATE, captured_at TIMESTAMPTZ, val DOUBLE PRECISION)")
        rows_s, rows_n = [], []
        for day in sim.dates:
            cap = dt.datetime.combine(day, dt.time(18, 45), tzinfo=IST)
            for s in sim.alpha.columns:
                rows_s.append((s, day, cap, float(sim.alpha.loc[str(day), s])))
                rows_n.append((s, day, cap, float(rng.normal())))
        cur.executemany("INSERT INTO fake_signal VALUES (%s,%s,%s,%s)", rows_s)
        cur.executemany("INSERT INTO fake_noise VALUES (%s,%s,%s,%s)", rows_n)
    legacy_db.commit()
    import_entries(conn, legacy_db, [good, noise])
    res = screen(conn, sim.dates[0], sim.dates[-1], horizon=5).set_index("field")
    src = res.reset_index().set_index("source")
    assert bool(src.loc["legacy:fake_signal", "admitted"]) and not bool(src.loc["legacy:fake_noise", "admitted"])
    ff = build_features(conn, load_panel(conn, sim.dates[0], sim.dates[-1]))
    assert "x_fake_signal__val" in ff.stock_features and "x_fake_noise__val" not in ff.stock_features
    get_settings.cache_clear()



def test_screen_separates_never_measurable_from_measured_and_failed(conn):
    """A field absent from the whole screen window must NOT be reported as 'no evidence'.

    AF-20260929-09: all 38 imported legacy fields were rejected at `coverage 0% < 30%` because
    their history began 4.5 years AFTER the screen cutoff. `admitted=False` alone made that
    look like a merit verdict. The cutoff itself is correct -- moving it to meet the data would
    let feature selection see the test folds -- so the fix is in how the outcome is reported.
    """
    import datetime as dt

    from bharat_alpha.db import read_df
    from bharat_alpha.legacy.screen import screen
    from bharat_alpha.sim import simulate

    sim = simulate(n_stocks=8, n_days=40, seed=5)
    _ingest(conn, sim)
    dates = sim.dates

    iids = read_df(conn, "SELECT instrument_id FROM alpha.instrument ORDER BY 1").instrument_id.tolist()

    # One field present ONLY in the last two sessions -- i.e. after any sane screen window.
    with conn.cursor() as cur:
        for d in dates[-2:]:
            for i in iids:
                cur.execute(
                    "INSERT INTO alpha.external_fact (source, instrument_id, field, value, observed_date, knowable_at)"
                    " VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    ("legacy:late_table", i, "late_field", 1.0, d,
                     dt.datetime.combine(d, dt.time(20, 30), tzinfo=IST)))
    conn.commit()

    df = screen(conn, dates[0], dates[len(dates) // 2], horizon=5)
    late = df[df.field == "late_field"]
    assert len(late) == 1, df.field.tolist()
    row = late.iloc[0]
    assert not row.admitted
    assert row.verdict == "not_evaluable", (row.verdict, row.reason)
    assert row.verdict != "no_evidence"
    # Either not-evaluable branch is fine (no coverage, or no realised labels); what must never
    # happen is the wording that implies the field was measured and came up short.
    assert "no evidence" not in row.reason, row.reason
