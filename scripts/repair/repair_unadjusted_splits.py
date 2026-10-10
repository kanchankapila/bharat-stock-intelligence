"""AF-20261008-37: back-adjust stock_ohlcv bars still on the pre-split/bonus share basis.

`ohlcv_adjustment_factors` (ohlcv_adjust.py) holds the right factor for every split/bonus, but
nothing applies it to stock_ohlcv: the factors are read only by backtester.load_bhavcopy_adjusted,
and the daily writers append raw bars. So a split after a symbol's backfill leaves its whole
earlier history on the old basis, and the ex-date reads as a -50..-90% loss. ohlcv_quality's
corporate-action allowlist then suppresses the is_suspect flag on exactly these rows.

Per factor event the seam is located IN THE DATA (the factor's ex_date can be a few days off):
  forward seam  G: bar/prev_close ~= factor        -> old-basis bars end before G
  inverse seam  S: bar/prev_close ~= 1/factor      -> an already-adjusted history with raw bars
                                                      from S on (old-basis bars start at S)
Old-basis bars get open/high/low/close x factor and volume / factor. A factor is applied only
where its seam is still visible, so a second run finds nothing (idempotent), and a large move
with no factor, or one whose ratio does not match the factor, is never touched.

Compressed hypertable: TimescaleDB 2.30 updates compressed chunks in place, decompressing only
the batches of the segmentby column (symbol) that the WHERE matches -- the same mechanism
hypertable_safe_write.safe_keyed_update relies on, used here with SET LOCAL inside the ONE
transaction (that helper commits, which would break the single-transaction contract). Touched
chunks become partially compressed until the columnstore policy (every 12h) or the printed
compress_chunk calls recompress them.

    python scripts/repair/repair_unadjusted_splits.py                 # dry-run
    python scripts/repair/repair_unadjusted_splits.py --apply --dump-path stock_ohlcv.dump
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from ohlcv_adjust import DEADBAND  # noqa: E402  no real action is closer to 1.0 than this

TOL = 0.10          # |observed seam ratio / factor - 1|: IRCTC's ex-date session moved 10.6%
WINDOW_DAYS = 5     # factor ex_date vs the seam in the data (record vs ex date, holidays)
REPORT_GAP = 0.35   # the AF-20261008-37 threshold, for the summary only
# NSE's widest price band is 20%. A factor inside 0.75..1.25 read off prices alone (no declared
# action) cannot be told from a circuit run: AKI's stored 1.2 on 2025-07-07 is one.
CIRCUIT_BAND = (0.75, 1.25)

_PREFILTER = f"""
WITH s AS (
  SELECT symbol, date, close, open, LAG(close) OVER (PARTITION BY symbol ORDER BY date) pc
  FROM stock_ohlcv WHERE volume IS DISTINCT FROM 0
)
SELECT DISTINCT s.symbol FROM s JOIN ohlcv_adjustment_factors f
  ON f.symbol = s.symbol AND f.ex_date BETWEEN s.date - {WINDOW_DAYS} AND s.date + {WINDOW_DAYS}
