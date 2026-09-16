"""AF-20260823-81: ic_tilted_weights / load_latest_engine_ics / gate precedence.

The tilt is the measured successor to the binary edge_adjusted_weights: it rescales each
engine's REGIME_WEIGHTS share by its own persisted 5d rank IC (clamped, evidence-gated),
because on live data every engine except dl grades 'no edge' at h=5 -- the binary rule
would reallocate weight toward LOW-DATA engines with no evidence at all.
"""
import sys, os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unified_ranker import (  # noqa: E402
    ENGINE_TILT_CLAMP,
    ic_tilted_weights,
    load_latest_engine_ics,
)
from pg_test_support import pg_memory_conn  # noqa: E402

BASE = {'technical': 0.4, 'dl': 0.3, 'confluence': 0.2, 'screener': 0.1}


def _ics(**kw):
    return {k: {'ic': v['ic'], 'dates': v.get('dates', 40)} for k, v in kw.items()}


# ── ic_tilted_weights: pure-function behavior ─────────────────────────────────

def test_no_evidence_is_identity():
    out, rep = ic_tilted_weights(BASE, {})
    assert out == BASE
    assert rep == {}


def test_low_date_counts_pass_through_untouched():
    est = {e: {'ic': 0.10, 'dates': 19} for e in BASE}
    out, rep = ic_tilted_weights(dict(BASE), est, min_dates=20)
    assert out == BASE and rep == {}


def test_positive_ic_upweights_negative_ic_drops_and_renormalizes():
    # technical strongly proven (multiplier pinned at the 1+clamp ceiling), confluence
    # shrunk hard but NOT to literal zero (that needs IC <= -1), screener mildly
    # negative, dl untouched by the estimate dict.
    est = _ics(technical={'ic': 0.75}, confluence={'ic': -0.90},
               screener={'ic': -0.05})
    raw = {}
    for e, w in BASE.items():
        if e == 'technical':
            m = 1 + ENGINE_TILT_CLAMP       # ceiling reached exactly
        elif e == 'confluence':
            m = 1 - 0.90                    # floor is 0, reached only when IC <= -1
        elif e == 'screener':
            m = 1 - 0.05
        else:
            m = 1.0
        raw[e] = w * m
    tot = sum(raw.values())
    expected = {e: w / tot * sum(BASE.values()) for e, w in raw.items()}
    out, rep = ic_tilted_weights(dict(BASE), est, min_dates=20, clamp=ENGINE_TILT_CLAMP)
    for e in BASE:
        assert out[e] == pytest.approx(expected[e], rel=1e-9)
    assert set(rep) == {'technical', 'confluence', 'screener'}
    assert rep['technical']['mult'] == pytest.approx(1 + ENGINE_TILT_CLAMP)


def test_ic_below_minus_one_drops_engine_entirely():
    est = _ics(confluence={'ic': -1.4})     # beyond the floor -> weight 0, never inverted
    out, rep = ic_tilted_weights(dict(BASE), est)
    assert out['confluence'] == pytest.approx(0.0)
    assert 'confluence' in rep and rep['confluence']['mult'] == pytest.approx(0.0)


def test_total_weight_preserved_after_renormalization():
    est = _ics(dl={'ic': 0.30}, technical={'ic': 0.02}, confluence={'ic': -0.20},
               screener={'ic': -0.01})
    out, _ = ic_tilted_weights(dict(BASE), est)
    assert sum(out.values()) == pytest.approx(sum(BASE.values()), rel=1e-9)


def test_clamp_bounds_the_multiplier():
    est = _ics(dl={'ic': 5.0})   # absurd IC must not dominate
    out, rep = ic_tilted_weights(dict(BASE), est)
    assert rep['dl']['mult'] == pytest.approx(1 + ENGINE_TILT_CLAMP)


def test_identity_returned_when_no_engine_qualifies():
    est = {e: {'ic': 0.10, 'dates': 5} for e in BASE}   # all under min_dates
    out, rep = ic_tilted_weights(dict(BASE), est)
    assert out == BASE and rep == {}


# ── load_latest_engine_ics: reads the latest graded run only ──────────────────

@pytest.fixture()
def graded_conn():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE factor_edge_history (
            run_at TEXT NOT NULL, table_name TEXT NOT NULL, score_col TEXT NOT NULL,
            regime TEXT NOT NULL, horizon_days INTEGER NOT NULL, rank_ic REAL,
            hit_auc REAL, n INTEGER, dates INTEGER, verdict TEXT,
            PRIMARY KEY (run_at, table_name, score_col, regime, horizon_days));
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    """)
    rows = [
        ('2026-08-20T10:00:00', 'technical_score', 0.031, 24),
        ('2026-08-20T10:00:00', 'dl_score', 0.059, 38),
        ('2026-08-20T10:00:00', 'confluence_score', -0.059, 24),
        ('2026-08-19T09:00:00', 'technical_score', 0.999, 99),   # stale run, ignored
        ('2026-08-20T10:00:00', 'unified_score', 0.05, 38),      # not an engine col
        ('2026-08-20T10:00:00', 'cs_score', None, 24),           # null IC ignored
    ]
    for run_at, col, ric, dates in rows:
        conn.execute(
            "INSERT INTO factor_edge_history VALUES (?,?,?,?,?,?,?,?,?,?)",
            (run_at, 'unified_recommendations__open_entry', col, 'ALL', 5, ric,
             0.55, 5000, dates, 'USABLE'))
    conn.commit()
    yield conn
    conn.close()


def test_load_latest_engine_ics_maps_scores_to_engines(graded_conn):
    got = load_latest_engine_ics(graded_conn, horizon=5)
    assert got['technical'] == {'ic': pytest.approx(0.031), 'dates': 24}
    assert got['dl']['ic'] == pytest.approx(0.059)
    assert got['confluence']['ic'] == pytest.approx(-0.059)
    assert 'ml' not in got and 'cs' not in got           # null IC never mapped
    assert all(v['dates'] >= 20 for v in got.values())


def test_load_latest_engine_ics_empty_when_never_graded():
    conn = pg_memory_conn()
    conn.executescript("CREATE TABLE factor_edge_history (run_at TEXT);")
    assert load_latest_engine_ics(conn) == {}
    conn.close()


# ── gate precedence: tilt supersedes the binary shrink ────────────────────────

def test_gate_defaults_off():
    from unified_ranker import is_ic_tilt_enabled
    conn = pg_memory_conn()
    conn.executescript("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);")
    assert is_ic_tilt_enabled(conn) is False
    conn.close()


def test_gate_on_when_true():
    from unified_ranker import is_ic_tilt_enabled
    conn = pg_memory_conn()
    conn.executescript("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);")
    conn.execute("INSERT INTO app_settings VALUES ('engine_ic_tilt_enabled', 'true')")
    conn.commit()
    assert is_ic_tilt_enabled(conn) is True
    conn.close()
