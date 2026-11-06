"""Read-only replay: what did removing the red-flag veto from ETnow 8486 (Low Debt Stocks) and
8651 (Decreasing Quarterly Losses) change, and were the vetoed names worse than the batch?

Membership: screener_appearances episodes open on the batch date (the timestamped
screener_membership_runs capture drops most long-running memberships, AF-20261106-04). Other red
flags read from the CURRENT screener_catalog. Counterfactual score = stored x 2 (RED_FLAG_VETO_MULT 0.5).
Outcome: next-session open -> close h sessions later, excess vs the batch's rated-universe mean.
"""
import json, sys
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/server'))
from db_compat import connect
import unified_ranker as ur

TARGETS = {('etnow', '8486'), ('etnow', '8651')}
TARGET_PREFIX = ('18-low-debt-stocks', 'decreasing-quarterly-losses')


def is_target(src, sid):
    src, sid = (src or '').lower(), str(sid)
    return (src, sid) in TARGETS or sid.startswith(TARGET_PREFIX)


def tstat(a):
    a = np.asarray([x for x in a if np.isfinite(x)])
    if len(a) < 2 or a.std(ddof=1) == 0:
        return len(a), (float(a.mean()) if len(a) else None), None
    return len(a), float(a.mean()), float(a.mean() / (a.std(ddof=1) / np.sqrt(len(a))))


con = connect()
con.execute('SET TRANSACTION READ ONLY')
con.execute("SET LOCAL statement_timeout = '120s'")
try:
    red = {((r['source'] or '').lower(), str(r['screener_id'])) for r in con.execute(
        "SELECT source, screener_id FROM screener_catalog WHERE category='risk_red_flags' AND signal_bias='bearish'").fetchall()}
    batches = con.execute("""
        SELECT DISTINCT ON ((generated_at AT TIME ZONE 'Asia/Kolkata')::date)
               (generated_at AT TIME ZONE 'Asia/Kolkata')::date AS d, generated_at, regime
        FROM unified_recommendations_history WHERE generated_at >= '2026-09-01'
        ORDER BY 1, generated_at DESC""").fetchall()
    px = pd.DataFrame([dict(r) for r in con.execute(
        "SELECT symbol, date, open, close, volume FROM stock_ohlcv WHERE date >= '2026-08-01' "
        "AND COALESCE(is_suspect,0)=0 AND open>0 AND close>0").fetchall()])
    px['date'] = pd.to_datetime(px['date']).dt.date
    px = px.sort_values(['symbol', 'date'])
    px['adt_cr'] = (px.close * px.volume).groupby(px.symbol).transform(lambda x: x.rolling(20, min_periods=10).mean()) / 1e7
    sessions = sorted(px.date.unique())
    op = px.set_index(['symbol', 'date'])['open'].to_dict()
    cl = px.set_index(['symbol', 'date'])['close'].to_dict()

    out, label_moves = [], {}
    for b in batches:
        d = pd.Timestamp(b['d']).date()
        # Episodes open on d: what the live *_screener_stocks tables held, without the 3-day window.
        mem = [(r['symbol'], r['source'], r['screener_id']) for r in con.execute(
            "SELECT symbol, source, screener_id FROM screener_appearances "
            "WHERE appeared_date::date <= ? AND (exited_date IS NULL OR exited_date::date > ?)", (d, d)).fetchall()]
        src_kind = 'episodes'
        tgt, other = set(), set()
        by_sid = {'8486': set(), '8651': set()}
        for sym, src, sid in mem:
            if is_target(src, sid):
                tgt.add(sym)
                by_sid['8486' if str(sid).startswith(('8486', '18-low')) else '8651'].add(sym)
            elif ((src or '').lower(), str(sid)) in red:
                other.add(sym)
        only = tgt - other
        rows = pd.DataFrame([dict(r) for r in con.execute(
            "SELECT symbol, unified_score, classification FROM unified_recommendations_history WHERE generated_at=?",
            (b['generated_at'],)).fetchall()])
        aff = rows[rows.symbol.isin(only)].copy()
        aff['cf_class'] = [c if (c == 'Hold' and ur._classify(s, 1, 1) != 'Hold') else ur._classify(min(100.0, s * 2), 1, 1)
                           for s, c in zip(aff.unified_score, aff.classification)]  # coverage-demoted Holds stay Hold
        for a, c in zip(aff.classification, aff.cf_class):
            if a != c:
                label_moves[f'{a} -> {c}'] = label_moves.get(f'{a} -> {c}', 0) + 1
        future = [s for s in sessions if s > d]
        rec = {'date': str(d), 'regime': b['regime'], 'membership': src_kind, 'target_members': len(tgt),
               'only_target_red_flag': len(only), 'in_batch': len(aff),
               'label_changes': int((aff.classification != aff.cf_class).sum())}
        for h in (1, 5):
            if len(future) < h:
                continue
            e, x = future[0], future[h - 1]
            def ret(s):
                o, c = op.get((s, e)), cl.get((s, x))
                r = (c / o - 1) * 100 if o and c else np.nan
                return r if abs(r) <= 40 else np.nan
            rows[f'r{h}'] = rows.symbol.map(ret)
            bench = rows[f'r{h}'].mean()
            adt = px[px.date <= d].groupby('symbol').adt_cr.last()
            a = rows[rows.symbol.isin(only)]
            rec[f'excess_{h}d'] = float((a[f'r{h}'] - bench).mean()) if a[f'r{h}'].notna().any() else None
            liq = a[a.symbol.map(adt).fillna(0) >= 1]
            rec[f'excess_{h}d_adt1cr'] = float((liq[f'r{h}'] - bench).mean()) if liq[f'r{h}'].notna().any() else None
            rec[f'n_{h}d'] = int(a[f'r{h}'].notna().sum())
            hold = rows[(rows.classification == 'Hold') & ~rows.symbol.isin(only)][f'r{h}'].mean()
            rec[f'vs_hold_{h}d'] = float(a[f'r{h}'].mean() - hold) if a[f'r{h}'].notna().any() else None
            for tag, ids in (('ld', '8486'), ('dql', '8651')):
                sub = a[a.symbol.isin(by_sid[ids] & only)]
                rec[f'{tag}_{h}d'] = float((sub[f'r{h}'] - bench).mean()) if sub[f'r{h}'].notna().any() else None
        out.append(rec)
