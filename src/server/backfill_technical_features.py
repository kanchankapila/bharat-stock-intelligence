"""
backfill_technical_features.py
================================
For every (symbol, signal_date) in signal_outcomes that has no matching
technical_signals row within 3 days, compute basic technical indicators
from stock_ohlcv and write a ts row.

This dramatically expands ML training coverage: 1,056 symbols have outcomes
but zero ts coverage because their signals came from AI/strategy paths
(not the technicalScanner), yet their OHLCV is available.

Computed indicators:
  rsi, sma50, sma200, macd, macd_signal, bb_width, volume_ratio,
  above_sma200, adx, nifty_regime, sector_ret_5d, sector_ret_21d,
  fii_3d_net, signal_score (0), signal_type (BACKFILL)

--full-today (grid-ensurer) also fills the market-wide flow columns
(fii_3d_net / fii_10d_net / dii_3d_net) and cross-sectional sector returns
(sector_ret_5d / sector_ret_21d) onto every GRID row it creates (2026-08-25).
These five were left NULL by this script since they were added, and stayed alive
only through densify_feature_matrix.py's forward-fill — until 5a97df3 put them
in NEVER_FILL (correctly: a stale flow reading is a fabricated reading), which
silently removed their only bulk producer. Measured live 2026-08-24, the first
trading day after that commit: fii_3d_net fell from ~1,642 rows/day to 309 (the
signal-scan subset), fii_10d_net/dii_3d_net to the same 309, sector_ret_5d/21d
to 0. All three engines that consume them (dl_engine FEATURE_COLS,
ml_ensemble build_features, cs_ranker/exit_policy SELECTs) read them straight
off technical_signals, so the gap fed straight into training/inference.

Usage:
  python backfill_technical_features.py
  python backfill_technical_features.py --limit 500   # process first 500 pairs
"""
import sys, argparse
from pathlib import Path
from datetime import datetime, timedelta

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect, safe_alter
from as_of import logical_write_floor

# ── Technical indicator helpers ───────────────────────────────────────────────

def _rsi(closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    deltas = [closes[i] - closes[i-1] for i in range(1, len(closes))]
    gains = [max(d, 0) for d in deltas]
    losses = [abs(min(d, 0)) for d in deltas]
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 2)


def _ema(values: list[float], period: int) -> list[float]:
    if len(values) < period:
        return []
    k = 2 / (period + 1)
    ema = [sum(values[:period]) / period]
    for v in values[period:]:
        ema.append(v * k + ema[-1] * (1 - k))
    return ema


def _macd(closes: list[float]) -> tuple[float | None, float | None]:
    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    if not ema12 or not ema26:
        return None, None
    min_len = min(len(ema12), len(ema26))
    macd_line = [ema12[-(min_len-i)] - ema26[-(min_len-i)] for i in range(min_len)]
    signal = _ema(macd_line, 9)
    if not signal:
        return None, None
    return round(macd_line[-1], 4), round(signal[-1], 4)


def _adx(rows: list[dict], period: int = 14) -> float | None:
    if len(rows) < period + 2:
        return None
    trs, pdms, ndms = [], [], []
    for i in range(1, len(rows)):
        h, l, c_prev = rows[i]['high'], rows[i]['low'], rows[i-1]['close']
        tr = max(h - l, abs(h - c_prev), abs(l - c_prev))
        pdm = max(h - rows[i-1]['high'], 0)
        ndm = max(rows[i-1]['low'] - l, 0)
        if pdm < ndm:
            pdm = 0
        elif ndm < pdm:
            ndm = 0
        trs.append(tr)
        pdms.append(pdm)
        ndms.append(ndm)
    if len(trs) < period:
        return None
    atr = sum(trs[-period:]) / period
    if atr == 0:
        return None
    pdi = 100 * sum(pdms[-period:]) / period / atr
    ndi = 100 * sum(ndms[-period:]) / period / atr
    dx = 100 * abs(pdi - ndi) / (pdi + ndi) if (pdi + ndi) > 0 else 0
    return round(dx, 2)


def _bb_width(closes: list[float], period: int = 20) -> float | None:
    if len(closes) < period:
        return None
    window = closes[-period:]
    mean = sum(window) / period
    std = (sum((x - mean) ** 2 for x in window) / period) ** 0.5
    if mean == 0:
        return None
    return round(4 * std / mean, 4)  # (upper - lower) / mean


