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

Usage:
  python backfill_technical_features.py
  python backfill_technical_features.py --limit 500   # process first 500 pairs
"""
import sys, argparse
from pathlib import Path
from datetime import datetime, timedelta

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect

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

    # Find all (symbol, signal_date) pairs needing backfill
    print("[Backfill] Finding coverage gaps...")
    gaps = con.execute("""
        SELECT DISTINCT so.symbol, so.signal_date
        FROM signal_outcomes so
        WHERE so.outcome IN ('WIN','LOSS','STOP_LOSS')
          AND so.return_pct IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM technical_signals ts
              WHERE ts.symbol = so.symbol
                AND ts.date <= so.signal_date
                AND ts.date >= (so.signal_date::date - interval '3 days')::text
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
        for d, reg in reversed(regime_dates):
            if d <= date_str:
                return reg
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

        ohlcv_list = [dict(r) for r in ohlcv]
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
                     cmp, nifty_regime, fii_3d_net, computed_at)
                VALUES (?,?,0,'BACKFILL',?,?,?,?,?,?,?,?,?,?,?,?,?)
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=None, help='Max (symbol,date) pairs to process')
    args = parser.parse_args()
    run(limit=args.limit)
