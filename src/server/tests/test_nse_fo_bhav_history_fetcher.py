"""Unit tests for nse_fo_bhav_history_fetcher.py -- no network.

The fixture is a real NSE old-format F&O bhavcopy (fo03JAN2022bhav.csv, downloaded 2026-10-09)
trimmed to RELIANCE / INFY / HDFCBANK (all rows) and NIFTY (futures + the 06-Jan-2022 weekly).
Expected values are derived independently (textbook prices, raw-CSV sums), never by re-running
the fetcher's own formula.
"""
import csv
import datetime as dt
import io
import math
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nse_fo_bhav_history_fetcher as m  # noqa: E402
from pg_test_support import pg_memory_conn  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "fo03JAN2022bhav_trim.csv.zip")
D0 = dt.date(2022, 1, 3)


def _fixture_bytes() -> bytes:
    with open(FIXTURE, "rb") as f:
        return f.read()


def _fixture_text() -> str:
    with zipfile.ZipFile(FIXTURE) as z:
        return z.read(z.namelist()[0]).decode()


def _feature(sym):
    rows = m.compute_features(m.parse_old(_fixture_text()), D0)
    return next(r for r in rows if r["symbol"] == sym)


# ── Black-76 / IV ───────────────────────────────────────────────────────────

def test_black76_matches_hull_textbook_example():
    # Hull, Options Futures & Other Derivatives, Example 15.6: S=42, K=40, r=10%, sigma=20%,
    # T=0.5 -> call 4.76, put 0.81. Black-76 on F = S e^{rT} is the same price.
    F = 42 * math.exp(0.1 * 0.5)
    assert m.black76(F, 40, 0.5, 0.2, True, r=0.1) == pytest.approx(4.7594, abs=1e-3)
    assert m.black76(F, 40, 0.5, 0.2, False, r=0.1) == pytest.approx(0.8086, abs=1e-3)


@pytest.mark.parametrize("F,K,T,sig", [(100, 90, 0.1, 0.3), (2412.05, 2500, 24 / 365, 0.25), (50, 60, 1.0, 0.8)])
def test_put_call_parity_and_iv_round_trip(F, K, T, sig):
    c, p = m.black76(F, K, T, sig, True), m.black76(F, K, T, sig, False)
    assert c - p == pytest.approx(math.exp(-m.RISK_FREE * T) * (F - K), abs=1e-9)
    assert m.implied_vol(c, F, K, T, True) == pytest.approx(sig, abs=1e-5)
    assert m.implied_vol(p, F, K, T, False) == pytest.approx(sig, abs=1e-5)


def test_implied_vol_is_none_below_intrinsic_or_without_time():
    F, K, T = 100.0, 80.0, 0.1
    intrinsic = math.exp(-m.RISK_FREE * T) * (F - K)
    assert m.implied_vol(intrinsic - 0.5, F, K, T, True) is None
    assert m.implied_vol(5.0, F, K, 0.0, True) is None
    assert m.implied_vol(0.0, F, K, T, True) is None


# ── synthetic chains ────────────────────────────────────────────────────────

def _opt(sym, xp, K, call, close, vol=10, oi=100.0, chg=0.0, td=D0):
    return {"type": "OPT", "cls": "STK", "symbol": sym, "trade_date": td, "expiry": xp, "strike": K,
            "call": call, "close": close, "settle": close, "vol": vol, "traded": (vol or 0) > 0,
            "oi": oi, "chg_oi": chg}


def _fut(sym, xp, px, td=D0):
    return {"type": "FUT", "cls": "STK", "symbol": sym, "trade_date": td, "expiry": xp, "strike": 0.0,
            "call": False, "close": px, "settle": px, "vol": 1, "traded": True, "oi": 1.0, "chg_oi": 0.0}


def _smile_chain(put_wing_iv, call_wing_iv, atm_iv=0.25, F=100.0, xp=dt.date(2022, 1, 27)):
    T = (xp - D0).days / 365
    recs = [_fut("XYZ", xp, F)]
    for K in range(80, 125, 5):
        iv = put_wing_iv if K < 100 else call_wing_iv if K > 100 else atm_iv
        recs.append(_opt("XYZ", xp, float(K), True, m.black76(F, K, T, iv, True)))
        recs.append(_opt("XYZ", xp, float(K), False, m.black76(F, K, T, iv, False)))
    return recs


def test_skew_sign_follows_the_wings():
    put_rich = m.compute_features(_smile_chain(0.40, 0.20), D0)[0]
    call_rich = m.compute_features(_smile_chain(0.20, 0.40), D0)[0]
    assert put_rich["skew_95_105"] == pytest.approx(0.20, abs=1e-4)
    assert call_rich["skew_95_105"] == pytest.approx(-0.20, abs=1e-4)
    assert put_rich["atm_iv"] == pytest.approx(0.25, abs=1e-4)
    assert put_rich["forward_source"] == "future"


