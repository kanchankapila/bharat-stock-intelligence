import os, time, psycopg2
import numpy as np
from collections import defaultdict
from dotenv import load_dotenv

load_dotenv()

# A valuation band answers "where is today's P/E within this stock's own recent history?"
# so the percentile window must CLOSE AT THE ROW BEING STAMPED. Taking one set of
# percentiles over the whole 3-year slice (the previous implementation) and stamping the
# same numbers onto the last 60 sessions is a look-ahead: a band row dated 45 days ago was
# a function of today's P/E, so any "cheap vs its own 3-year band" screen back-tested on
# this column was fitted to the future. Every row now gets the percentiles of the trailing
# 3-year window ENDING AT THAT ROW'S OWN DATE.
BAND_LOOKBACK_YEARS = 3
BAND_LOOKBACK_DAYS = BAND_LOOKBACK_YEARS * 365

# A percentile over a handful of observations is noise presented as a band; keep the
# original file's "needs real history" floor as an explicit, documented constant.
MIN_BAND_OBS = 30


def _bands_for_windows(dates, values, lookback_days: int):
    """As-of band percentiles for every row of one symbol's (date, value) series.

    Returns (b_low, b_mid_low, b_median, b_mid_high, b_high) parallel to `values`, or None
    for a row with too little history behind it. `dates` must be sorted ascending; the window
    is (row_date - lookback_days, row_date] — a row's own value is included, values after it
    never are.
    """
    n = len(values)
    lo = np.full(n, np.nan)
    m_lo = np.full(n, np.nan)
    med = np.full(n, np.nan)
    m_hi = np.full(n, np.nan)
    hi = np.full(n, np.nan)
    if n < MIN_BAND_OBS:
        return None
    start = 0
    # datetime64[ns] arithmetic: `dates[i] - lookback_days` with a plain int subtracts
    # NANOSECONDS, not days, so every window collapsed to the single row being stamped
    # and every band came back NaN (caught by the as-of regression test). A timedelta64
    # with an explicit 'D' unit is the only correct way to subtract a day count here.
    window_span = np.timedelta64(int(lookback_days), "D")
    for i in range(n):
        window_start = dates[i] - window_span
        # dates is ascending, so the earliest in-window index only ever moves forward.
        while start < i and dates[start] <= window_start:
            start += 1
        window = values[start:i + 1]
        if window.size < MIN_BAND_OBS:
            continue
        lo[i], m_lo[i], med[i], m_hi[i], hi[i] = np.percentile(window, [10, 25, 50, 75, 90])
    return lo, m_lo, med, m_hi, hi


def backfill_pe_valuation_bands(batch_size: int = 5000):
    t0 = time.time()
    conn = psycopg2.connect(os.environ.get("POSTGRES_URL"))
    cur = conn.cursor()

    print("[PE-Band-Backfill] Loading trendlyne_pe_history (last 3 years)...")
    cur.execute("""
        SELECT symbol, date, pe_ttm
        FROM trendlyne_pe_history
        WHERE date::date >= CURRENT_DATE - INTERVAL '3 years' AND pe_ttm > 0 AND pe_ttm < 500
        ORDER BY symbol, date;
    """)
    rows = cur.fetchall()
    print(f"[PE-Band-Backfill] Loaded {len(rows):,} PE records in {time.time()-t0:.2f}s")

    sym_pe_series = defaultdict(list)
    for sym, dt, pe in rows:
        if pe is not None and np.isfinite(pe):
            sym_pe_series[sym].append((dt, float(pe)))

    all_symbols = sorted(sym_pe_series.keys())
    print(f"[PE-Band-Backfill] Computing valuation bands for {len(all_symbols)} symbols...")

    insert_sql = """
        INSERT INTO investsights_pe_band_history
            (symbol, date, pe, band_low, band_mid_low, band_median, band_mid_high, band_high, source)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'trendlyne_pe_derived')
        ON CONFLICT (symbol, date) DO UPDATE SET
            pe = EXCLUDED.pe, band_low = EXCLUDED.band_low,
            band_mid_low = EXCLUDED.band_mid_low, band_median = EXCLUDED.band_median,
            band_mid_high = EXCLUDED.band_mid_high, band_high = EXCLUDED.band_high,
            source = EXCLUDED.source, fetched_at = CURRENT_TIMESTAMP;
    """

    records = []
    total_written = 0
    skipped_no_history = 0

    for idx, sym in enumerate(all_symbols, 1):
        series = sym_pe_series[sym]
        if len(series) < MIN_BAND_OBS:
            skipped_no_history += 1
            continue

        dates_ns = np.array([np.datetime64(p[0], 'ns') for p in series])
        values = np.array([p[1] for p in series])
        bands = _bands_for_windows(dates_ns, values, BAND_LOOKBACK_DAYS)
        if bands is None:
            skipped_no_history += 1
            continue
        b_lo, b_m_lo, b_med, b_m_hi, b_hi = bands

        # Backfill the last 60 trading days for charts and API. Each of those rows now
        # carries the bands as known on ITS OWN date, not as known today.
        for j in range(max(0, len(series) - 60), len(series)):
            if not np.isfinite(b_med[j]):
                continue
            records.append((
                sym, str(series[j][0]), float(values[j]),
                round(float(b_lo[j]), 2), round(float(b_m_lo[j]), 2), round(float(b_med[j]), 2),
                round(float(b_m_hi[j]), 2), round(float(b_hi[j]), 2),
            ))

        if len(records) >= batch_size:
            cur.executemany(insert_sql, records)
            conn.commit()
            total_written += len(records)
            records = []
            print(f"  [{idx}/{len(all_symbols)}] symbols — {total_written:,} band-rows written")

    if records:
        cur.executemany(insert_sql, records)
        conn.commit()
        total_written += len(records)

    print(f"\n[PE-Band-Backfill] Complete: {total_written:,} valuation band rows across "
          f"{len(all_symbols)} symbols in {time.time()-t0:.2f}s "
          f"({skipped_no_history} symbols skipped: fewer than {MIN_BAND_OBS} observations)")
    cur.close()
    conn.close()
    return total_written

if __name__ == '__main__':
    backfill_pe_valuation_bands()
