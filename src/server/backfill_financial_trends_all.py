import os, re, time, psycopg2
from datetime import date
from collections import defaultdict
from dotenv import load_dotenv

load_dotenv()

def parse_period_label(lbl: str) -> date | None:
    if not lbl: return None
    m = re.match(r'^(mar|jun|sep|dec)(\d{2})$', lbl.lower().strip())
    if not m: return None
    mo_str, yr_str = m.groups()
    months = {'mar': (3, 31), 'jun': (6, 30), 'sep': (9, 30), 'dec': (12, 31)}
    mo, day = months[mo_str]
    return date(2000 + int(yr_str), mo, day)

def fiscal_label(dt: date) -> str:
    if dt.month == 3: return f"Q4 FY{str(dt.year)[-2:]}"
    elif dt.month == 6: return f"Q1 FY{str(dt.year + 1)[-2:]}"
    elif dt.month == 9: return f"Q2 FY{str(dt.year + 1)[-2:]}"
    elif dt.month == 12: return f"Q3 FY{str(dt.year + 1)[-2:]}"
    return f"{dt.year}-M{dt.month}"
def run_full_backfill(batch_size: int = 5000) -> int:
    t0 = time.time()
    conn = psycopg2.connect(os.environ.get('POSTGRES_URL'))
    cur = conn.cursor()

    print("[FinancialTrendsBackfill] Loading raw line items...")
    cur.execute("SELECT symbol, statement, period_label, line_item, value FROM marketsmojo_financials_history ORDER BY symbol, period_label;")
    raw_rows = cur.fetchall()
    print(f"[FinancialTrendsBackfill] Loaded {len(raw_rows):,} items in {time.time()-t0:.2f}s")

    sym_stmt_data = defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))
    for sym, stmt, plbl, item, val in raw_rows:
        sym = (sym or "").strip().upper()
        if not sym: continue
        dt = parse_period_label(plbl)
        if not dt: continue
        stmt = (stmt or "standalone").strip().lower()
        if val is not None:
            sym_stmt_data[sym][stmt][dt][item] = float(val)

    all_symbols = sorted(sym_stmt_data.keys())
    print(f"[FinancialTrendsBackfill] Processing {len(all_symbols)} symbols...")

    insert_sql = """
        INSERT INTO dalalos_financial_trends_history
            (symbol, period_end, period_type, fiscal_label, statement_type,
             revenue, net_income, eps, ebitda_margin, net_margin,
             net_margin_delta, qoq_revenue_growth, qoq_net_income_growth,
             yoy_revenue_growth, source)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (symbol, period_end, period_type) DO UPDATE SET
            fiscal_label = EXCLUDED.fiscal_label, statement_type = EXCLUDED.statement_type,
            revenue = EXCLUDED.revenue, net_income = EXCLUDED.net_income,
            eps = EXCLUDED.eps, ebitda_margin = EXCLUDED.ebitda_margin,
            net_margin = EXCLUDED.net_margin, net_margin_delta = EXCLUDED.net_margin_delta,
            qoq_revenue_growth = EXCLUDED.qoq_revenue_growth,
            qoq_net_income_growth = EXCLUDED.qoq_net_income_growth,
            yoy_revenue_growth = EXCLUDED.yoy_revenue_growth,
            source = EXCLUDED.source, fetched_at = CURRENT_TIMESTAMP;
    """

    records, total_written = [], 0
    for idx, sym in enumerate(all_symbols, 1):
        stmts = sym_stmt_data[sym]
        pref = "consolidate" if "consolidate" in stmts and len(stmts["consolidate"]) >= 4 else "standalone"
        if pref not in stmts or not stmts[pref]: pref = list(stmts.keys())[0]

        quarters = stmts[pref]
        sorted_dates = sorted(quarters.keys())

        for i, dt in enumerate(sorted_dates):
            it = quarters[dt]
            rev = it.get('Total Operating income') or it.get('Net Sales')
            pat = it.get('Profit After Tax') or it.get('Net Profit')
            eps = it.get('Earnings per share (EPS)')
            opm = it.get('Operating Profit Margin (Excl OI)') or it.get('Gross Profit Margin')
            if opm is not None: opm = opm / 100.0
            patm = it.get('PAT Margin')
            if patm is not None: patm = patm / 100.0
            elif rev and pat and rev > 0: patm = pat / rev

            qoq_rev, qoq_pat, m_delta = None, None, None
            if i > 0:
                p_dt = sorted_dates[i - 1]
                if (dt.year - p_dt.year) * 12 + (dt.month - p_dt.month) == 3:
                    p_it = quarters[p_dt]
                    p_rev = p_it.get('Total Operating income') or p_it.get('Net Sales')
                    p_pat = p_it.get('Profit After Tax') or p_it.get('Net Profit')
                    p_patm = p_it.get('PAT Margin')
                    if p_patm is not None: p_patm = p_patm / 100.0
                    elif p_rev and p_pat and p_rev > 0: p_patm = p_pat / p_rev
                    if p_rev and p_rev > 0 and rev: qoq_rev = (rev - p_rev) / p_rev
                    if p_pat and p_pat != 0 and pat is not None: qoq_pat = (pat - p_pat) / abs(p_pat)
                    if patm is not None and p_patm is not None: m_delta = patm - p_patm

            yoy_rev = None
            if i >= 4:
                py_dt = sorted_dates[i - 4]
                if (dt.year - py_dt.year) * 12 + (dt.month - py_dt.month) == 12:
                    py_it = quarters[py_dt]
                    py_rev = py_it.get('Total Operating income') or py_it.get('Net Sales')
                    if py_rev and py_rev > 0 and rev: yoy_rev = (rev - py_rev) / py_rev

            records.append((
                sym, dt, "quarterly", fiscal_label(dt), pref,
                rev * 1e7 if rev else None, pat * 1e7 if pat else None,
                eps, opm, patm, m_delta, qoq_rev, qoq_pat, yoy_rev,
                "marketsmojo_financials"
            ))

        if len(records) >= batch_size:
            cur.executemany(insert_sql, records)
            conn.commit()
            total_written += len(records)
            records = []
            print(f"  [{idx}/{len(all_symbols)}] symbols — {total_written:,} rows written")

    if records:
        cur.executemany(insert_sql, records)
        conn.commit()
        total_written += len(records)

    print(f"\n[FinancialTrendsBackfill] Complete: {total_written:,} quarter-rows across {len(all_symbols)} symbols in {time.time()-t0:.2f}s")
    cur.close()
    conn.close()
    return total_written

if __name__ == '__main__':
    run_full_backfill()