def _volume_ratio(volumes: list[float], period: int = 20) -> float | None:
    if len(volumes) < period + 1:
        return None
    avg = sum(volumes[-period-1:-1]) / period
    if avg == 0:
        return None
    return round(volumes[-1] / avg, 3)


def compute_indicators(ohlcv_rows: list[dict]) -> dict:
    closes = [r['close'] for r in ohlcv_rows]
    volumes = [r['volume'] for r in ohlcv_rows]

    rsi = _rsi(closes)
    macd_val, macd_sig = _macd(closes)
    adx_val = _adx(ohlcv_rows)
    bb = _bb_width(closes)
    vr = _volume_ratio(volumes)

    sma50 = round(sum(closes[-50:]) / min(len(closes), 50), 2) if closes else None
    sma200 = round(sum(closes[-200:]) / min(len(closes), 200), 2) if closes else None
    above_sma200 = 1 if (closes and sma200 and closes[-1] > sma200) else 0

    return {
        'rsi': rsi,
        'sma50': sma50,
        'sma200': sma200,
        'macd': macd_val,
        'macd_signal': macd_sig,
        'bb_width': bb,
        'volume_ratio': vr,
        'above_sma200': above_sma200,
        'adx': adx_val,
        'cmp': closes[-1] if closes else None,
    }


# ── Main backfill ─────────────────────────────────────────────────────────────