def test_pcr_and_oi_arithmetic():
    xp = dt.date(2022, 1, 27)
    recs = [_fut("XYZ", xp, 100.0),
            _opt("XYZ", xp, 95.0, True, 6.0, vol=30, oi=100, chg=10), _opt("XYZ", xp, 105.0, True, 1.0, vol=10, oi=300, chg=-5),
            _opt("XYZ", xp, 95.0, False, 1.0, vol=20, oi=200, chg=7), _opt("XYZ", xp, 105.0, False, 6.0, vol=60, oi=600, chg=3)]
    r = m.compute_features(recs, D0)[0]
    assert (r["call_oi"], r["put_oi"], r["total_oi"]) == (400, 800, 1200)
    assert r["pcr_oi"] == 2.0
    assert r["pcr_vol"] == 2.0          # (20+60)/(30+10)
    assert r["oi_change"] == 15         # 10-5+7+3


def test_not_computable_is_null_never_zero():
    xp = dt.date(2022, 1, 27)
    # nothing traded, no calls carry OI, no future
    recs = [_opt("XYZ", xp, 100.0, True, 3.0, vol=0, oi=0.0), _opt("XYZ", xp, 100.0, False, 3.0, vol=0, oi=50.0)]
    r = m.compute_features(recs, D0)[0]
    for col in ("forward", "spot_proxy", "atm_iv", "atm_straddle", "straddle_pct", "skew_95_105", "pcr_oi", "pcr_vol"):
        assert r[col] is None, col
    assert r["put_oi"] == 50.0 and r["call_oi"] == 0.0
    assert r["illiquid"] is True and r["atm_legs_traded"] is False


def test_expiry_day_rolls_to_next_expiry_and_is_flagged():
    near, nxt = D0, dt.date(2022, 1, 27)
    recs = _smile_chain(0.3, 0.3, xp=nxt) + [_opt("XYZ", near, 100.0, True, 1.0), _opt("XYZ", near, 100.0, False, 1.0)]
    r = m.compute_features(recs, D0)[0]
    assert r["expiry"] == nxt and r["is_expiry_day"] is True
    assert r["days_to_expiry"] == 24


def test_index_weekly_uses_put_call_parity_forward():
    # NIFTY weekly 06-Jan-2022 has no same-expiry future in the file; NIFTY closed 17,625.70 that day.
    r = _feature("NIFTY")
    assert r["instrument"] == "OPTIDX" and r["forward_source"] == "parity"
    assert r["expiry"] == dt.date(2022, 1, 6)
    assert r["spot_proxy"] == pytest.approx(17625.7, rel=0.002)


# ── the real fixture ────────────────────────────────────────────────────────

def _raw_sum(sym, xp, opt, col):
    tot = 0.0
    for r in csv.DictReader(io.StringIO(_fixture_text())):
        if r["INSTRUMENT"] == "OPTSTK" and r["SYMBOL"] == sym and r["EXPIRY_DT"] == xp and r["OPTION_TYP"] == opt:
            tot += float(r[col])
    return tot


def test_fixture_reliance_matches_raw_file():
    r = _feature("RELIANCE")
    assert r["expiry"] == dt.date(2022, 1, 27) and r["expiry"].weekday() == 3   # last Thursday, from the file
    assert r["forward"] == 2412.05 and r["forward_source"] == "future"       # FUTSTK SETTLE_PR
    call_oi, put_oi = _raw_sum("RELIANCE", "27-Jan-2022", "CE", "OPEN_INT"), _raw_sum("RELIANCE", "27-Jan-2022", "PE", "OPEN_INT")
    assert r["call_oi"] == call_oi and r["put_oi"] == put_oi
    assert r["pcr_oi"] == pytest.approx(put_oi / call_oi)
    assert r["pcr_vol"] == pytest.approx(_raw_sum("RELIANCE", "27-Jan-2022", "PE", "CONTRACTS")
                                         / _raw_sum("RELIANCE", "27-Jan-2022", "CE", "CONTRACTS"))
    assert 0.15 < r["atm_iv"] < 0.45
    assert 2.0 < r["straddle_pct"] < 10.0
    assert r["is_expiry_day"] is False and r["illiquid"] is False


def test_untraded_strike_is_excluded_from_iv():
    xp = dt.date(2022, 1, 27)
    T = (xp - D0).days / 365
    recs = [r for r in _smile_chain(0.25, 0.25, xp=xp) if not (r["type"] == "OPT" and r["call"] and r["strike"] == 105.0)]
    recs.append(_opt("XYZ", xp, 105.0, True, m.black76(100.0, 105.0, T, 0.90, True), vol=0))  # stale print
    r = m.compute_features(recs, D0)[0]
    assert r["iv_call_105"] is None and r["skew_95_105"] is None   # next traded call (110) is 4.8% away
    assert r["atm_iv"] == pytest.approx(0.25, abs=1e-4)