WHERE s.pc > 0 AND (abs(s.close / s.pc - 1) > {DEADBAND} OR abs(s.open / s.pc - 1) > {DEADBAND})
"""


def _ratio_matches(prev_close, bar, target):
    """Open or close of `bar` over prev_close lands within TOL of target, AND the whole session
    traded on the new basis -- ohlcv_adjust's range test, which is what separates a split from a
    crash: on a real -20% day the high stays near the previous close."""
    if not any(v and v > 0 and abs(v / prev_close / target - 1) <= TOL for v in (bar[1], bar[4])):
        return False
    hi, lo = bar[2], bar[3]
    if target < 1:
        return hi is not None and hi / prev_close < 1 - DEADBAND
    return lo is not None and lo / prev_close > 1 + DEADBAND


def find_actions(series, events):
    """series: [(date, open, high, low, close, volume)] ascending; events: [(ex_date, [factors],
    usable)] with `usable` False for an undeclared circuit-band factor (reported, never applied).
    Returns one dict per event: {ex, factor, start, end, cls, dates:[(date, multiplier)]}.
    `start` inclusive / `end` exclusive bound the old-basis bars; None = unbounded."""
    traded = [b for b in series if b[5] != 0]   # zero-volume bars are synthetic: never a seam
    pairs = [(traded[i - 1], traded[i]) for i in range(1, len(traded)) if traded[i - 1][4]]
    out = []
    for ex, factors, *usable in events:
        if usable and not usable[0]:
            out.append({'ex': ex, 'factor': factors[0], 'cls': 'circuit_band_undeclared',
                        'start': None, 'end': None, 'dates': [], 'seam': None})
            continue
        lo, hi = ex - timedelta(days=WINDOW_DAYS), ex + timedelta(days=WINDOW_DAYS)
        near = [(p, b) for p, b in pairs if lo <= b[0] <= hi]
        G = S = f = None
        for cand in factors:
            fwd = [b[0] for p, b in near if _ratio_matches(p[4], b, cand)]
            inv = [b[0] for p, b in near if _ratio_matches(p[4], b, 1 / cand)]
            if fwd or inv:
                f = cand
                G = min(fwd, key=lambda d: abs((d - ex).days)) if fwd else None
                S = max((d for d in inv if G is None or d < G), default=None)
                break
        if f is None:
            big = [b[0] for p, b in near if abs(b[4] / p[4] - 1) > DEADBAND]
            out.append({'ex': ex, 'factor': factors[0], 'cls': 'ratio_mismatch' if big else 'already_adjusted',
                        'start': None, 'end': None, 'dates': [], 'seam': big[0] if big else None})
            continue
        start, end = S, (G if G else ex)
        if start is not None and end <= start:
            out.append({'ex': ex, 'factor': f, 'cls': 'review_inverse_only', 'start': start,
                        'end': end, 'dates': [], 'seam': S})
            continue
        dates, last_traded = [], None
        for b in series:
            if b[5] != 0:
                last_traded = b[4]
            if (start is not None and b[0] < start) or b[0] >= end:
                continue
            # a zero-volume bar already sitting on the NEW basis (a forward-filled phantom) stays
            if b[5] == 0 and last_traded and abs(b[4] - last_traded * f) < abs(b[4] - last_traded):
                continue
            dates.append(b[0])
        cls = 'seam_segment' if start is not None else 'full_history'
        out.append({'ex': ex, 'factor': f, 'cls': cls, 'start': start, 'end': end,
                    'dates': dates, 'seam': G or S})
    return out


def multipliers(actions):
    """{date: product of the factors of every action whose old-basis segment holds the date}."""
    m = {}
    for a in actions:
        for d in a['dates']:
            m[d] = m.get(d, 1.0) * a['factor']
    return m


def _d(v):
    """db_compat hands DATE columns back as ISO text."""
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def _events(conn, symbol):
    """[(ex_date, candidate factors)], MoneyControl's declared ratio FIRST, the stored factor
    second. The stored factor can be ohlcv_adjust's snap of a day that also moved (KAPSTON
    2026-03-06: 0.7 for a declared 1:2 bonus, 2/3), and the table's (symbol, ex_date) key holds
    one factor where a date can carry two actions (LAL 2024-03-28: 1:10 split AND 6:11 bonus),
    so the MC candidate is the product of the distinct split/bonus ratios on that date."""
    rows = conn.execute("SELECT ex_date, factor FROM ohlcv_adjustment_factors WHERE symbol = ? "
                        "ORDER BY ex_date", (symbol,)).fetchall()
    mc = conn.execute(
        "SELECT record_date, exp(sum(ln(ratio_factor))) FROM (SELECT DISTINCT record_date, "
        "action_type, ratio_factor FROM stock_corporate_action_history WHERE symbol = ? "
        "AND action_type IN ('split','bonus') AND ratio_factor > 0 AND record_date IS NOT NULL) x "
        "GROUP BY record_date", (symbol,)).fetchall()
    declared = [(_d(r[0]), float(r[1])) for r in mc]
    out = []
    for ex, f in rows:
        ex = _d(ex)
        cands = [v for d, v in declared if abs((d - ex).days) <= WINDOW_DAYS]
        if cands or not CIRCUIT_BAND[0] <= float(f) <= CIRCUIT_BAND[1]:
            cands.append(float(f))
        out.append((ex, cands or [float(f)], bool(cands)))
    return out


def _series(conn, symbol):
    return [(_d(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in conn.execute(
        "SELECT date, open, high, low, close, volume FROM stock_ohlcv WHERE symbol = ? ORDER BY date",
        (symbol,)).fetchall()]


_V = "(SELECT unnest(CAST(? AS date[])) AS d, unnest(CAST(? AS float8[])) AS m) v"
_UPDATE_FROM = f"FROM {_V} WHERE o.symbol = ? AND o.date = v.d"
_COUNT = f"SELECT count(*) FROM stock_ohlcv o JOIN {_V} ON o.date = v.d WHERE o.symbol = ?"


def duplicate_series_note(conn):
    """POLICYBZR / POLICYBAZAAR: reported only, nothing deleted."""
    rows = conn.execute(
        "SELECT symbol, min(date), max(date), count(*) FROM stock_ohlcv "
        "WHERE symbol IN ('POLICYBZR','POLICYBAZAAR') GROUP BY symbol ORDER BY symbol").fetchall()
    if not rows:
        return []
    ov = conn.execute(
        "SELECT count(*), count(*) FILTER (WHERE abs(a.close - b.close) < 0.01) FROM stock_ohlcv a "
        "JOIN stock_ohlcv b ON b.date = a.date AND b.symbol = 'POLICYBAZAAR' "
        "WHERE a.symbol = 'POLICYBZR'").fetchall()[0]
    isin = conn.execute("SELECT symbol, isin FROM nse_stocks WHERE symbol IN ('POLICYBZR','POLICYBAZAAR') "
                        "ORDER BY symbol").fetchall() if _has(conn, 'nse_stocks') else []
    notes = ["", "PROPOSAL (not applied) - duplicate series, PB Fintech:"]
    notes += [f"  {r[0]:13s} {r[1]} .. {r[2]}  {r[3]} rows" for r in rows]
    notes += [f"  nse_stocks {s}: isin {i}" for s, i in isin]
    notes.append(f"  overlap {ov[0]} dates, identical close on {ov[1]}. Canonical: POLICYBZR (the NSE "
                 "ticker; ISIN INE417T01026). Merge = delete POLICYBAZAAR rows after re-pointing any "
                 "reader/writer of that name; needs its own approval.")
    return notes


def _has(conn, table):
    return bool(conn.execute("SELECT 1 FROM information_schema.tables WHERE table_schema = "
                             "current_schema() AND table_name = ?", (table,)).fetchall())


def plan(conn):
    conn.execute("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0")
    ops, notes, summary, touched = [], [], {}, []
    symbols = [r[0] for r in conn.execute(_PREFILTER).fetchall()]
    notes.append(f"{len(symbols)} symbols have a >{DEADBAND:.0%} move within {WINDOW_DAYS}d of a factor")
    notes.append("symbol       ex_date    seam       factor    class               bars  big_gap")
    for sym in sorted(symbols):
        series = _series(conn, sym)
        by_date = {b[0]: b for b in series}
        idx = {b[0]: i for i, b in enumerate(series)}
        acts = find_actions(series, _events(conn, sym))
        for a in acts:
            if a['cls'] in ('already_adjusted', 'circuit_band_undeclared'):
                summary[a['cls']] = summary.get(a['cls'], 0) + 1
                continue
            big, s = '', a.get('seam')
            if s in idx and idx[s] > 0 and series[idx[s] - 1][4]:
                g = by_date[s][4] / series[idx[s] - 1][4] - 1
                big = f"{g:+.0%}"
                if abs(g) > REPORT_GAP:
                    k = f"{a['cls']}(gap>{REPORT_GAP:.0%})"
                    summary[k] = summary.get(k, 0) + 1
            summary[a['cls']] = summary.get(a['cls'], 0) + 1
            notes.append(f"{sym:12s} {a['ex']} {str(s or '-'):<10} {a['factor']:<9.4g} {a['cls']:19s} "
                         f"{len(a['dates']):5d}  {big}")
        m = multipliers(acts)
        if not m:
            continue
        ds = sorted(m)
        touched.append((sym, ds[0], ds[-1]))
        params = ([d.isoformat() for d in ds], [m[d] for d in ds], sym)
        ops.append(Op(f"stock_ohlcv[{sym}]", "update",
                      _COUNT,
                      "UPDATE stock_ohlcv o SET open = o.open * v.m, high = o.high * v.m, "
                      "low = o.low * v.m, close = o.close * v.m, "
                      f"volume = round(o.volume / v.m)::bigint {_UPDATE_FROM}", params))
    notes.append("classes: " + ", ".join(f"{k}={v}" for k, v in sorted(summary.items())))
    if touched and _has_chunks(conn):
        lo, hi = min(t[1] for t in touched), max(t[2] for t in touched)
        ch = conn.execute(
            "SELECT chunk_schema || '.' || chunk_name, is_compressed FROM timescaledb_information.chunks "
            "WHERE hypertable_schema = current_schema() AND hypertable_name = 'stock_ohlcv' "
            "AND range_end > ? AND range_start <= ? "
            "ORDER BY range_start", (lo.isoformat(), hi.isoformat())).fetchall()
        notes.append(f"chunks spanning {lo}..{hi}: {len(ch)} ({sum(1 for c in ch if c[1])} compressed). "
                     "After --apply, recompress now or let the 12h policy do it:")
        notes += [f"  SELECT compress_chunk('{c[0]}');" for c in ch if c[1]]
    notes += duplicate_series_note(conn)
    return ops, notes


def _has_chunks(conn):
    return bool(conn.execute("SELECT 1 FROM information_schema.views WHERE table_schema = "
                             "'timescaledb_information' AND table_name = 'chunks'").fetchall())


def main(argv=None, conn=None) -> int:
    args = parser(__doc__).parse_args(argv)
    return run(args, conn, plan)


if __name__ == "__main__":
    raise SystemExit(main())