def run(limit: int | None = None):
    con = connect()
    safe_alter(None, "ALTER TABLE technical_signals ADD COLUMN signal_type TEXT")

    # Find all (symbol, signal_date) pairs needing backfill
    print("[Backfill] Finding coverage gaps...")
    gaps = con.execute("""
        SELECT DISTINCT so.symbol, so.signal_date
        FROM signal_outcomes so
        WHERE so.outcome IN ('WIN','LOSS','STOP_LOSS')
          AND so.return_pct IS NOT NULL
          AND so.signal_source = 'technical'
          AND NOT EXISTS (
              SELECT 1 FROM technical_signals ts
              WHERE ts.symbol = so.symbol
                AND ts.date <= so.signal_date::date
                -- keep in step with ml_ensemble.py's feature lateral (7d tolerates a
                -- holiday+weekend closure); a narrower window here would report gaps the
                -- trainer does not actually have.
                AND ts.date >= (so.signal_date::date - interval '7 days')
          )
        ORDER BY so.signal_date DESC
    """).fetchall()

    if limit:
        gaps = gaps[:limit]

    print(f"[Backfill] {len(gaps)} (symbol, date) pairs to fill")

    # Pre-load sector map
    sector_map = {r['symbol']: r['sector']
                  for r in con.execute("SELECT symbol, sector FROM nse_stocks").fetchall()}

    # Pre-load regime map
    regime_rows = con.execute(
        "SELECT date, regime FROM market_regimes ORDER BY date ASC"
    ).fetchall()
    regime_dates = [(r['date'], r['regime']) for r in regime_rows]

    def get_regime(date_str: str) -> str:
        # Collapse the HMM's 5-state label (BULL/SIDEWAYS/HIGH_VOL/BEAR/CRASH) to the 3-state
        # vocabulary every consumer of technical_signals.nifty_regime expects (win-rate
        # lookups, ml_ensemble.REGIME_MAP, gating). Previously this returned the raw 5-state
        # value, so HIGH_VOL/CRASH rows leaked in unmapped and silently fell through
        # REGIME_MAP.fillna(0.0) as SIDEWAYS (0.0) in ml_ensemble's numeric encoding — found
        # 2026-07-19 comparing technicalSignalsService.ts's computeNiftyRegime() against this.
        for d, reg in reversed(regime_dates):
            if d <= date_str:
                if reg in ('BULL', 'SIDEWAYS'):
                    return reg
                return 'BEAR'  # HIGH_VOL | BEAR | CRASH
        return 'SIDEWAYS'

    # Pre-load FII 3d net by date
    fii_rows = con.execute(
        "SELECT date, fii_net FROM fii_dii_flow ORDER BY date ASC"
    ).fetchall()
    fii_by_date = {r['date']: r['fii_net'] for r in fii_rows}

    # Group gaps by symbol to batch OHLCV reads
    from collections import defaultdict
    by_symbol: dict[str, list[str]] = defaultdict(list)
    for row in gaps:
        by_symbol[row['symbol']].append(row['signal_date'])

    written = 0
    skipped = 0
    now_str = datetime.now().isoformat()

    for symbol, dates in by_symbol.items():
        # Load OHLCV for this symbol (all history, sorted asc)
        ohlcv = con.execute(
            "SELECT date, open, high, low, close, volume FROM stock_ohlcv WHERE symbol=? ORDER BY date ASC",
            (symbol,)
        ).fetchall()

        if len(ohlcv) < 22:
            skipped += len(dates)
            continue

        ohlcv_list = [{**dict(r), 'date': str(r['date'])[:10]} for r in ohlcv]
        ohlcv_by_date = {r['date']: r for r in ohlcv_list}
        all_dates_sorted = [r['date'] for r in ohlcv_list]

        for sig_date in dates:
            # Get OHLCV up to and including sig_date
            idx = next((i for i, d in enumerate(all_dates_sorted) if d > sig_date), len(all_dates_sorted))
            window = ohlcv_list[:idx]
            if len(window) < 22:
                skipped += 1
                continue

            ind = compute_indicators(window)
            regime = get_regime(sig_date)

            # Approximate FII 3d net: nearest available date
            fii_val = None
            for d in sorted(fii_by_date.keys(), reverse=True):
                if d <= sig_date:
                    fii_val = fii_by_date[d]
                    break

            con.execute("""
                INSERT INTO technical_signals
                    (symbol, date, signal_score, signal_type,
                     rsi, sma50, sma200, macd, macd_signal,
                     bb_width, volume_ratio, above_sma200, adx,
                     cmp, nifty_regime, fii_3d_net, computed_at,
                     fii_10d_net, dii_3d_net, sector_ret_5d, sector_ret_21d)
                VALUES (?,?,0,'BACKFILL',?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)
                ON CONFLICT (symbol, date) DO NOTHING
            """, (
                symbol, sig_date,
                ind['rsi'], ind['sma50'], ind['sma200'],
                ind['macd'], ind['macd_signal'],
                ind['bb_width'], ind['volume_ratio'], ind['above_sma200'],
                ind['adx'], ind['cmp'],
                regime, fii_val, now_str
            ))
            written += 1

        if (written + skipped) % 2000 == 0 and (written + skipped) > 0:
            con.commit()
            print(f"[Backfill] Progress: {written} written, {skipped} skipped")

    con.commit()
    print(f"[Backfill] Done: {written} ts rows written, {skipped} skipped (insufficient OHLCV)")


def _flow_nets(fii_by_date: dict, grid_date: str):
    """Rolling FII/DII nets as of grid_date from sessions STRICTLY BEFORE it.

    Session T's FII/DII figure is published after T's close, so a value stamped on
    T's grid row must be built from sessions <= T-1 — feature_engineering's
    FII_LAG_DAYS=1 shift is the training-side convention; mirroring it keeps live
    rows consistent with what the trainer sees. NULL sessions (holidays) are skipped
    by the filter, not treated as zero. Returns (fii_3d, fii_10d, dii_3d), all None
    when fewer than 3 published sessions precede grid_date."""
    prior = sorted(d for d in fii_by_date if d < grid_date)
    if len(prior) < 3:
        return None, None, None
    last3 = prior[-3:]
    last10 = prior[-10:]

    def _sum(idx: int, window: list) -> float:
        vals = [fii_by_date[d][idx] for d in window]
        vals = [v for v in vals if v is not None]
        return sum(vals) if vals else None

    return _sum(0, last3), _sum(0, last10), _sum(1, last3)