def test_untraded_contract_is_never_priced():
    # RELIANCE 1820 CE: CONTRACTS 0, CLOSE 799.25 (a stale print far above the 1800 CE's 523).
    recs = [r for r in m.parse_old(_fixture_text()) if r["symbol"] == "RELIANCE"]
    stale = next(r for r in recs if r["type"] == "OPT" and r["strike"] == 1820 and r["call"] and r["expiry"] == dt.date(2022, 1, 27))
    assert stale["traded"] is False and stale["close"] == 799.25


# ── HTTP: holidays, blocks, budget ──────────────────────────────────────────

class _Resp:
    def __init__(self, status, content=b""):
        self.status_code, self.content = status, content

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class _Session:
    def __init__(self, by_url, default=404):
        self.by_url, self.default, self.calls = by_url, default, []

    def get(self, url, **kw):
        self.calls.append(url)
        return _Resp(*self.by_url.get(url, (self.default,)))


def _fetcher(session, **kw):
    return m.Fetcher(session=session, gap=0, sleep=lambda s: None, **kw)


def test_url_switches_format_at_udiff_cutover():
    assert m.day_url(D0).endswith("/2022/JAN/fo03JAN2022bhav.csv.zip")
    assert m.day_url(dt.date(2024, 7, 8)).endswith("BhavCopy_NSE_FO_0_0_0_20240708_F_0000.csv.zip")


def test_holiday_404_returns_none_without_retry():
    s = _Session({})
    assert _fetcher(s).fetch_day(dt.date(2022, 1, 26)) is None
    assert len(s.calls) == 1


def test_three_consecutive_blocks_abort():
    s = _Session({}, default=403)
    with pytest.raises(m.Blocked):
        _fetcher(s).fetch_day(D0)
    assert len(s.calls) == 3


def test_max_requests_is_a_hard_budget():
    s = _Session({}, default=503)
    f = _fetcher(s, max_requests=2)
    with pytest.raises(m.Blocked):
        f.fetch_day(D0)
    assert f.requests == 2


# ── DB: resume, idempotency, NULL storage (throwaway Postgres schema) ───────

def _db_with_sessions(*days):
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE nse_universe_history (date DATE, symbol TEXT, series TEXT)")
    for d in days:
        conn.execute("INSERT INTO nse_universe_history VALUES (?, 'X', 'EQ')", (d.isoformat(),))
    conn.commit()
    return conn


def test_run_range_counts_holidays_and_resume_skips_present_dates():
    hol = dt.date(2022, 1, 4)   # pretend-holiday: listed as a session, archive 404s
    conn = _db_with_sessions(D0, hol)
    s1 = _Session({m.day_url(D0): (200, _fixture_bytes())})
    first = m.run_range(conn, D0, hol, _fetcher(s1))
    assert (first["fetched"], first["holidays"], first["failed"], first["rows"]) == (1, 1, 0, 4)

    s2 = _Session({m.day_url(D0): (200, _fixture_bytes())})
    second = m.run_range(conn, D0, hol, _fetcher(s2))
    assert second["skipped"] == 1 and second["fetched"] == 0
    assert m.day_url(D0) not in s2.calls

    n = conn.execute("SELECT count(*) FROM stock_option_features_history").fetchone()[0]
    assert n == 4


def test_store_is_idempotent_and_writes_null_not_zero():
    conn = _db_with_sessions(D0)
    m.ensure_schema(conn)
    xp = dt.date(2022, 1, 27)
    rows = m.compute_features([_opt("XYZ", xp, 100.0, True, 3.0, vol=0, oi=0.0),
                               _opt("XYZ", xp, 100.0, False, 3.0, vol=0, oi=50.0)], D0)
    m.store_day(conn, rows, "test")
    m.store_day(conn, rows, "test")
    got = conn.execute("SELECT count(*), max(atm_iv), max(pcr_oi), bool_and(atm_iv IS NULL), "
                       "bool_and(pcr_oi IS NULL), max(put_oi) FROM stock_option_features_history").fetchone()
    assert tuple(got) == (1, None, None, True, True, 50.0)


def test_failed_store_rolls_back_the_whole_day():
    conn = _db_with_sessions(D0)
    m.ensure_schema(conn)
    rows = m.compute_features(m.parse_old(_fixture_text()), D0)
    rows[-1] = {**rows[-1], "instrument": None}   # NOT NULL violation on the last row
    with pytest.raises(Exception):
        m.store_day(conn, rows, "test")
    assert conn.execute("SELECT count(*) FROM stock_option_features_history").fetchone()[0] == 0