finally:
    con.rollback(); con.close()

df = pd.DataFrame(out)
print(df[['date','regime','only_target_red_flag','in_batch','label_changes']].tail(3).to_string(index=False))
print('\nlabel moves (all batches):', label_moves)
for h, step in ((1, 1), (5, 5)):
    col = f'excess_{h}d'
    s = df[col].dropna()
    print(f'{h}d excess of un-vetoed names, per-date mean: n,mean,t =', tstat(s.values),
          f'| independent ({step}-spaced):', tstat(s.values[::step]))
    print(f'{h}d ADT>=1cr:', tstat(df[col + "_adt1cr"].dropna().values))
for c in ('vs_hold_1d', 'vs_hold_5d', 'ld_1d', 'dql_1d', 'ld_5d', 'dql_5d'):
    print(c, tstat(df[c].dropna().values))
print('name-days graded 1d:', int(df.get('n_1d', pd.Series(dtype=float)).fillna(0).sum()))
for c in ('vs_hold_1d', 'excess_1d_adt1cr'):
    v = df[c].dropna().values; m = len(v) // 2
    print(c, 'first half', tstat(v[:m]), 'second half', tstat(v[m:]), 'dates negative', int((v < 0).sum()), 'of', len(v))
df.to_csv(Path(__file__).resolve().parents[1] / 'research/out/veto-removal-replay-20261106.csv', index=False)