def _load_flow_sector_inputs(con) -> dict:
    """One-shot load of what run_full_universe_today's per-row fills need.

    Returns {'fii_by_date': {iso_date: (fii_net, dii_net)},
             'sector_mom': {iso_date: {sector: (r5, r21)}}}.
    """
    fii_by_date: dict = {}
    for r in con.execute(
        "SELECT date::text AS d, fii_net, dii_net FROM fii_dii_flow ORDER BY date ASC"
    ).fetchall():
        # fii_dii_flow.date is TEXT (regime_detector.py rule #6); normalize so lookup keys
        # match the stock_ohlcv-derived grid dates exactly.
        fii_by_date[str(r['d'])[:10]] = (r['fii_net'], r['dii_net'])

    sector_mom: dict = {}
    # Same equal-weight per-sector mean technicalSignalsService.getSectorMomentum() and
    # feature_engineering._compute_sector_momentum compute: LAG over each member's own bar
    # calendar, suspect bars excluded, AVG skips NULLs so warm-up days simply drop out.
    rows = con.execute("""
        WITH daily_close AS (
            SELECT o.symbol, o.date::text AS d, n.sector, o.close AS c,
                   LAG(o.close, 5)  OVER (PARTITION BY o.symbol ORDER BY o.date) AS prev5,
                   LAG(o.close, 21) OVER (PARTITION BY o.symbol ORDER BY o.date) AS prev21
            FROM stock_ohlcv o
            JOIN nse_stocks n ON n.symbol = o.symbol AND n.sector IS NOT NULL
            WHERE COALESCE(o.is_suspect,0)=0
              AND o.date >= CURRENT_DATE - INTERVAL '75 days'
        )
        SELECT d, sector,
               AVG(100.0 * (c / NULLIF(prev5, 0)  - 1)) AS r5,
               AVG(100.0 * (c / NULLIF(prev21, 0) - 1)) AS r21
        FROM daily_close
        GROUP BY d, sector
    """).fetchall()
    for r in rows:
        if r['r5'] is None and r['r21'] is None:
            continue
        sector_mom.setdefault(str(r['d'])[:10], {})[str(r['sector'])] = (r['r5'], r['r21'])
    return {'fii_by_date': fii_by_date, 'sector_mom': sector_mom}


