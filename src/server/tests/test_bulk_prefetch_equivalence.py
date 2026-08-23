"""
Equivalence proof for the AF-20260823-80 bulk-prefetch refactor of
outcome_resolver (referenced by that file's header comment — this file IS the
evidence; without it the claim was evidence-shaped prose, which recurring-bugs.md
line 96 exists to prevent).

Guarantee under test: warming prepare_outcome_caches() over a set of
(symbol, as_of) pairs and then reading get_atr()/get_volatility_threshold()
yields EXACTLY what the original per-row queries yield on the same database —
including suspect-bar exclusion and short-history fallbacks. Caches are cleared
around every comparison so both paths genuinely execute.
"""
import sys, os, datetime
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402


SIGNAL_DATE = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()


def make_db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER, is_suspect INTEGER DEFAULT 0,
            PRIMARY KEY (symbol, date)
        );
    """)
    return conn


@pytest.fixture(autouse=True)
def _clean_caches():
    import outcome_resolver as orc
    for c in (orc._ATR_CACHE, orc._CLOSES_CACHE, orc._VOLTHRESH_CACHE):
        c.clear()
    yield
    for c in (orc._ATR_CACHE, orc._CLOSES_CACHE, orc._VOLTHRESH_CACHE):
        c.clear()


def seed_walk(conn, symbol, n=30, base=100.0, null_close_on=None,
              suspect_on=None):
    """Deterministic zig-zag walk (nonzero TR and vol); optional poisoned bars."""
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    for i in range(n, 0, -1):
        day = (d0 - datetime.timedelta(days=i)).isoformat()
        price = base * (1 + (((i * 37) % 11) - 5) / 100.0)
        high, low = price * 1.02, price * 0.98
        close = None if day == null_close_on else price
        susp = 1 if day == suspect_on else 0
        conn.execute(
            "INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume,is_suspect) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (symbol, day, price, high, low, close, 100000, susp))


def warm(conn, symbols):
    import outcome_resolver as orc
    orc.prepare_outcome_caches(
        conn, [{'symbol': s, 'signal_date': SIGNAL_DATE} for s in symbols])


# ── ATR: cached path == original per-row query ────────────────────────────────

@pytest.mark.parametrize("symbol", ['WALK1', 'WALK2'])
def test_get_atr_cached_equals_per_row(symbol):
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, symbol)
    conn.commit()
    reference = orc._get_atr_query(conn, symbol, SIGNAL_DATE)  # original math
    warm(conn, [symbol])
    assert reference > 0
    assert orc.get_atr(conn, symbol, SIGNAL_DATE) == pytest.approx(reference)


def test_get_atr_short_history_fallback_identical():
    # <2 clean bars -> trailing disabled (0.0) on BOTH paths
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'SHORT', n=1)
    conn.commit()
    assert orc._get_atr_query(conn, 'SHORT', SIGNAL_DATE) == 0.0
    warm(conn, ['SHORT'])
    assert orc.get_atr(conn, 'SHORT', SIGNAL_DATE) == 0.0


# ── Vol threshold: cached path == fallback-query path ─────────────────────────

@pytest.mark.parametrize("horizon", [1, 5])
def test_vol_threshold_cached_equals_per_row(horizon):
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'VOL1')
    conn.commit()
    # Cold: caches empty -> wrapper falls back to the original direct query.
    cold = orc.get_volatility_threshold(conn, 'VOL1', SIGNAL_DATE, horizon)
    warm(conn, ['VOL1'])                       # now serve same key from cache
    hot = orc.get_volatility_threshold(conn, 'VOL1', SIGNAL_DATE, horizon)
    assert hot == pytest.approx(cold)


def test_vol_threshold_excludes_suspect_bar_identically():
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    spike_day = (d0 - datetime.timedelta(days=6)).isoformat()
    seed_walk(conn, 'SUSP2', n=12, suspect_on=spike_day)
    conn.commit()
    cold = orc.get_volatility_threshold(conn, 'SUSP2', SIGNAL_DATE, 5)
    warm(conn, ['SUSP2'])
    hot = orc.get_volatility_threshold(conn, 'SUSP2', SIGNAL_DATE, 5)
    assert hot == pytest.approx(cold)
    # AF-20260823-79 (preserved verbatim, see _vol_threshold_from_closes):
    # percent-return variance x 100 pins ANY non-flat series at the 15%


def test_vol_threshold_short_history_fallback_formula():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'TINY', n=8)               # < 10 closes -> formula fallback
    conn.commit()
    expected = max(0.5, min(10.0, 1.0 * (8 ** 0.5)))
    cold = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    warm(conn, ['TINY'])
    hot = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    assert cold == pytest.approx(expected, rel=1e-9)
    assert hot == pytest.approx(expected, rel=1e-9)


# ── NULL closes: documented deliberate improvement over the legacy path ───────

def test_null_close_does_not_crash_warm_path():
    # Legacy per-row path does float(None) -> TypeError on a NULL close inside
    # the window; the prefetch filters Nones (prepare_outcome_caches). The warm
    # path must succeed and match the math over the surviving closes.
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    hole = (d0 - datetime.timedelta(days=9)).isoformat()
    seed_walk(conn, 'NULLC', n=21, null_close_on=hole)
    conn.commit()
    warm(conn, ['NULLC'])
    closes = orc._CLOSES_CACHE[('NULLC', SIGNAL_DATE)]
    assert len(closes) == 20                   # the NULL never entered the cache
    expect = orc._vol_threshold_from_closes(closes, 5)
    assert orc.get_volatility_threshold(conn, 'NULLC', SIGNAL_DATE, 5) \
        == pytest.approx(expect)


# ── Chunking: small _BULK_CHUNK must not change results ───────────────────────

def test_chunked_prefetch_identical_to_single_query(monkeypatch):
    import outcome_resolver as orc
    conn = make_db()
    syms = ['CH01', 'CH02', 'CH03', 'CH04', 'CH05']
    for s in syms:
        seed_walk(conn, s)
    conn.commit()
    pairs = [(s, SIGNAL_DATE) for s in syms]
    full = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    monkeypatch.setattr(orc, '_BULK_CHUNK', 2)   # force 3 chunked round trips
    chunked = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    assert chunked == full
    assert len(chunked) == len(syms)


# ── Idempotence: double preparation must be safe ──────────────────────────────

def test_prepare_outcome_caches_idempotent():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'IDEM')
    conn.commit()
    warm(conn, ['IDEM'])
    first_atr = dict(orc._ATR_CACHE)
    warm(conn, ['IDEM'])
    assert orc._ATR_CACHE == first_atr




def test_vol_threshold_short_history_fallback_formula():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'TINY', n=8)               # < 10 closes -> formula fallback
    conn.commit()
    expected = max(0.5, min(10.0, 1.0 * (8 ** 0.5)))
    cold = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    warm(conn, ['TINY'])
    hot = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    assert cold == pytest.approx(expected, rel=1e-9)
    assert hot == pytest.approx(expected, rel=1e-9)


# ── NULL closes: documented deliberate improvement over the legacy path ───────

def test_null_close_does_not_crash_warm_path():
    # Legacy per-row path does float(None) -> TypeError on a NULL close inside
    # the window; the prefetch filters Nones (prepare_outcome_caches l.386-391).
    # The warm path must succeed and match the math over the surviving closes.
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    hole = (d0 - datetime.timedelta(days=9)).isoformat()
    seed_walk(conn, 'NULLC', n=21, null_close_on=hole)
    conn.commit()
    warm(conn, ['NULLC'])
    closes = orc._CLOSES_CACHE[('NULLC', SIGNAL_DATE)]
    assert len(closes) == 20                   # the NULL never entered the cache
    expect = orc._vol_threshold_from_closes(closes, 5)
    assert orc.get_volatility_threshold(conn, 'NULLC', SIGNAL_DATE, 5) \
        == pytest.approx(expect)


# ── Chunking: small _BULK_CHUNK must not change results ───────────────────────

def test_chunked_prefetch_identical_to_single_query(monkeypatch):
    import outcome_resolver as orc
    conn = make_db()
    syms = ['CH01', 'CH02', 'CH03', 'CH04', 'CH05']
    for s in syms:
        seed_walk(conn, s)
    conn.commit()
    pairs = [(s, SIGNAL_DATE) for s in syms]
    full = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    monkeypatch.setattr(orc, '_BULK_CHUNK', 2)   # force 3 chunked round trips
    chunked = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    assert chunked == full
    assert len(chunked) == len(syms)


# ── Idempotence: double preparation must be safe ──────────────────────────────

def test_prepare_outcome_caches_idempotent():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'IDEM')
    conn.commit()
    warm(conn, ['IDEM'])
    first_atr = dict(orc._ATR_CACHE)
    warm(conn, ['IDEM'])
    assert orc._ATR_CACHE == first_atr


def test_vol_threshold_short_history_fallback_formula():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'TINY', n=8)               # < 10 closes -> formula fallback
    conn.commit()
    expected = max(0.5, min(10.0, 1.0 * (8 ** 0.5)))
    cold = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    warm(conn, ['TINY'])
    hot = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    assert cold == pytest.approx(expected, rel=1e-9)
    assert hot == pytest.approx(expected, rel=1e-9)


# ── NULL closes: documented deliberate improvement over the legacy path ───────

def test_null_close_does_not_crash_warm_path():
    # Legacy per-row path does float(None) -> TypeError on a NULL close inside
    # the window; the prefetch filters Nones (prepare_outcome_caches l.386-391).
    # The warm path must succeed and match the math over the surviving closes.
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    hole = (d0 - datetime.timedelta(days=9)).isoformat()
    seed_walk(conn, 'NULLC', n=21, null_close_on=hole)
    conn.commit()
    warm(conn, ['NULLC'])
    closes = orc._CLOSES_CACHE[('NULLC', SIGNAL_DATE)]
    assert len(closes) == 20                   # the NULL never entered the cache
    expect = orc._vol_threshold_from_closes(closes, 5)
    assert orc.get_volatility_threshold(conn, 'NULLC', SIGNAL_DATE, 5) \
        == pytest.approx(expect)


# ── Chunking: small _BULK_CHUNK must not change results ───────────────────────

def test_chunked_prefetch_identical_to_single_query(monkeypatch):
    import outcome_resolver as orc
    conn = make_db()
    syms = ['CH01', 'CH02', 'CH03', 'CH04', 'CH05']
    for s in syms:
        seed_walk(conn, s)
    conn.commit()
    pairs = [(s, SIGNAL_DATE) for s in syms]
    full = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    monkeypatch.setattr(orc, '_BULK_CHUNK', 2)   # force 3 chunked round trips
    chunked = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    assert chunked == full
    assert len(chunked) == len(syms)


# ── Idempotence: double preparation must be safe ──────────────────────────────

def test_prepare_outcome_caches_idempotent():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'IDEM')
    conn.commit()
    warm(conn, ['IDEM'])
    first_atr = dict(orc._ATR_CACHE)
    warm(conn, ['IDEM'])
    assert orc._ATR_CACHE == first_atr



def test_vol_threshold_short_history_fallback_formula():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'TINY', n=8)               # < 10 closes -> formula fallback
    conn.commit()
    expected = max(0.5, min(10.0, 1.0 * (8 ** 0.5)))
    cold = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    warm(conn, ['TINY'])
    hot = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    assert cold == pytest.approx(expected, rel=1e-9)
    assert hot == pytest.approx(expected, rel=1e-9)


# ── NULL closes: documented deliberate improvement over the legacy path ───────

def test_null_close_does_not_crash_warm_path():
    # Legacy per-row path does float(None) -> TypeError on a NULL close inside
    # the window; the prefetch filters Nones. The warm path must succeed and
    # match the math over the surviving closes.
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    hole = (d0 - datetime.timedelta(days=9)).isoformat()
    seed_walk(conn, 'NULLC', n=21, null_close_on=hole)
    conn.commit()
    warm(conn, ['NULLC'])
    closes = orc._CLOSES_CACHE[('NULLC', SIGNAL_DATE)]
    assert len(closes) == 20                   # the NULL never entered the cache
    expect = orc._vol_threshold_from_closes(closes, 5)
    assert orc.get_volatility_threshold(conn, 'NULLC', SIGNAL_DATE, 5) \
        == pytest.approx(expect)


# ── Chunking: small _BULK_CHUNK must not change results ───────────────────────

def test_chunked_prefetch_identical_to_single_query(monkeypatch):
    import outcome_resolver as orc
    conn = make_db()
    syms = ['CH01', 'CH02', 'CH03', 'CH04', 'CH05']
    for s in syms:
        seed_walk(conn, s)
    conn.commit()
    pairs = [(s, SIGNAL_DATE) for s in syms]
    full = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    monkeypatch.setattr(orc, '_BULK_CHUNK', 2)   # force chunked round trips
    chunked = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    assert chunked == full
    assert len(chunked) == len(syms)


# ── Idempotence: double preparation must be safe ──────────────────────────────

def test_prepare_outcome_caches_idempotent():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'IDEM')
    conn.commit()
    warm(conn, ['IDEM'])
    first_atr = dict(orc._ATR_CACHE)
    warm(conn, ['IDEM'])
    assert orc._ATR_CACHE == first_atr


def test_vol_threshold_short_history_fallback_formula():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'TINY', n=8)               # < 10 closes -> formula fallback
    conn.commit()
    expected = max(0.5, min(10.0, 1.0 * (8 ** 0.5)))
    cold = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    warm(conn, ['TINY'])
    hot = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    assert cold == pytest.approx(expected, rel=1e-9)
    assert hot == pytest.approx(expected, rel=1e-9)


# ── NULL closes: documented deliberate improvement over the legacy path ───────

def test_null_close_does_not_crash_warm_path():
    # Legacy per-row path does float(None) -> TypeError on a NULL close inside
    # the window; the prefetch filters Nones (prepare_outcome_caches l.386-391).
    # The warm path must succeed and match the math over the surviving closes.
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    hole = (d0 - datetime.timedelta(days=9)).isoformat()
    seed_walk(conn, 'NULLC', n=21, null_close_on=hole)
    conn.commit()
    warm(conn, ['NULLC'])
    closes = orc._CLOSES_CACHE[('NULLC', SIGNAL_DATE)]
    assert len(closes) == 20                   # the NULL never entered the cache
    expect = orc._vol_threshold_from_closes(closes, 5)
    assert orc.get_volatility_threshold(conn, 'NULLC', SIGNAL_DATE, 5) \
        == pytest.approx(expect)


# ── Chunking: small _BULK_CHUNK must not change results ───────────────────────

def test_chunked_prefetch_identical_to_single_query(monkeypatch):
    import outcome_resolver as orc
    conn = make_db()
    syms = ['CH01', 'CH02', 'CH03', 'CH04', 'CH05']
    for s in syms:
        seed_walk(conn, s)
    conn.commit()
    pairs = [(s, SIGNAL_DATE) for s in syms]
    full = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    monkeypatch.setattr(orc, '_BULK_CHUNK', 2)   # force 3 chunked round trips
    chunked = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    assert chunked == full
    assert len(chunked) == len(syms)


# ── Idempotence: double preparation must be safe ──────────────────────────────

def test_prepare_outcome_caches_idempotent():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'IDEM')
    conn.commit()
    warm(conn, ['IDEM'])
    first_atr = dict(orc._ATR_CACHE)
    warm(conn, ['IDEM'])
    assert orc._ATR_CACHE == first_atr

    # clamp — including this spike-free window. Encoded as-is so that the day
    # AF-79 is fixed, this test fails loudly and gets re-measured.
    assert hot == 15.0



def test_vol_threshold_short_history_fallback_formula():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'TINY', n=8)               # < 10 closes -> formula fallback
    conn.commit()
    expected = max(0.5, min(10.0, 1.0 * (8 ** 0.5)))
    cold = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    warm(conn, ['TINY'])
    hot = orc.get_volatility_threshold(conn, 'TINY', SIGNAL_DATE, 8)
    assert cold == pytest.approx(expected, rel=1e-9)
    assert hot == pytest.approx(expected, rel=1e-9)


# ── NULL closes: documented deliberate improvement over the legacy path ───────

def test_null_close_does_not_crash_warm_path():
    # Legacy per-row path does float(None) -> TypeError on a NULL close inside
    # the window; the prefetch filters Nones (prepare_outcome_caches l.386-391).
    # The warm path must succeed and match the math over the surviving closes.
    import outcome_resolver as orc
    conn = make_db()
    d0 = datetime.date.fromisoformat(SIGNAL_DATE)
    hole = (d0 - datetime.timedelta(days=9)).isoformat()
    seed_walk(conn, 'NULLC', n=21, null_close_on=hole)
    conn.commit()
    warm(conn, ['NULLC'])
    closes = orc._CLOSES_CACHE[('NULLC', SIGNAL_DATE)]
    assert len(closes) == 20                   # the NULL never entered the cache
    expect = orc._vol_threshold_from_closes(closes, 5)
    assert orc.get_volatility_threshold(conn, 'NULLC', SIGNAL_DATE, 5) \
        == pytest.approx(expect)


# ── Chunking: small _BULK_CHUNK must not change results ───────────────────────

def test_chunked_prefetch_identical_to_single_query(monkeypatch):
    import outcome_resolver as orc
    conn = make_db()
    syms = ['CH01', 'CH02', 'CH03', 'CH04', 'CH05']
    for s in syms:
        seed_walk(conn, s)
    conn.commit()
    pairs = [(s, SIGNAL_DATE) for s in syms]
    full = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    monkeypatch.setattr(orc, '_BULK_CHUNK', 2)   # force 3 chunked round trips
    chunked = orc._prefetch_pair_windows(conn, pairs, lookback=21)
    assert chunked == full
    assert len(chunked) == len(syms)


# ── Idempotence: double preparation must be safe ──────────────────────────────

def test_prepare_outcome_caches_idempotent():
    import outcome_resolver as orc
    conn = make_db()
    seed_walk(conn, 'IDEM')
    conn.commit()
    warm(conn, ['IDEM'])
    first_atr = dict(orc._ATR_CACHE)
    warm(conn, ['IDEM'])
    assert orc._ATR_CACHE == first_atr
