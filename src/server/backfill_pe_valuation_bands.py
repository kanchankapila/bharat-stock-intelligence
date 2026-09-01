import os, time, psycopg2
import numpy as np
from collections import defaultdict
from dotenv import load_dotenv

load_dotenv()

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

    for idx, sym in enumerate(all_symbols, 1):
        series = sym_pe_series[sym]
        if len(series) < 30:
            continue
        
        all_pe_vals = np.array([p[1] for p in series])
        b_low = float(np.percentile(all_pe_vals, 10))
        b_mid_low = float(np.percentile(all_pe_vals, 25))
        b_median = float(np.percentile(all_pe_vals, 50))
        b_mid_high = float(np.percentile(all_pe_vals, 75))
        b_high = float(np.percentile(all_pe_vals, 90))

        # Backfill the last 60 trading days for charts and API
        for dt, pe_val in series[-60:]:
            records.append((
                sym, str(dt), pe_val,
                round(b_low, 2), round(b_mid_low, 2), round(b_median, 2),
                round(b_mid_high, 2), round(b_high, 2)
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

    print(f"\n[PE-Band-Backfill] Complete: {total_written:,} valuation band rows across {len(all_symbols)} symbols in {time.time()-t0:.2f}s")
    cur.close()
    conn.close()
    return total_written

if __name__ == '__main__':
    backfill_pe_valuation_bands()