def run_full_universe_today(min_price: float = 15.0) -> int:
    """Grid-ensurer: guarantee a technical_signals row exists for EVERY liquid stock on
    the latest OHLCV date, with the core OHLCV-derived indicators. The signal scan only
    writes rows for stocks that produced a tradable pattern (14-800/day), so most of the
    universe had no feature row on most days — starving the ensemble/ranker of a complete
    cross-section. This fills the gap (ON CONFLICT DO NOTHING, so the scan's richer rows
    are left intact); the RS/HV/aVWAP engines then enrich the full grid.

    Also fills the five market-wide columns densify_feature_matrix can never carry
    (NEVER_FILL since 5a97df3): fii_3d_net/fii_10d_net/dii_3d_net rolled from
    fii_dii_flow's published nets, and sector_ret_5d/21d from the same equal-weight
    sector mean the scan writes — so GRID rows carry real values instead of relying on
    a forward-fill that no longer exists."""
    con = connect()
    latest = logical_write_floor(con)
    if not latest:
        print("[Grid] no OHLCV.")
        return 0
    cutoff = (datetime.fromisoformat(latest) - timedelta(days=320)).date().isoformat()

    regime_rows = con.execute(
        "SELECT date, regime FROM market_regimes ORDER BY date ASC").fetchall()
    regime = next((r['regime'] for d, r in
                   [(str(x['date'])[:10], x) for x in reversed(regime_rows)] if d <= latest),
                  'SIDEWAYS') if regime_rows else 'SIDEWAYS'

    inputs = _load_flow_sector_inputs(con)
    fii_by_date = inputs['fii_by_date']
    sector_mom = inputs['sector_mom']

    rows = con.execute(
        "SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv "
        "WHERE date >= ? AND COALESCE(is_suspect,0)=0 ORDER BY symbol, date ASC",
        (cutoff,)).fetchall()
    from collections import defaultdict
    by_symbol: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_symbol[r['symbol']].append({**dict(r), 'date': str(r['date'])[:10]})

    symbol_sector = {r['symbol']: r['sector'] for r in con.execute(
        "SELECT symbol, sector FROM nse_stocks WHERE sector IS NOT NULL").fetchall()}

    now_str = datetime.now().isoformat()
    written = 0
    filled_sector = 0
    f3_day, f10_day, d3_day = _flow_nets(fii_by_date, latest)
    for symbol, ohlcv in by_symbol.items():
        if len(ohlcv) < 22 or ohlcv[-1]['date'] != latest:
            continue  # need history + a bar for the latest session
        if (ohlcv[-1]['close'] or 0) < min_price:
            continue
        ind = compute_indicators(ohlcv)
        sec = symbol_sector.get(symbol)
        r5, r21 = (sector_mom.get(latest, {}).get(sec, (None, None))
                   if sec else (None, None))
        if r5 is not None:
            filled_sector += 1
        con.execute("""
            INSERT INTO technical_signals
                (symbol, date, signal_score, signal_type,
                 rsi, sma50, sma200, macd, macd_signal,
                 bb_width, volume_ratio, above_sma200, adx, cmp,
                 change_pct, nifty_regime, computed_at,
                 fii_3d_net, fii_10d_net, dii_3d_net,
                 sector_ret_5d, sector_ret_21d)
            VALUES (?,?,0,'GRID',?,?,?,?,?,?,?,?,?,?,?,?,?,
                    ?,?,?,
                    ?,?)
            ON CONFLICT (symbol, date) DO NOTHING
        """, (
            symbol, latest, ind['rsi'], ind['sma50'], ind['sma200'],
            ind['macd'], ind['macd_signal'], ind['bb_width'], ind['volume_ratio'],
            ind['above_sma200'], ind['adx'], ind['cmp'],
            round((ohlcv[-1]['close'] / ohlcv[-2]['close'] - 1) * 100, 2) if len(ohlcv) >= 2 and ohlcv[-2]['close'] else None,
            regime, now_str,
            f3_day, f10_day, d3_day,
            r5, r21))
        written += 1
        if written % 2000 == 0:
            con.commit()
    con.commit()
    # ── Repair pass ──────────────────────────────────────────────────────────────
    # ON CONFLICT DO NOTHING leaves pre-existing rows untouched, so a day gridded before
    # this filler existed (or by a partial run) keeps its NULLs forever. Backfill the
    # market-wide columns onto any GRID row of `latest` still missing them. Flows are
    # market-wide constants for the day; sector returns resolve per symbol.
    if f3_day is not None:
        missing = con.execute(
            "SELECT COUNT(*) AS c FROM technical_signals "
            "WHERE date=? AND signal_type='GRID' AND fii_3d_net IS NULL",
            (latest,)).fetchone()['c']
        if missing:
            con.execute(
                "UPDATE technical_signals SET fii_3d_net=?, fii_10d_net=?, dii_3d_net=? "
                "WHERE date=? AND signal_type='GRID' AND fii_3d_net IS NULL",
                (f3_day, f10_day, d3_day, latest))
            print(f"[Grid] repaired flow nets on {missing} pre-existing GRID rows")
    sec_fixes = []
    for r in con.execute(
        "SELECT symbol FROM technical_signals "
        "WHERE date=? AND signal_type='GRID' AND sector_ret_5d IS NULL",
        (latest,)).fetchall():
        s = symbol_sector.get(r['symbol'])
        vals = sector_mom.get(latest, {}).get(s) if s else None
        if vals:
            sec_fixes.append((vals[0], vals[1], r['symbol'], latest))
    if sec_fixes:
        con.executemany(
            "UPDATE technical_signals SET sector_ret_5d=?, sector_ret_21d=? "
            "WHERE symbol=? AND date=? AND signal_type='GRID' AND sector_ret_5d IS NULL",
            sec_fixes)
        print(f"[Grid] repaired sector returns on {len(sec_fixes)} rows")
    con.commit()
    total = con.execute("SELECT COUNT(*) AS c FROM technical_signals WHERE date=?", (latest,)).fetchone()['c']
    print(f"[Grid] {latest}: ensured {written} rows; technical_signals now has {total} rows for the day.")
    print(f"[Grid] flow nets: fii_3d={f3_day} fii_10d={f10_day} dii_3d={d3_day}; "
          f"sector returns filled on {filled_sector}/{written}")
    return written


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None, help='Max (symbol,date) pairs to process')
    parser.add_argument('--full-today', action='store_true',
                        help='Ensure a full-universe technical_signals grid for the latest session')
    args = parser.parse_args()
    if args.full_today:
        run_full_universe_today()
    else:
        run(limit=args.limit)
